package middleware

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// maxBuckets is the most buckets one limiter holds. The lazy sweep runs once
// per idle period, so a spray of distinct keys (a fresh email per request) can
// leave a bucket each for that long; the cap is what makes the map's size a
// bound rather than a hope.
const maxBuckets = 10_000

// capSweepEvery is the least time between sweeps triggered by hitting the
// cap. A sweep scans every bucket under the lock, and at the cap every refused
// newcomer would otherwise run one, turning a flood's request rate into the
// lock's busy time. The cap still heals as buckets go idle.
const capSweepEvery = 5 * time.Second

// Limiter is a token bucket per key (an email, an IP, a user id). Buckets
// idle for longer than it takes to refill are dropped by a lazy sweep, and the
// map holds at most maxBuckets: once it is full of live keys a new key is
// refused (failing open would let a flood of fresh keys switch the limiter
// off), while keys already held are unaffected.
type Limiter struct {
	mu        sync.Mutex
	max       int // zero means maxBuckets; a field so a test can lower it
	capSwept  time.Time
	every     rate.Limit
	burst     int
	idle      time.Duration
	buckets   map[string]*bucket
	lastSweep time.Time
	now       func() time.Time
}

type bucket struct {
	lim  *rate.Limiter
	seen time.Time
}

// Len is how many buckets are held, for tests.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// Keys lists the held bucket keys, for tests.
func (l *Limiter) Keys() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	keys := make([]string, 0, len(l.buckets))
	for k := range l.buckets {
		keys = append(keys, k)
	}
	return keys
}

// NewLimiter allows burst events at once, then one per interval.
func NewLimiter(burst int, interval time.Duration) *Limiter {
	return &Limiter{
		every:   rate.Every(interval),
		burst:   burst,
		idle:    time.Duration(burst) * interval,
		buckets: map[string]*bucket{},
		now:     time.Now,
	}
}

// Allow spends one token from key's bucket, reporting false when it is empty
// or when key is new and the limiter is full.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.lastSweep) > l.idle {
		l.sweep(now)
	}
	b, ok := l.buckets[key]
	if !ok {
		limit := l.max
		if limit <= 0 {
			limit = maxBuckets
		}
		if len(l.buckets) >= limit && (l.capSwept.IsZero() || now.Sub(l.capSwept) >= capSweepEvery) {
			l.sweep(now)
			l.capSwept = now
		}
		if len(l.buckets) >= limit {
			return false
		}
		b = &bucket{lim: rate.NewLimiter(l.every, l.burst)}
		l.buckets[key] = b
	}
	b.seen = now
	return b.lim.AllowN(now, 1)
}

// sweep drops buckets idle for longer than it takes to refill. Callers hold mu.
func (l *Limiter) sweep(now time.Time) {
	for k, b := range l.buckets {
		if now.Sub(b.seen) > l.idle {
			delete(l.buckets, k)
		}
	}
	l.lastSweep = now
}

// ClientIP returns the visitor's address: from header when the deployment
// names one (a proxy such as Cloudflare sets it), else the connection's.
//
// A single-value header the proxy overwrites (CF-Connecting-IP, X-Real-IP) is
// the safe choice. X-Forwarded-For is a list every hop appends to, and the
// client may have put anything at its front, so for that header only the
// rightmost entry (the one our own proxy added) is trusted. Any other header
// is read whole.
func ClientIP(header string) func(*http.Request) string {
	header = http.CanonicalHeaderKey(header)
	return func(r *http.Request) string {
		if header != "" {
			if v := r.Header.Values(header); len(v) > 0 {
				last := v[len(v)-1]
				if header == "X-Forwarded-For" {
					if i := strings.LastIndexByte(last, ','); i >= 0 {
						last = last[i+1:]
					}
				}
				if ip := net.ParseIP(bareIP(last)); ip != nil {
					return ip.String()
				}
			}
		}
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			return r.RemoteAddr
		}
		return host
	}
}

// bareIP reduces a header value to the address alone. Some load balancers
// write "ip:port" or "[v6]:port"; left whole, that is not an address, so it
// would fall back to the connection's and every client behind the proxy would
// share one bucket. A value that is neither an address nor host:port is
// returned unchanged.
func bareIP(s string) string {
	s = strings.TrimSpace(s)
	if _, err := netip.ParseAddr(unbracket(s)); err == nil {
		return unbracket(s)
	}
	if host, _, err := net.SplitHostPort(s); err == nil {
		return host
	}
	return s
}

// unbracket strips the brackets an IPv6 address may arrive wrapped in.
func unbracket(ip string) string {
	return strings.TrimSuffix(strings.TrimPrefix(ip, "["), "]")
}

// IPKey is the key a per-IP limiter should use for ip: an IPv6 client owns a
// whole /64 (any one subscriber can pick addresses freely within it), so the
// /64 is one bucket; an IPv4 address is its own.
func IPKey(ip string) string {
	a := net.ParseIP(ip)
	if a == nil {
		return ip
	}
	if a4 := a.To4(); a4 != nil {
		return a4.String()
	}
	return a.Mask(net.CIDRMask(64, 128)).String() + "/64"
}
