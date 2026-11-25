// Package config turns the environment into one Config struct. Every setting
// the server reads is parsed here and nowhere else, so the list below is the
// complete surface an operator can turn.
package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/17xande-dev/ratelimit/clientip"
	"github.com/17xande-dev/websec/csrf"
)

// Config is the whole runtime configuration.
type Config struct {
	// Addr is the listen address, e.g. ":8080".
	Addr string

	// HSTS adds Strict-Transport-Security. Only for an https deployment:
	// sent from a plain-HTTP localhost it pins a rule that breaks the next
	// project on that port.
	HSTS bool

	// CookieSecure describes the browser-facing connection, which may be
	// HTTPS even when the tunnel connects to this server over HTTP.
	CookieSecure bool

	// BaseURL is the optional, canonical browser-facing origin.
	BaseURL string

	// ShutdownTimeout bounds how long in-flight requests get on SIGTERM.
	ShutdownTimeout time.Duration

	// DBPath is the SQLite file holding accounts and synced history. It has
	// no default: a default inside the image would quietly write to the
	// container's own filesystem, and every deploy would wipe it. The server
	// refuses to start without it (the -healthcheck probe does not need it).
	DBPath string

	// ClientIPHeader names the header carrying the visitor's address when a
	// proxy sits in front. Prefer a single-value header the proxy overwrites
	// (CF-Connecting-IP behind Cloudflare, X-Real-IP behind nginx). For
	// X-Forwarded-For only the rightmost entry is used, the one the nearest
	// proxy appended; the client controls everything to its left. Empty means
	// use the connection's own address. Only set it when every request
	// arrives through that proxy: otherwise anyone can send the header and
	// pick their own rate-limit bucket.
	ClientIPHeader string

	// ClientIP is the policy built from ClientIPHeader, for rate limiting.
	ClientIP clientip.Source
}

// Load reads configuration through getenv (os.Getenv in production, a map in
// tests) and reports every invalid value at once rather than the first.
func Load(getenv func(string) string) (Config, error) {
	c := Config{
		Addr:            ":8080",
		CookieSecure:    true,
		ShutdownTimeout: 10 * time.Second,
	}
	var errs []string

	if v := getenv("ADDR"); v != "" {
		c.Addr = v
	}

	switch v := getenv("HSTS"); v {
	case "", "0", "false":
	case "1", "true":
		c.HSTS = true
	default:
		errs = append(errs, fmt.Sprintf("HSTS: want 1/0/true/false, got %q", v))
	}

	switch v := getenv("COOKIE_SECURE"); v {
	case "", "1", "true":
	case "0", "false":
		c.CookieSecure = false
	default:
		errs = append(errs, fmt.Sprintf("COOKIE_SECURE: want 1/0/true/false, got %q", v))
	}

	if c.BaseURL = getenv("BASE_URL"); c.BaseURL != "" {
		if err := csrf.ValidateOrigin(c.BaseURL, !c.CookieSecure); err != nil {
			errs = append(errs, fmt.Sprintf("BASE_URL: %v", err))
		}
	}

	if v := getenv("SHUTDOWN_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			errs = append(errs, fmt.Sprintf("SHUTDOWN_TIMEOUT: want a positive duration like 10s, got %q", v))
		} else {
			c.ShutdownTimeout = d
		}
	}

	c.DBPath = getenv("DB_PATH")
	c.ClientIPHeader = getenv("CLIENT_IP_HEADER")
	if src, err := clientip.New(clientip.Config{TrustedHeader: c.ClientIPHeader}); err != nil {
		errs = append(errs, fmt.Sprintf("CLIENT_IP_HEADER: %v", err))
	} else {
		c.ClientIP = src
	}

	if len(errs) > 0 {
		return Config{}, fmt.Errorf("config: %s", strings.Join(errs, "; "))
	}
	return c, nil
}
