package config

import (
	"strings"
	"testing"

	"github.com/17xande-dev/env/envtest"
)

// Every key load reads must be documented, and every documented key read.
func TestEnvironmentDocumentation(t *testing.T) {
	recorder := envtest.NewRecorder(nil)
	if _, err := load(recorder.Lookup); err != nil {
		t.Fatalf("load with default configuration: %v", err)
	}
	keys := recorder.Keys()
	envtest.Documented(t, ".env.example", keys, envtest.EnvExample(t, "../../.env.example"))
	envtest.Documented(t, "README.md", keys, envtest.MarkdownTable(t, "../../README.md", "### Configuration"))
}

func TestBooleanSettings(t *testing.T) {
	for _, key := range []string{"HSTS", "COOKIE_SECURE"} {
		t.Run(key, func(t *testing.T) {
			for _, tc := range []struct {
				value string
				want  bool
			}{{"", key == "COOKIE_SECURE"}, {"true", true}, {"false", false}} {
				t.Run("accepts_"+tc.value, func(t *testing.T) {
					cfg, err := load(envtest.NewRecorder(map[string]string{key: tc.value}).Lookup)
					got := cfg.HSTS
					if key == "COOKIE_SECURE" {
						got = cfg.CookieSecure
					}
					if err != nil || got != tc.want {
						t.Fatalf("%s=%q parsed as %t with error %v; want %t without an error", key, tc.value, got, err, tc.want)
					}
				})
			}
			for _, value := range []string{"1", "0", "TRUE", "False", " true", "false ", "ture"} {
				t.Run("rejects_"+value, func(t *testing.T) {
					_, err := load(envtest.NewRecorder(map[string]string{key: value}).Lookup)
					if err == nil || !strings.Contains(err.Error(), key+`: must be "true" or "false"`) {
						t.Fatalf("want a strict %s error, got %v", key, err)
					}
				})
			}
		})
	}
}

// No value an operator typed comes back in the error, and all problems are
// reported together.
func TestConfigurationErrorsDoNotEchoValues(t *testing.T) {
	values := map[string]string{
		"HSTS":             "fixture-hsts",
		"COOKIE_SECURE":    "fixture-cookie",
		"BASE_URL":         "https://u:fixture-origin-credential@example.com",
		"SESSION_IDLE":     "fixture-session",
		"SHUTDOWN_TIMEOUT": "fixture-shutdown",
		"CLIENT_IP_HEADER": "fixture- header",
	}
	_, err := load(envtest.NewRecorder(values).Lookup)
	if err == nil {
		t.Fatal("want configuration errors")
	}
	for key := range values {
		if !strings.Contains(err.Error(), key+":") {
			t.Errorf("missing problem for %s", key)
		}
	}
	if strings.Contains(err.Error(), "fixture-") {
		t.Fatal("configuration error disclosed an input value")
	}
}
