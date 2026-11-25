package main

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"calligraphy/internal/auth"
)

// Real argon2 costs ~100ms and 64 MiB per hash; these tests hash and
// verify hundreds of times and are about behaviour, not cost.
func TestMain(m *testing.M) {
	os.Exit(auth.RunWithFastHashes(m))
}

func TestInvalidBaseURLStopsStartupBeforeDatabaseOpen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "not-opened.db")
	t.Setenv("BASE_URL", "http://app.example")
	t.Setenv("COOKIE_SECURE", "1")
	t.Setenv("DB_PATH", dbPath)
	// If validation happens too late, do not leave the test listening.
	t.Setenv("ADDR", "invalid-listen-address")
	for _, key := range []string{"HSTS", "SHUTDOWN_TIMEOUT", "CLIENT_IP_HEADER"} {
		t.Setenv(key, "")
	}
	err := run(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil || !strings.Contains(err.Error(), "BASE_URL") {
		t.Errorf("want a BASE_URL error, got %v", err)
	}
	for _, name := range []string{dbPath, dbPath + ".migrate-lock"} {
		if _, err := os.Stat(name); !os.IsNotExist(err) {
			t.Errorf("startup touched %s before validating BASE_URL (stat err: %v)", name, err)
		}
	}
}
