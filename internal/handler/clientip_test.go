package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"calligraphy/internal/config"
	"calligraphy/internal/fonts"
)

// serverFor builds a server whose client-IP policy comes from the real
// config path (CLIENT_IP_HEADER), so the wiring env -> Source -> limiter is
// what is tested.
func serverFor(t *testing.T, header string) *testServer {
	t.Helper()
	cfg, err := config.Load(func(k string) string {
		if k == "CLIENT_IP_HEADER" {
			return header
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	o, d := testOptionsDB(t, fonts.Builtin)
	o.ClientIP = cfg.ClientIP
	srv, err := newServer(o)
	if err != nil {
		t.Fatal(err)
	}
	return &testServer{srv: srv, accounts: o.Accounts, routes: srv.Routes(), db: d}
}

func (s *testServer) loginFrom(t *testing.T, peer string, hdr map[string]string, email string) int {
	t.Helper()
	r := httptest.NewRequest("POST", "/account/login", strings.NewReader(url.Values{
		"email": {email}, "password": {"wrong password!!"},
	}.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.RemoteAddr = peer
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.routes.ServeHTTP(rec, r)
	return rec.Code
}

// exhaust spends the per-IP burst (10) from one source and returns the status
// of the 11th attempt, each with a fresh email so only the IP limit can bite.
func (s *testServer) exhaust(t *testing.T, peer string, hdr func(i int) map[string]string) int {
	t.Helper()
	var code int
	for i := range 11 {
		code = s.loginFrom(t, peer, hdr(i), "u"+string(rune('a'+i))+"@x.com")
	}
	return code
}

func TestClientIPHeaderDrivesTheIPLimit(t *testing.T) {
	cf := func(ip string) func(int) map[string]string {
		return func(int) map[string]string { return map[string]string{"CF-Connecting-IP": ip} }
	}
	t.Run("zero source ignores the header: a spoofed header cannot dodge the limit", func(t *testing.T) {
		s := serverFor(t, "")
		code := s.exhaust(t, "198.51.100.1:1000", func(i int) map[string]string {
			return map[string]string{"CF-Connecting-IP": "203.0.113." + string(rune('1'+i))}
		})
		if code != http.StatusTooManyRequests {
			t.Fatalf("11th attempt from one peer with rotating spoofed headers: %d, want 429", code)
		}
	})
	t.Run("configured header: clients behind one proxy peer get their own buckets", func(t *testing.T) {
		s := serverFor(t, "CF-Connecting-IP")
		// One client exhausts its own bucket...
		if code := s.exhaust(t, "198.51.100.1:1000", cf("203.0.113.9")); code != http.StatusTooManyRequests {
			t.Fatalf("11th attempt from one client: %d, want 429", code)
		}
		// ...another client through the same peer is unaffected.
		if code := s.loginFrom(t, "198.51.100.1:1000", map[string]string{"CF-Connecting-IP": "203.0.113.10"}, "z@x.com"); code == http.StatusTooManyRequests {
			t.Fatal("a different client behind the same proxy was limited")
		}
	})
	t.Run("malformed header falls back to the peer", func(t *testing.T) {
		s := serverFor(t, "CF-Connecting-IP")
		code := s.exhaust(t, "198.51.100.1:1000", func(i int) map[string]string {
			return map[string]string{"CF-Connecting-IP": "junk" + string(rune('a'+i))}
		})
		if code != http.StatusTooManyRequests {
			t.Fatalf("junk header values got their own buckets: %d", code)
		}
	})
}
