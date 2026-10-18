package middleware

import (
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
)

// Middleware wraps a handler.
type Middleware func(http.Handler) http.Handler

// statusRecorder captures the status code for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Logging writes one structured line per request. Static assets are skipped:
// every page load fetches several, and they drown out the requests that say
// what people are actually doing.
func Logging(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			if strings.HasPrefix(r.URL.Path, "/static/") && rec.status < 400 {
				return
			}
			log.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rec.status,
				"dur", time.Since(start).Round(time.Microsecond))
		})
	}
}

// Chain applies middleware so the first listed is the outermost.
func Chain(h http.Handler, m ...Middleware) http.Handler {
	for _, mw := range slices.Backward(m) {
		h = mw(h)
	}
	return h
}
