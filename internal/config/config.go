// Package config turns the environment into one Config struct. Every setting
// the server reads is parsed here and nowhere else, so the list below is the
// complete surface an operator can turn.
package config

import (
	"fmt"
	"os"
	"time"

	"calligraphy/internal/account"

	"github.com/17xande-dev/env"
	"github.com/17xande-dev/ratelimit/clientip"
	"github.com/17xande-dev/websec/csrf"
	"github.com/17xande-dev/websec/session"
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

	// Lifetimes applies to new as well as previously issued credentials.
	Lifetimes account.Lifetimes

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

// Load reads the process environment and reports every invalid setting at
// once rather than the first.
func Load() (Config, error) { return load(os.LookupEnv) }

// load takes the lookup so tests can supply an environment without touching
// the process's.
func load(lookup env.Lookup) (Config, error) {
	r := env.New(lookup)
	c := Config{
		Addr:            r.String("ADDR", ":8080"),
		HSTS:            r.Bool("HSTS", false),
		CookieSecure:    r.Bool("COOKIE_SECURE", true),
		BaseURL:         r.String("BASE_URL", ""),
		ShutdownTimeout: r.Duration("SHUTDOWN_TIMEOUT", 10*time.Second, time.Nanosecond, 0),
		DBPath:          r.String("DB_PATH", ""),
		ClientIPHeader:  r.String("CLIENT_IP_HEADER", ""),
	}
	if c.BaseURL != "" {
		if err := csrf.ValidateOrigin(c.BaseURL, !c.CookieSecure); err != nil {
			r.Fail("BASE_URL", "must be a lower-case origin (scheme://host[:port]) matching COOKIE_SECURE, with no path or default port")
		}
	}

	c.Lifetimes = account.DefaultLifetimes()
	loadLifetime := func(prefix string, life *session.Lifetime) {
		before := fmt.Sprint(r.Err())
		for _, entry := range []struct {
			key string
			dst *time.Duration
		}{
			{prefix + "_IDLE", &life.Idle},
			{prefix + "_ABSOLUTE", &life.Absolute},
		} {
			// The one-second minimum keeps zero and negative values out; Duration
			// accepts fractions, which the session library refuses.
			*entry.dst = r.Duration(entry.key, *entry.dst, time.Second, 0)
			if *entry.dst%time.Second != 0 {
				r.Fail(entry.key, "want a positive whole-second Go duration such as 720h")
			}
		}
		// Only compare the two once both were readable.
		if fmt.Sprint(r.Err()) == before {
			if err := life.Validate(); err != nil {
				r.Fail(prefix+"_IDLE / "+prefix+"_ABSOLUTE", "the idle limit must not exceed the absolute limit")
			}
		}
	}
	loadLifetime("SESSION", &c.Lifetimes.Web)
	loadLifetime("DEVICE_SESSION", &c.Lifetimes.Device)

	if src, err := clientip.New(clientip.Config{TrustedHeader: c.ClientIPHeader}); err != nil {
		r.Fail("CLIENT_IP_HEADER", "must be a valid header name")
	} else {
		c.ClientIP = src
	}

	if err := r.Err(); err != nil {
		return Config{}, fmt.Errorf("config: %w", err)
	}
	return c, nil
}
