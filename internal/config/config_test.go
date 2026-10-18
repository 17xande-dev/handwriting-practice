package config

import (
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
