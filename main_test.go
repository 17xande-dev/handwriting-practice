package main

import (
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"calligraphy/internal/account"
	"calligraphy/internal/auth"
	"calligraphy/internal/config"
	"calligraphy/internal/dbtest"
	"calligraphy/internal/history"

	"github.com/17xande-dev/websec/webtest"
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

func TestTrustedOriginSurvivesHostRewrite(t *testing.T) {
	const publicOrigin = "https://practice.example"
	cfg, err := config.Load(func(key string) string {
		if key == "BASE_URL" {
			return publicOrigin
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	d := dbtest.New(t)
	h, err := newSiteHandler(cfg, quietLog(), account.NewStore(d, cfg.Lifetimes), history.NewStore(d))
	if err != nil {
		t.Fatal(err)
	}
	c := webtest.New(t, h, "http://internal.example", webtest.WithOrigin(publicOrigin))
	// Without Sec-Fetch-Site, the different Host would fail Go's default check.
	c.PostForm("/practice/new", nil).WantStatus(http.StatusOK)
	c.PostForm("/practice/new", nil, webtest.WithOrigin("https://elsewhere.example")).WantStatus(http.StatusForbidden)
}

func TestInvalidSessionLifetimeStopsStartupBeforeMigration(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "not-opened.db")
	for _, key := range []string{"HSTS", "COOKIE_SECURE", "BASE_URL", "SHUTDOWN_TIMEOUT", "CLIENT_IP_HEADER", "SESSION_IDLE", "SESSION_ABSOLUTE", "DEVICE_SESSION_IDLE"} {
		t.Setenv(key, "")
	}
	t.Setenv("DEVICE_SESSION_ABSOLUTE", "1h") // shorter than the default idle limit
	t.Setenv("DB_PATH", dbPath)
	t.Setenv("ADDR", "invalid-listen-address")
	if err := run(quietLog()); err == nil || !strings.Contains(err.Error(), "DEVICE_SESSION_ABSOLUTE") {
		t.Errorf("want a device lifetime error, got %v", err)
	}
	for _, name := range []string{dbPath, dbPath + ".migrate-lock"} {
		if _, err := os.Stat(name); !os.IsNotExist(err) {
			t.Errorf("startup touched %s before validating the session policy (stat err: %v)", name, err)
		}
	}
}
