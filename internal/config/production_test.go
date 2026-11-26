package config

import (
	"maps"
	"testing"

	"github.com/17xande-dev/env/envtest"
)

func TestProductionValues(t *testing.T) {
	// Keep these literals in sync with config/deploy.yml and the defaults
	// for the environment passed by the two Compose files.
	compose := map[string]string{
		"ADDR":                    ":8080",
		"DB_PATH":                 "/data/handwriting.db",
		"HSTS":                    "false",
		"COOKIE_SECURE":           "true",
		"BASE_URL":                "",
		"SESSION_IDLE":            "720h",
		"SESSION_ABSOLUTE":        "2160h",
		"DEVICE_SESSION_IDLE":     "2160h",
		"DEVICE_SESSION_ABSOLUTE": "8760h",
		"CLIENT_IP_HEADER":        "",
	}
	local := maps.Clone(compose)
	local["COOKIE_SECURE"] = "false"
	for name, values := range map[string]map[string]string{
		"config/deploy.yml": {
			"ADDR":                    ":8080",
			"DB_PATH":                 "/data/handwriting.db",
			"HSTS":                    "true",
			"COOKIE_SECURE":           "true",
			"BASE_URL":                "https://handwriting.17xande.dev",
			"SESSION_IDLE":            "720h",
			"SESSION_ABSOLUTE":        "2160h",
			"DEVICE_SESSION_IDLE":     "2160h",
			"DEVICE_SESSION_ABSOLUTE": "8760h",
			"CLIENT_IP_HEADER":        "CF-Connecting-IP",
		},
		"compose.yaml":                         compose,
		"compose.yaml with compose.local.yaml": local,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := load(envtest.NewRecorder(values).Lookup); err != nil {
				t.Fatal(err)
			}
		})
	}
}
