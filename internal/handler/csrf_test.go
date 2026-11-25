package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"calligraphy/internal/fonts"
	"calligraphy/internal/middleware"

	"github.com/17xande-dev/websec/webtest"
)

const csrfTestOrigin = "https://practice.example"

// unsafeRoutes is the exact number of non-GET/HEAD registrations. The sweep's
// floor equals it, so removing a route fails the test until this is lowered
// on purpose; a new one is covered by the sweep and should raise it.
const unsafeRoutes = 17

func TestCrossOriginRouteSweep(t *testing.T) {
	s := newAccountServer(t)
	const email = "admin@example.com"
	s.addUser(t, email, true)
	target := s.addUser(t, "member@example.com", false)

	// The same registrar mounts the production mux. Parse all patterns before
	// filtering so a future route without a declared method can't go untested.
	var patterns []string
	s.srv.routes(func(pattern string, _ http.Handler) { patterns = append(patterns, pattern) })
	var unsafe []webtest.Route
	for _, route := range webtest.Routes(t, patterns, map[string]string{
		"id": strconv.FormatInt(target.ID, 10), "slug": "arches",
	}) {
		if route.Method != http.MethodGet && route.Method != http.MethodHead {
			unsafe = append(unsafe, route)
		}
	}

	if len(unsafe) != unsafeRoutes {
		t.Fatalf("%d non-GET/HEAD routes registered, the sweep expects %d: update unsafeRoutes", len(unsafe), unsafeRoutes)
	}

	// On a held, separate SQLite connection, data_version changes if any
	// handler commits a write, even if it also returns an error status.
	probe, err := s.db.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	version := func(t *testing.T) int {
		t.Helper()
		var v int
		if err := probe.QueryRowContext(t.Context(), "PRAGMA data_version").Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	for _, tc := range []struct {
		name string
		opts []webtest.Option
	}{
		{"wrong-Origin", []webtest.Option{webtest.WithOrigin("https://elsewhere.example")}},
		{"cross-site-Fetch-Metadata", []webtest.Option{webtest.NoOrigin(), webtest.SecFetchSite("cross-site")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := webtest.New(t, s.routes, csrfTestOrigin)
			cookie := c.PostForm("/account/login", url.Values{"email": {email}, "password": {testPassword}}).
				SetCookie("__Host-hp_session")
			before := version(t)
			checked := webtest.Sweep{
				Routes: unsafe, Min: unsafeRoutes,
				Client: func() *webtest.Client {
					return webtest.New(t, s.routes, csrfTestOrigin, tc.opts...)
				},
				Cookies: []*http.Cookie{cookie},
				NoToken: true,
				Refused: func(route webtest.Route, res *webtest.Response) error {
					if res.Status != http.StatusForbidden || res.Header.Get("Cache-Control") != "no-store" {
						return fmt.Errorf("want a non-cacheable CSRF 403")
					}
					if strings.HasPrefix(route.Path, "/api/") &&
						(res.Header.Get("Content-Type") != "application/json" ||
							strings.TrimSpace(res.Body) != `{"error":"cross-origin request refused"}`) {
						return fmt.Errorf("want the JSON CSRF refusal")
					}
					return nil
				},
			}.Run(t)
			t.Logf("swept %d routes, with and without a live admin cookie", checked)
			if version(t) != before {
				t.Error("refused requests wrote to the database")
			}
		})
	}
}

func TestCookieSyncAcceptsSameOriginOrNoBrowserHeaders(t *testing.T) {
	s := newAccountServer(t)
	const email = "member@example.com"
	s.addUser(t, email, false)
	c := webtest.New(t, s.routes, csrfTestOrigin)
	c.PostForm("/account/login", url.Values{"email": {email}, "password": {testPassword}}).WantStatus(http.StatusSeeOther)
	for _, tc := range []struct {
		name string
		opts []webtest.Option
	}{
		{"same-origin", nil}, // webtest sets Origin to the request's origin.
		{"no-Origin-or-Fetch-Metadata", []webtest.Option{webtest.NoOrigin()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := c.With(t)
			r := c.NewRequest(http.MethodPost, "/api/sync", strings.NewReader(`{}`))
			r.Header.Set("Content-Type", "application/json")
			c.Do(r, tc.opts...).WantStatus(http.StatusOK)
		})
	}
}

func TestIPadRoutesWorkWithoutOrigin(t *testing.T) {
	s := newAccountServer(t)
	const email = "member@example.com"
	s.addUser(t, email, false)
	c := webtest.New(t, s.routes, csrfTestOrigin, webtest.NoOrigin())
	tokenRequest := c.NewRequest(http.MethodPost, "/api/token",
		strings.NewReader(fmt.Sprintf(`{"email":%q,"password":%q,"label":"iPad"}`, email, testPassword)))
	tokenRequest.Header.Set("Content-Type", "application/json")
	res := c.Do(tokenRequest)
	if res.Status != http.StatusOK {
		t.Fatalf("device sign-in returned %d, want 200", res.Status)
	}
	var device struct{ Token, Email string }
	if err := json.Unmarshal([]byte(res.Body), &device); err != nil || device.Token == "" || device.Email != email {
		t.Fatal("device sign-in did not return a token for the expected account")
	}
	if len(res.Header.Values("Set-Cookie")) != 0 {
		t.Fatal("device sign-in set a cookie")
	}
	bearer := webtest.Header("Authorization", "bEaReR "+device.Token)
	c.Get("/api/me", bearer).WantStatus(http.StatusOK)
	sync := c.NewRequest(http.MethodPost, "/api/sync", strings.NewReader(`{}`))
	sync.Header.Set("Content-Type", "application/json")
	c.Do(sync, bearer).WantStatus(http.StatusOK)
	c.Do(c.NewRequest(http.MethodDelete, "/api/token", nil), bearer).WantStatus(http.StatusNoContent)
	c.Get("/api/me", bearer).WantStatus(http.StatusUnauthorized)
}

func TestEmptyBearerDoesNotFallBackToCookie(t *testing.T) {
	s := newAccountServer(t)
	const email = "member@example.com"
	s.addUser(t, email, false)
	server := httptest.NewTLSServer(s.routes)
	defer server.Close()
	c := webtest.NewServer(t, server)
	c.PostForm("/account/login", url.Values{"email": {email}, "password": {testPassword}}).WantStatus(http.StatusSeeOther)
	c.Get("/api/me").WantStatus(http.StatusOK)
	// On the wire, net/http may strip trailing whitespace and deliver a
	// bare scheme. Neither that nor the original spelling is cookie auth.
	for _, tc := range []struct{ name, auth string }{
		{"bare", "Bearer"},
		{"one-space", "Bearer "},
		{"mixed-case-several-spaces", "bEaReR   "},
		{"upper-case-trailing-tab", "BEARER \t"},
		{"basic", "Basic Zm9vOmJhcg=="},
		{"other-scheme", "Bogus"},
		{"non-breaking-space", "Bearer\u00a0bogus"},
		{"unknown-token", "Bearer bogus"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c.With(t).Get("/api/me", webtest.Header("Authorization", tc.auth)).WantStatus(http.StatusUnauthorized)
		})
	}
}

// meWith sends GET /api/me with exactly the given Authorization header values
// (none when empty) and a valid session cookie, bypassing the client so that
// an empty value or a repeated header reaches the handler as written.
func (s *testServer) meWith(t *testing.T, cookie string, authorization ...string) int {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	r.Header["Authorization"] = authorization
	r.AddCookie(&http.Cookie{Name: s.srv.session.Name(), Value: cookie})
	rec := httptest.NewRecorder()
	s.routes.ServeHTTP(rec, r)
	return rec.Code
}

// Any Authorization header means a device request: the cookie is used only
// when there is none, and a repeated header is refused rather than read as its
// first value.
func TestAuthorizationHeaderNeverFallsBackToCookie(t *testing.T) {
	s := newAccountServer(t)
	const email = "member@example.com"
	s.addUser(t, email, false)
	cookie := s.signIn(t, email, testPassword)
	token := s.deviceToken(t, email, testPassword)

	if got := s.meWith(t, cookie); got != http.StatusOK {
		t.Fatalf("cookie alone: %d, want 200", got)
	}
	for _, tc := range []struct {
		name string
		auth []string
		want int
	}{
		{"one Bearer", []string{"Bearer " + token}, http.StatusOK},
		{"empty value", []string{""}, http.StatusUnauthorized},
		{"basic", []string{"Basic Zm9vOmJhcg=="}, http.StatusUnauthorized},
		{"other scheme", []string{"Bogus"}, http.StatusUnauthorized},
		{"non-breaking space", []string{"Bearer\u00a0bogus"}, http.StatusUnauthorized},
		{"non-breaking space before a live token", []string{"Bearer\u00a0" + token}, http.StatusUnauthorized},
		{"basic then bearer", []string{"Basic x", "Bearer bogus"}, http.StatusUnauthorized},
		{"two live Bearers", []string{"Bearer " + token, "Bearer " + token}, http.StatusUnauthorized},
		{"live Bearer then basic", []string{"Bearer " + token, "Basic x"}, http.StatusUnauthorized},
		{"two empty values", []string{"", ""}, http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := s.meWith(t, cookie, tc.auth...); got != tc.want {
				t.Fatalf("status %d, want %d", got, tc.want)
			}
		})
	}
}

func TestCrossOriginRefusalLogDoesNotLeak(t *testing.T) {
	o := testOptions(t, fonts.Builtin)
	log, logs := webtest.Logger(t)
	o.Log = log
	h, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	c := webtest.New(t, middleware.Logging(log)(h), csrfTestOrigin)

	const (
		pathValue   = "private-route-segment"
		originValue = "private-origin-value"
		bearerValue = "private-bearer-value"
		cookieValue = "private-cookie-value"
	)
	for _, tc := range []struct {
		name, path, route, header string
		opts                      []webtest.Option
	}{
		{"Origin", "/account/sessions/" + pathValue + "/revoke", "POST /account/sessions/{id}/revoke", "Origin", nil},
		{"Fetch-Metadata", "/account/sessions/" + pathValue + "/revoke", "POST /account/sessions/{id}/revoke", "Sec-Fetch-Site",
			[]webtest.Option{webtest.SecFetchSite("cross-site")}},
		{"unmatched", "/account//" + pathValue, "unmatched", "Origin", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs.Reset()
			opts := append([]webtest.Option{
				webtest.WithOrigin("https://" + originValue + ".example"),
				webtest.Header("Authorization", "Bearer "+bearerValue),
				webtest.Header("Cookie", "__Host-hp_session="+cookieValue),
			}, tc.opts...)
			res := c.With(t).PostForm(tc.path, nil, opts...)
			res.WantStatus(http.StatusForbidden)
			text := logs.String()
			webtest.NoSecrets(t, text, `"msg":"cross-origin request refused"`, pathValue, originValue, bearerValue, cookieValue)
			if !strings.Contains(text, `"level":"WARN","msg":"cross-origin request refused","method":"POST","route":"`+
				tc.route+`","header":"`+tc.header+`"`) {
				t.Error("refusal warning missing the expected method, route or header")
			}
		})
	}
}

func TestBearerParsing(t *testing.T) {
	for _, tc := range []struct {
		name, header, token string
		present             bool
	}{
		{name: "absent"},
		{name: "other scheme", header: "Basic value"},
		{name: "bare scheme", header: "Bearer", present: true},
		{name: "one trailing space", header: "Bearer ", present: true},
		{name: "mixed case and trailing whitespace", header: "bEaReR  \t", present: true},
		{name: "valid", header: "bEaReR token ", token: "token", present: true},
		{name: "tab separator", header: "Bearer\ttoken", token: "token", present: true},
		{name: "space then tab", header: "Bearer \t token", token: "token", present: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/me", nil)
			if tc.header != "" {
				r.Header.Set("Authorization", tc.header)
			}
			if token, present := bearer(r); token != tc.token || present != tc.present {
				t.Fatalf("bearer(%q) = %q, %t; want %q, %t", tc.header, token, present, tc.token, tc.present)
			}
		})
	}
}

// Over the handler: a tab-separated live token authenticates, as the twin's
// parser does, instead of being read as "no Bearer" and falling to the cookie.
func TestTabSeparatedBearerAuthenticates(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "member@example.com", false)
	token := s.deviceToken(t, "member@example.com", testPassword)
	r := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	r.Header.Set("Authorization", "Bearer\t"+token)
	rec := httptest.NewRecorder()
	s.routes.ServeHTTP(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
}
