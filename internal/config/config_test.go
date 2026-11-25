package config

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":8080" || c.HSTS || c.ShutdownTimeout != 10*time.Second || c.DBPath != "" || c.ClientIPHeader != "" {
		t.Errorf("unexpected defaults: %+v", c)
	}
	if !c.CookieSecure || c.BaseURL != "" {
		t.Errorf("default cookie should be Secure and BASE_URL should be optional")
	}
}

func TestLoadOverrides(t *testing.T) {
	c, err := Load(env(map[string]string{
		"ADDR": ":9000", "HSTS": "1", "SHUTDOWN_TIMEOUT": "3s",
		"DB_PATH": "/data/x.db", "CLIENT_IP_HEADER": "CF-Connecting-IP",
		"COOKIE_SECURE": "0", "BASE_URL": "http://localhost:9000",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":9000" || !c.HSTS || c.ShutdownTimeout != 3*time.Second ||
		c.DBPath != "/data/x.db" || c.ClientIPHeader != "CF-Connecting-IP" ||
		c.CookieSecure || c.BaseURL != "http://localhost:9000" {
		t.Errorf("overrides not applied: %+v", c)
	}
}

func TestLoadSessionLifetimes(t *testing.T) {
	const day = 24 * time.Hour
	policies := []struct {
		name string
		env  map[string]string
		want [4]time.Duration
	}{
		{"defaults", nil, [4]time.Duration{30 * day, 90 * day, 90 * day, 365 * day}},
		{"independent overrides", map[string]string{
			"SESSION_IDLE": "1h30m", "SESSION_ABSOLUTE": "8h",
			"DEVICE_SESSION_IDLE": "240h", "DEVICE_SESSION_ABSOLUTE": "480h",
		}, [4]time.Duration{90 * time.Minute, 8 * time.Hour, 10 * day, 20 * day}},
	}
	for _, tc := range policies {
		t.Run(tc.name, func(t *testing.T) {
			c, err := Load(env(tc.env))
			if err != nil {
				t.Fatal(err)
			}
			web, device := c.Lifetimes.Web, c.Lifetimes.Device
			if got := [4]time.Duration{web.Idle, web.Absolute, device.Idle, device.Absolute}; got != tc.want || web.IdleOff || device.IdleOff {
				t.Fatalf("lifetimes = %+v, want %v and neither idle limit off", c.Lifetimes, tc.want)
			}
		})
	}
	for _, tc := range []struct{ name, key, value string }{
		{"zero", "SESSION_IDLE", "0s"},
		{"negative", "SESSION_ABSOLUTE", "-1h"},
		{"whitespace", "DEVICE_SESSION_IDLE", " 24h"},
		{"bare number", "DEVICE_SESSION_ABSOLUTE", "365"},
		{"day unit", "SESSION_IDLE", "30d"},
		{"subsecond", "DEVICE_SESSION_IDLE", "1.5s"},
		{"overflow", "DEVICE_SESSION_ABSOLUTE", "999999999999h"},
		{"web idle exceeds absolute", "SESSION_IDLE", "3000h"},
		{"device absolute below idle", "DEVICE_SESSION_ABSOLUTE", "24h"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(env(map[string]string{tc.key: tc.value}))
			if err == nil || !strings.Contains(err.Error(), tc.key) {
				t.Fatalf("want an error naming %s, got %v", tc.key, err)
			}
		})
	}
}

// Every bad value is reported together, so an operator fixes a deployment in
// one pass rather than one restart per mistake.
func TestLoadReportsAllErrors(t *testing.T) {
	_, err := Load(env(map[string]string{
		"HSTS": "yes", "SHUTDOWN_TIMEOUT": "-1s", "COOKIE_SECURE": "auto", "BASE_URL": "not an origin",
	}))
	if err == nil {
		t.Fatal("want error")
	}
	for _, want := range []string{"HSTS", "SHUTDOWN_TIMEOUT", "COOKIE_SECURE", "BASE_URL"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}

func TestLoadCookieSecure(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  bool
	}{
		{"1", true}, {"true", true}, {"0", false}, {"false", false},
	} {
		t.Run(tc.input, func(t *testing.T) {
			c, err := Load(env(map[string]string{"COOKIE_SECURE": tc.input}))
			if err != nil || c.CookieSecure != tc.want {
				t.Fatalf("Secure = %t, err = %v, want %t", c.CookieSecure, err, tc.want)
			}
		})
	}
	for _, input := range []string{"auto", "TRUE", " 1", "yes"} {
		t.Run("refuses "+input, func(t *testing.T) {
			_, err := Load(env(map[string]string{"COOKIE_SECURE": input}))
			if err == nil || !strings.Contains(err.Error(), "COOKIE_SECURE: want 1/0/true/false") {
				t.Fatalf("want a strict COOKIE_SECURE error, got %v", err)
			}
		})
	}
}

func TestLoadBaseURL(t *testing.T) {
	for _, tc := range []struct {
		origin, secure string
		ok             bool
	}{
		{"https://app.example", "true", true},
		{"http://localhost:8083", "false", true},
		{"http://localhost:8083", "true", false},
		{"app.example", "false", false},
		{"https://App.example", "true", false},
		{"https://app.example/", "true", false},
		{"https://app.example:443", "true", false},
	} {
		t.Run(tc.origin+" secure="+tc.secure, func(t *testing.T) {
			c, err := Load(env(map[string]string{"BASE_URL": tc.origin, "COOKIE_SECURE": tc.secure}))
			if tc.ok {
				if err != nil || c.BaseURL != tc.origin {
					t.Fatalf("BASE_URL = %q, err = %v", c.BaseURL, err)
				}
			} else if err == nil || !strings.Contains(err.Error(), "BASE_URL") {
				t.Fatalf("want a BASE_URL error, got %v", err)
			}
		})
	}
}

// CLIENT_IP_HEADER becomes a policy: unset is the peer, a configured header is
// trusted, anything else (an invalid header name) fails at startup.
func TestLoadClientIPSource(t *testing.T) {
	req := func(peer string, hdr map[string]string) *http.Request {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = peer
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		return r
	}
	spoof := map[string]string{"CF-Connecting-IP": "203.0.113.9", "X-Forwarded-For": "203.0.113.8"}

	c, err := Load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if got := c.ClientIP.Addr(req("10.0.0.1:5", spoof)).String(); got != "10.0.0.1" {
		t.Errorf("unset: %s, want the peer", got)
	}

	c, err = Load(env(map[string]string{"CLIENT_IP_HEADER": "cf-connecting-ip"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := c.ClientIP.Addr(req("10.0.0.1:5", spoof)).String(); got != "203.0.113.9" {
		t.Errorf("configured: %s, want the header", got)
	}
	if got := c.ClientIP.Addr(req("10.0.0.1:5", map[string]string{"X-Forwarded-For": "203.0.113.8"})).String(); got != "10.0.0.1" {
		t.Errorf("other headers must not count: %s", got)
	}
	if got := c.ClientIP.Addr(req("10.0.0.1:5", map[string]string{"CF-Connecting-IP": "junk"})).String(); got != "10.0.0.1" {
		t.Errorf("junk header: %s, want the peer", got)
	}

	if _, err := Load(env(map[string]string{"CLIENT_IP_HEADER": "Bad Header"})); err == nil || !strings.Contains(err.Error(), "CLIENT_IP_HEADER") {
		t.Errorf("invalid header name accepted: %v", err)
	}
}
