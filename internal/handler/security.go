package handler

import (
	"net/http"
	"slices"
	"strings"

	"calligraphy/internal/fonts"
)

// Policy is the Content-Security-Policy, built from the font catalogue so a
// font cannot be added without its origins being allowed too, and no origin
// is allowed that no font uses.
type Policy struct {
	StyleSrc []string
	FontSrc  []string
}

func newPolicy(list []fonts.Font) Policy {
	p := Policy{StyleSrc: []string{"'self'"}, FontSrc: []string{"'self'"}}
	add := func(dst *[]string, raw string) {
		if raw == "" {
			return
		}
		// Already validated by fonts.Validate, so the error cannot happen here.
		o, _ := fonts.PublicOrigin(raw)
		if !slices.Contains(*dst, o) {
			*dst = append(*dst, o)
		}
	}
	for _, f := range list {
		add(&p.StyleSrc, f.CSSURL)
		add(&p.FontSrc, f.FileOrigin)
	}
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
