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
	if IPKey("garbage") != "garbage" {
		t.Error("unparsable address not passed through")
	}
}
