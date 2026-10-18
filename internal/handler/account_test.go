package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"calligraphy/internal/account"
	"calligraphy/internal/auth"
)

const testPassword = "a long enough password"

// addUser creates an account with testPassword.
func (s *testServer) addUser(t *testing.T, email string, admin bool) account.User {
	t.Helper()
	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatal(err)
	}
	u, err := s.accounts.Create(t.Context(), email, hash, admin)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// do sends a request, with the session cookie when one is given.
func (s *testServer) do(t *testing.T, method, target string, form url.Values, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if form != nil {
		r = httptest.NewRequest(method, target, strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
	}
	rec := httptest.NewRecorder()
	s.routes.ServeHTTP(rec, r)
	return rec
}

// signIn signs in through the form and returns the session cookie's value.
func (s *testServer) signIn(t *testing.T, email, password string) string {
	t.Helper()
	rec := s.do(t, "POST", "/account/login", url.Values{"email": {email}, "password": {password}}, "")
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("sign in as %s: status %d", email, rec.Code)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			return c.Value
		}
	}
	t.Fatal("no session cookie set")
	return ""
}

func TestSignInAndOut(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, "A@X.com", testPassword)

	body := s.do(t, "GET", "/account", nil, cookie).Body.String()
	if !strings.Contains(body, "a@x.com") || !strings.Contains(body, "(this browser)") {
		t.Fatal("account page does not show the signed-in user and session")
	}
	rec := s.do(t, "POST", "/account/logout", url.Values{}, cookie)
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("logout: %d", rec.Code)
	}
	// The token itself must be dead, not just the cookie cleared: a copied
	// cookie must not outlive signing out.
	if body := s.do(t, "GET", "/account", nil, cookie).Body.String(); !strings.Contains(body, `action="/account/login"`) {
		t.Error("session still valid after sign-out")
	}
}

// The cookie signs in an account, so it must be unreadable to scripts and
// never sent on another site's cross-site POST.
func TestSessionCookieAttributes(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	rec := s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}}, "")
	var c *http.Cookie
	for _, x := range rec.Result().Cookies() {
		if x.Name == sessionCookie {
			c = x
		}
	}
	if c == nil || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.Path != "/" {
		t.Fatalf("cookie = %+v", c)
	}
}

// An unknown email, a wrong password and a disabled account must answer
// identically, or the form says which emails have accounts.
func TestFailedSignInsAreIndistinguishable(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "admin@x.com", true)
	u := s.addUser(t, "off@x.com", false)
	s.accounts.SetDisabled(t.Context(), u.ID, true)
	s.addUser(t, "on@x.com", false)

	var first string
	for _, tc := range []struct{ email, pw string }{
		{"nobody@x.com", testPassword},
		{"on@x.com", "wrong password here"},
		{"off@x.com", testPassword},
	} {
		rec := s.do(t, "POST", "/account/login", url.Values{"email": {tc.email}, "password": {tc.pw}}, "")
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: status %d", tc.email, rec.Code)
		}
		if len(rec.Result().Cookies()) != 0 {
			t.Errorf("%s: a cookie was set", tc.email)
		}
		// Compare the message, with the echoed email taken out.
		body := strings.ReplaceAll(rec.Body.String(), tc.email, "")
		if first == "" {
			first = body
		} else if body != first {
			t.Errorf("%s: response differs from the unknown-email response", tc.email)
		}
	}
	if !strings.Contains(first, loginFailed) {
		t.Error("failure message missing")
	}
}

func TestSignInIsRateLimitedPerEmail(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	for range 5 {
		s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {"wrong password!!"}}, "")
	}
	// Even the right password is refused once the bucket is empty, and
	// changing the email's case does not buy a fresh bucket.
	rec := s.do(t, "POST", "/account/login", url.Values{"email": {"A@x.com"}, "password": {testPassword}}, "")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d, want 429", rec.Code)
	}
}

// Only a path on this site: "//evil.example" is another host to a browser.
func TestSignInRedirectStaysOnSite(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	for next, want := range map[string]string{
		"/progress":            "/progress",
		"//evil.example/x":     "/account",
		"/\\evil.example":      "/account",
		"https://evil.example": "/account",
	} {
		rec := s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}, "next": {next}}, "")
		if loc := rec.Header().Get("Location"); loc != want {
			t.Errorf("next=%q: redirected to %q, want %q", next, loc, want)
		}
	}
}

func TestChangePassword(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, "a@x.com", testPassword)
	other := s.signIn(t, "a@x.com", testPassword)

	change := func(current, next, confirm string) string {
		rec := s.do(t, "POST", "/account/password", url.Values{"current": {current}, "new": {next}, "confirm": {confirm}}, cookie)
		return rec.Header().Get("Location")
	}
	if loc := change("wrong one entirely", "another long password", "another long password"); !strings.Contains(loc, "error=wrong-password") {
		t.Errorf("wrong current password: %s", loc)
	}
	if loc := change(testPassword, "another long password", "a different long one"); !strings.Contains(loc, "error=password-mismatch") {
		t.Errorf("mismatch: %s", loc)
	}
	if loc := change(testPassword, "short", "short"); !strings.Contains(loc, "error=password-short") {
		t.Errorf("short: %s", loc)
	}
	if loc := change(testPassword, "another long password", "another long password"); !strings.Contains(loc, "notice=password-changed") {
		t.Fatalf("change: %s", loc)
	}
	// This browser stays signed in; every other session is ended.
	if !strings.Contains(s.do(t, "GET", "/account", nil, cookie).Body.String(), "Change password") {
		t.Error("the changing session was signed out")
	}
	if !strings.Contains(s.do(t, "GET", "/account", nil, other).Body.String(), `action="/account/login"`) {
		t.Error("another session survived the change")
	}
	s.signIn(t, "a@x.com", "another long password")
}

func TestRevokeOtherSession(t *testing.T) {
	s := newAccountServer(t)
	u := s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, "a@x.com", testPassword)
	tok, dev, _ := s.accounts.CreateSession(t.Context(), u.ID, account.KindDevice, "iPad")
	rec := s.do(t, "POST", "/account/sessions/"+itoa(dev.ID)+"/revoke", url.Values{}, cookie)
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "notice=revoked") {
		t.Fatalf("revoke: %d %s", rec.Code, loc)
	}
	if _, _, err := s.accounts.Authenticate(t.Context(), tok); err == nil {
		t.Error("revoked device still signed in")
	}
}

// publicRoutes are the only routes that answer someone not signed in. The
// list is short and deliberate: adding a route anywhere means either adding
// it here, with a reason, or protecting it.
var publicRoutes = map[string]bool{
	"GET /{$}": true, "GET /sheet/{slug}": true, "GET /progress": true,
	"GET /practice/new": true, "POST /practice/new": true, "POST /practice": true, "GET /practice": true,
	"GET /static/": true, "GET /favicon.ico": true, "GET /healthz": true,
	"GET /account":         true, // the sign-in form
	"POST /account/login":  true,
	"POST /account/logout": true, // signing out with no session is a no-op
	"POST /api/token":      true, // the app's sign-in
}

// Every route is collected from routes() itself, so a route added later is
// checked without anyone remembering to list it. Each is sent its own
// method: a GET would meet a 405 at a POST route and prove nothing.
func TestEveryRouteIsPublicOrProtected(t *testing.T) {
	s := newAccountServer(t)
	var all []string
	s.srv.routes(func(pattern string, _ http.Handler) { all = append(all, pattern) })
	if len(all) < 20 {
		t.Fatalf("collected only %d routes", len(all))
	}
	checked := 0
	for _, pattern := range all {
		if publicRoutes[pattern] {
			continue
		}
		method, path, _ := strings.Cut(pattern, " ")
		path = strings.NewReplacer("{id}", "1", "{$}", "").Replace(path)
		for _, cookie := range []string{"", "made-up-token"} {
			rec := s.do(t, method, path, url.Values{"current": {"x"}, "new": {"y"}, "confirm": {"y"}}, cookie)
			loc := rec.Header().Get("Location")
			refused := rec.Code == http.StatusUnauthorized ||
				(rec.Code == http.StatusSeeOther && strings.HasPrefix(loc, "/account"))
			if !refused {
				t.Errorf("%s (cookie %q): %d %s", pattern, cookie, rec.Code, loc)
			}
		}
		checked++
	}
	if checked < 10 {
		t.Fatalf("checked only %d protected routes", checked)
	}
}

// A cross-site form post is refused before any handler runs: this is the
// CSRF defence for every form.
func TestCrossOriginPostIsRefused(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, "a@x.com", testPassword)
	r := httptest.NewRequest("POST", "/account/logout", strings.NewReader(""))
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
	rec := httptest.NewRecorder()
	s.routes.ServeHTTP(rec, r)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-site POST: status %d", rec.Code)
	}
	if !strings.Contains(s.do(t, "GET", "/account", nil, cookie).Body.String(), "Sign out") {
		t.Error("the cross-site POST signed the user out")
	}
}

// Account pages hold someone's details; a shared cache or the back button
// on a shared computer must not keep them.
func TestAccountPageIsNoStore(t *testing.T) {
	s := newAccountServer(t)
	if cc := s.do(t, "GET", "/account", nil, "").Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control %q", cc)
	}
}

func TestBrowserLabel(t *testing.T) {
	for ua, want := range map[string]string{
		"Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0":                                                "Firefox on Linux",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15": "Safari on macOS",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0": "Edge on Windows",
		"": "A browser",
	} {
		if got := browserLabel(ua); got != want {
			t.Errorf("%q: %q, want %q", ua, got, want)
		}
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
