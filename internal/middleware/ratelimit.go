package middleware

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter is a token bucket per key (an email, an IP, a user id). Buckets
// idle for longer than it takes to refill are dropped by a lazy sweep, so
// the map cannot grow without bound under a spray of distinct keys.
type Limiter struct {
	mu        sync.Mutex
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

// Allow spends one token from key's bucket, reporting false when it is empty.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.lastSweep) > l.idle {
		for k, b := range l.buckets {
			if now.Sub(b.seen) > l.idle {
				delete(l.buckets, k)
			}
		}
		l.lastSweep = now
	}
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{lim: rate.NewLimiter(l.every, l.burst)}
		l.buckets[key] = b
	}
	b.seen = now
	return b.lim.AllowN(now, 1)
}

// ClientIP returns the visitor's address: from header when the deployment
// names one (a proxy such as Cloudflare sets it), else the connection's.
// With a header configured, only the first address counts — later ones were
// appended by proxies, the first is what the client presented.
func ClientIP(header string) func(*http.Request) string {
	return func(r *http.Request) string {
		if header != "" {
			if v := r.Header.Get(header); v != "" {
				first, _, _ := strings.Cut(v, ",")
				if ip := net.ParseIP(strings.TrimSpace(first)); ip != nil {
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
