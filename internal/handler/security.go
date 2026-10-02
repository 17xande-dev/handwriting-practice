package handler

import (
	"net/http"
	"strings"

	"calligraphy/internal/config"
)

// Policy is the Content-Security-Policy, built from config so a change of
// reference font cannot be made without its origins being allowed too.
type Policy struct {
	StyleSrc []string
	FontSrc  []string
}

func newPolicy(c config.Config) Policy {
	p := Policy{StyleSrc: []string{"'self'"}, FontSrc: []string{"'self'"}}
	if c.FontCSSURL != "" {
		// Already validated by config, so the error cannot happen here.
		origin, _ := config.PublicOrigin(c.FontCSSURL)
		p.StyleSrc = append(p.StyleSrc, origin)
	}
	p.FontSrc = append(p.FontSrc, c.FontFileOrigins...)
	return p
}

func (p Policy) String() string {
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src " + strings.Join(p.StyleSrc, " "),
		"font-src " + strings.Join(p.FontSrc, " "),
		"img-src 'self' data:",
		"connect-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	}, "; ")
}

func securityHeaders(p Policy, next http.Handler) http.Handler {
	csp := p.String()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}
