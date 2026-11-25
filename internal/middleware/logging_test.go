package middleware

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// accessPath runs one request through Logging and returns the logged path.
func accessPath(t *testing.T, h http.Handler, method, target string) string {
	t.Helper()
	var buf bytes.Buffer
	rec := httptest.NewRecorder()
	Logging(slog.New(slog.NewJSONHandler(&buf, nil)))(h).ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	var row struct{ Msg, Path string }
	if err := json.Unmarshal(buf.Bytes(), &row); err != nil || row.Msg != "request" {
		t.Fatalf("access log is not one request line: %v", err)
	}
	return row.Path
}

// Only a 403 that was refused before routing (the cross-origin check, which
// has its own warning naming the route) hides the path. A handler's own 403
// is a normal request: operators need to see which path it was.
func TestAccessLogHidesThePathOnlyForRefusalsBeforeRouting(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /admin/users", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", http.StatusForbidden)
	})
	// Stands in for http.CrossOriginProtection: it answers before the mux
	// has matched anything, so r.Pattern is empty.
	refuse := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "cross-origin request refused", http.StatusForbidden)
	})

	if got := accessPath(t, mux, "GET", "/admin/users"); got != "/admin/users" {
		t.Errorf("a handler's 403 logged path %q; want the path", got)
	}
	const secret = "privateSegmentValue"
	if got := accessPath(t, refuse, "POST", "/account/"+secret); got != "unmatched" || strings.Contains(got, secret) {
		t.Errorf("a refusal before routing logged path %q; want the marker", got)
	}
}
