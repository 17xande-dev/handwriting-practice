// Package config parses every environment variable the server reads into one
// struct, so the rest of the code never calls os.Getenv.
package config

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
)

// Config is the whole runtime configuration.
type Config struct {
	Addr string

	// FontFamily is the CSS family name of the reference font. It is written
	// into a generated stylesheet, so it is restricted to a safe character set
	// rather than escaped.
	FontFamily string

	// FontCSSURL is the stylesheet that defines FontFamily (a Google Fonts css2
	// URL by default). Empty means the font is expected to be installed locally.
	FontCSSURL string

	// FontFileOrigins are where the stylesheet loads its font files from. They
	// cannot be derived from FontCSSURL: Google serves the CSS from
	// fonts.googleapis.com and the files from fonts.gstatic.com.
	FontFileOrigins []string
}

// Defaults for the reference font. The choice is recorded in the README.
const (
	DefaultFontFamily      = "Edu SA Beginner"
	DefaultFontCSSURL      = "https://fonts.googleapis.com/css2?family=Edu+SA+Beginner&display=swap"
	DefaultFontFileOrigins = "https://fonts.gstatic.com"
)

var fontFamilyRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$`)

// Load reads the environment.
func Load() (Config, error) {
	return parse(os.LookupEnv)
}

// parse takes an os.LookupEnv-shaped function so tests can supply their own
// environment. A variable set to the empty string counts as set, so
// FONT_CSS_URL="" switches the remote stylesheet off.
func parse(lookupEnv func(string) (string, bool)) (Config, error) {
	get := func(key, def string) string {
		if v, ok := lookupEnv(key); ok {
			return v
		}
		return def
	}

	c := Config{
		Addr:       get("ADDR", ":8080"),
		FontFamily: get("FONT_FAMILY", DefaultFontFamily),
		FontCSSURL: get("FONT_CSS_URL", DefaultFontCSSURL),
	}

	if !fontFamilyRe.MatchString(c.FontFamily) {
		return Config{}, fmt.Errorf("FONT_FAMILY %q: only letters, digits, spaces and hyphens are allowed", c.FontFamily)
	}
	if c.FontCSSURL != "" {
		if _, err := PublicOrigin(c.FontCSSURL); err != nil {
			return Config{}, fmt.Errorf("FONT_CSS_URL: %w", err)
		}
	}
	for o := range strings.SplitSeq(get("FONT_FILE_ORIGINS", DefaultFontFileOrigins), ",") {
		o = strings.TrimSpace(o)
		if o == "" {
			continue
		}
		origin, err := PublicOrigin(o)
		if err != nil {
			return Config{}, fmt.Errorf("FONT_FILE_ORIGINS: %w", err)
		}
		c.FontFileOrigins = append(c.FontFileOrigins, origin)
	}
	return c, nil
}

// PublicOrigin reduces an https URL to scheme://host for use as a CSP source.
// CSP source paths are exact matches rather than prefixes, so a source with a
// path would allow only that one URL and refuse everything else on the host.
func PublicOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if u.Scheme != "https" || u.Host == "" {
		return "", fmt.Errorf("%q: must be an absolute https URL", raw)
	}
	return u.Scheme + "://" + u.Host, nil
}
