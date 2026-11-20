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
}

func TestLoadOverrides(t *testing.T) {
	c, err := Load(env(map[string]string{
		"ADDR": ":9000", "HSTS": "1", "SHUTDOWN_TIMEOUT": "3s",
		"DB_PATH": "/data/x.db", "CLIENT_IP_HEADER": "CF-Connecting-IP",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":9000" || !c.HSTS || c.ShutdownTimeout != 3*time.Second ||
		c.DBPath != "/data/x.db" || c.ClientIPHeader != "CF-Connecting-IP" {
		t.Errorf("overrides not applied: %+v", c)
	}
}

// Every bad value is reported together, so an operator fixes a deployment in
// one pass rather than one restart per mistake.
func TestLoadReportsAllErrors(t *testing.T) {
	_, err := Load(env(map[string]string{"HSTS": "yes", "SHUTDOWN_TIMEOUT": "-1s"}))
	if err == nil {
		t.Fatal("want error")
	}
	for _, want := range []string{"HSTS", "SHUTDOWN_TIMEOUT"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
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
