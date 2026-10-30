package middleware

import (
	"fmt"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLimiterBurstThenRefill(t *testing.T) {
	l := NewLimiter(3, time.Minute)
	now := time.Unix(0, 0)
	l.now = func() time.Time { return now }
	for i := range 3 {
		if !l.Allow("a") {
			t.Fatalf("attempt %d refused inside the burst", i+1)
		}
	}
	if l.Allow("a") {
		t.Fatal("fourth attempt allowed")
	}
	// Buckets are per key: one person's lockout is not another's.
	if !l.Allow("b") {
		t.Fatal("other key refused")
	}
	now = now.Add(time.Minute)
	if !l.Allow("a") {
		t.Fatal("no refill after the interval")
	}
}

// A stream of distinct keys (a spray of made-up emails) must not grow the
// map for ever.
func TestLimiterSweepsIdleBuckets(t *testing.T) {
	l := NewLimiter(2, time.Second)
	now := time.Unix(0, 0)
	l.now = func() time.Time { return now }
	for i := range 1000 {
		l.Allow(fmt.Sprint(i))
	}
	now = now.Add(time.Hour)
	l.Allow("x")
	if n := len(l.buckets); n != 1 {
		t.Errorf("%d buckets after sweep, want 1", n)
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.1:5555"
	r.Header.Set("CF-Connecting-IP", "203.0.113.9")
	if got := ClientIP("")(r); got != "10.0.0.1" {
		t.Errorf("no header configured: %s", got)
	}
	if got := ClientIP("CF-Connecting-IP")(r); got != "203.0.113.9" {
		t.Errorf("header configured: %s", got)
	}
	r.Header.Set("X-Forwarded-For", "198.51.100.2, 10.0.0.7")
	// The client controls the front of X-Forwarded-For; only the entry our own
	// proxy appended, the rightmost, can be believed.
	if got := ClientIP("X-Forwarded-For")(r); got != "10.0.0.7" {
		t.Errorf("rightmost of a list: %s", got)
	}
	r.Header.Add("X-Forwarded-For", "192.0.2.77")
	if got := ClientIP("x-forwarded-for")(r); got != "192.0.2.77" {
		t.Errorf("rightmost across header lines: %s", got)
	}
	// Garbage in the header falls back to the connection, rather than
	// letting any string become its own bucket.
	r.Header.Set("CF-Connecting-IP", "not-an-ip")
	if got := ClientIP("CF-Connecting-IP")(r); got != "10.0.0.1" {
		t.Errorf("bad header value: %s", got)
	}
}

// One IPv6 subscriber can pick addresses freely within their /64, so each
// address must not be its own bucket.
func TestIPKey(t *testing.T) {
	a := IPKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
	b := IPKey("2001:db8:1:2:1111:2222:3333:4444")
	if a != b {
		t.Errorf("same /64, different keys: %s %s", a, b)
	}
	if c := IPKey("2001:db8:1:3::1"); c == a {
		t.Error("different /64s share a key")
	}
	if IPKey("203.0.113.9") != "203.0.113.9" || IPKey("::ffff:203.0.113.9") != "203.0.113.9" {
		t.Error("IPv4 keys changed")
	}
	// A zone is not part of the client: fe80::1%eth0 and %eth1 are one bucket.
	if IPKey("fe80::1%eth0") != IPKey("fe80::1%eth1") || IPKey("fe80::1%eth0") != IPKey("fe80::2") {
		t.Error("a zoned address is keyed apart from its /64")
	}
	if IPKey("garbage") != "garbage" {
		t.Error("unparsable address not passed through")
	}
}

// A proxy that writes "ip:port" or "[v6]:port" still names a client.
func TestClientIPHeaderWithPort(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.1:5555"
	for header, want := range map[string]string{
		"203.0.113.9:4711":   "203.0.113.9",
		"[2001:db8::1]:4711": "2001:db8::1",
		"[2001:db8::1]":      "2001:db8::1",
		"2001:db8::1":        "2001:db8::1",
		"203.0.113.9":        "203.0.113.9",
		"not-an-ip:80":       "10.0.0.1",
		"":                   "10.0.0.1",
	} {
		r.Header.Set("CF-Connecting-IP", header)
		if got := ClientIP("CF-Connecting-IP")(r); got != want {
			t.Errorf("header %q: %s, want %s", header, got, want)
		}
	}
	r.Header.Set("X-Forwarded-For", "198.51.100.2, 192.0.2.7:9000")
	if got := ClientIP("X-Forwarded-For")(r); got != "192.0.2.7" {
		t.Errorf("rightmost with a port: %s", got)
	}
}

// Past the cap a new key is refused (failing closed), keys already held keep
// their allowance, and the cap heals once buckets go idle.
func TestLimiterCapFailsClosed(t *testing.T) {
	l := NewLimiter(2, time.Minute)
	l.max = 5
	now := time.Unix(0, 0)
	l.now = func() time.Time { return now }
	for i := range 5 {
		if !l.Allow(fmt.Sprint(i)) {
			t.Fatalf("key %d refused below the cap", i)
		}
	}
	if l.Allow("new") {
		t.Fatal("a new key was allowed at the cap")
	}
	if l.Len() != 5 {
		t.Fatalf("%d buckets, want the cap of 5", l.Len())
	}
	if !l.Allow("0") {
		t.Fatal("a held key was refused at the cap")
	}
	// Buckets still live capSweepEvery later: the capped sweep frees nothing.
	now = now.Add(capSweepEvery)
	if l.Allow("new") {
		t.Fatal("a new key was allowed while every bucket is live")
	}
	// Idle past the refill time, the sweep makes room.
	now = now.Add(time.Hour)
	if !l.Allow("new") {
		t.Fatal("the cap did not heal after the buckets went idle")
	}
}

// Each sweep scans the whole map under the lock, so a flood of newcomers must
// not trigger one apiece.
func TestLimiterCapSweepIsRateLimited(t *testing.T) {
	l := NewLimiter(1, 10*time.Second) // buckets idle out after 10s
	l.max = 2
	now := time.Unix(100, 0)
	l.now = func() time.Time { return now }
	l.Allow("a")
	l.Allow("b")

	now = time.Unix(108, 0)
	if l.Allow("new") { // cap-time sweep: nothing idle yet
		t.Fatal("admitted while full")
	}
	// Both buckets went idle at 110, but the last cap-time sweep was 3s ago, so
	// the newcomer is refused without a scan and nothing is reclaimed.
	now = time.Unix(111, 0)
	if l.Allow("new") {
		t.Error("a refused newcomer triggered a second sweep inside capSweepEvery")
	}
	if l.Len() != 2 {
		t.Errorf("%d buckets, want 2 (no rescan yet)", l.Len())
	}
	// Once the interval has passed the sweep runs and the cap heals.
	now = time.Unix(108, 0).Add(capSweepEvery + time.Second)
	if !l.Allow("new") {
		t.Error("the cap did not heal once capSweepEvery had passed")
	}
}
