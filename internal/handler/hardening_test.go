package handler

import (
	"bytes"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"

	"calligraphy/internal/auth"
)

// A browser reads "/%09/evil.example" and "/\t/evil" as "//evil.example" (it
// drops tabs and newlines), and "/\\evil" as "//evil": every one of these
// would be an open redirect after sign-in.
func TestSafeNext(t *testing.T) {
	for next, want := range map[string]string{
		"/progress":            "/progress",
		"/sheet/arches?x=1#y":  "/sheet/arches?x=1#y",
		"/":                    "/",
		"":                     "",
		"/%09/evil.example":    "",
		"/\t/evil":             "",
		"/\n/evil":             "",
		"/\\evil":              "",
		"/\\\\evil":            "",
		"/%5Cevil":             "",
		"https://evil":         "",
		"//evil":               "",
		"///evil":              "",
		"evil":                 "",
		"/%2F/evil":            "", // decodes to "//evil"; refused even though a browser would keep it one segment
		"/a\x00b":              "",
		"/a\x7fb":              "",
		"javascript:alert(1)":  "",
		"/%0a/evil.example":    "",
		"/..%2f..%2fetc":       "/..%2f..%2fetc",
		"/ok?next=//evil":      "/ok?next=//evil",
		"/\u2028/evil":         "/\u2028/evil",
		"/%00":                 "",
		"/path with space":     "/path with space",
		"/%":                   "",
		"/%zz":                 "",
		"/a/\x1f":              "",
		"//":                   "",
		"/\r/evil":             "",
		"http://evil.example/": "",
	} {
		if got := safeNext(next); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", next, got, want)
		}
	}
}

func TestSignInRedirectRefusesControlCharacters(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	for _, next := range []string{"/%09/evil.example", "/\t/evil", `/\\evil`, "https://evil", "//evil"} {
		rec := s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}, "next": {next}}, "")
		if loc := rec.Header().Get("Location"); loc != "/account" {
			t.Errorf("next=%q: redirected to %q", next, loc)
		}
	}
}

// The login form's body is capped before it is read.
func TestFormBodiesAreCapped(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "admin@x.com", true)
	s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, "a@x.com", testPassword)
	adminCookie := s.signIn(t, "admin@x.com", testPassword)
	big := url.Values{"email": {"a@x.com"}, "password": {strings.Repeat("p", 5<<10)}}
	for _, tc := range []struct{ target, cookie string }{
		{"/account/login", ""},
		{"/account/logout", ""},
		{"/account/password", cookie},
		{"/account/sessions/1/revoke", cookie},
		{"/admin/users", adminCookie},
	} {
		body := big
		if strings.HasPrefix(tc.target, "/account/p") || strings.HasPrefix(tc.target, "/account/sessions") {
			body = url.Values{"current": {strings.Repeat("p", 9<<10)}}
		}
		if rec := s.do(t, "POST", tc.target, body, tc.cookie); rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("%s: status %d, want 413", tc.target, rec.Code)
		}
	}
	// A normal form is unaffected.
	if rec := s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}}, ""); rec.Code != http.StatusSeeOther {
		t.Errorf("normal sign-in: %d", rec.Code)
	}
}

// Malformed emails are refused before the limiter, so junk cannot fill its map.
func TestBadEmailsSkipTheLimiter(t *testing.T) {
	s := newAccountServer(t)
	for _, email := range []string{strings.Repeat("a", 250) + "@x.com", "not an email", "Alex <a@x.com>", ""} {
		rec := s.do(t, "POST", "/account/login", url.Values{"email": {email}, "password": {"whatever password"}}, "")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("email %.20q: status %d, want 400", email, rec.Code)
		}
		rec = s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":%q,"password":"x","label":"l"}`, email), "", "")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("token with email %.20q: status %d, want 400", email, rec.Code)
		}
	}
	s.srv.limits.loginEmail.Allow("probe") // exercise the map under the lock
	if n := s.srv.limits.loginEmail.Len(); n != 1 {
		t.Errorf("the email limiter holds %d buckets after bad emails, want only the probe", n)
	}
	if n := s.srv.limits.loginIP.Len(); n != 0 {
		t.Errorf("the IP limiter holds %d buckets after bad emails", n)
	}
}

// The per-email bucket is keyed on a hash, so the limiter's memory never
// holds an email, and case changes still land in one bucket.
func TestEmailLimiterKeyIsAHash(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	s.do(t, "POST", "/account/login", url.Values{"email": {"A@X.com"}, "password": {"wrong password!"}}, "")
	for _, k := range s.srv.limits.loginEmail.Keys() {
		if strings.Contains(k, "x.com") {
			t.Errorf("limiter key %q contains the email", k)
		}
	}
}

// Every address in one IPv6 /64 shares the per-IP bucket.
func TestIPv6ClientsShareTheirSlash64(t *testing.T) {
	s := newAccountServer(t)
	for i := range 10 {
		r := httptest.NewRequest("POST", "/account/login", strings.NewReader(url.Values{
			"email": {fmt.Sprintf("u%d@x.com", i)}, "password": {"wrong password!!"},
		}.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.RemoteAddr = fmt.Sprintf("[2001:db8:1:2:%x::1]:4000", i+1)
		s.routes.ServeHTTP(httptest.NewRecorder(), r)
	}
	r := httptest.NewRequest("POST", "/account/login", strings.NewReader(url.Values{
		"email": {"another@x.com"}, "password": {"wrong password!!"},
	}.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.RemoteAddr = "[2001:db8:1:2:ffff::9]:4000"
	rec := httptest.NewRecorder()
	s.routes.ServeHTTP(rec, r)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("11th address in the /64: status %d, want 429", rec.Code)
	}
	// A different /64 is a different bucket.
	r.RemoteAddr = "[2001:db8:1:3::9]:4000"
	r.Body = io.NopCloser(strings.NewReader(url.Values{"email": {"another@x.com"}, "password": {"wrong password!!"}}.Encode()))
	rec = httptest.NewRecorder()
	s.routes.ServeHTTP(rec, r)
	if rec.Code == http.StatusTooManyRequests {
		t.Error("another /64 was limited")
	}
}

// With every argon2 slot taken a sign-in answers 503 and Retry-After, as a
// form and as the app's token call, rather than allocating more memory.
func TestSignInIsShedWhenArgonIsBusy(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	release := auth.HoldSlotsForTest(t)
	rec := s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}}, "")
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
		t.Errorf("form: %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
	rec = s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":"a@x.com","password":%q,"label":"l"}`, testPassword), "", "")
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" || !strings.Contains(rec.Body.String(), "busy") {
		t.Errorf("token: %d %s", rec.Code, rec.Body)
	}
	// An unknown email must not look different (it also needs a slot).
	rec = s.do(t, "POST", "/account/login", url.Values{"email": {"nobody@x.com"}, "password": {testPassword}}, "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("unknown email: %d", rec.Code)
	}
	release()
	if rec := s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}}, ""); rec.Code != http.StatusSeeOther {
		t.Errorf("after the slots free: %d", rec.Code)
	}
}

// logs captures what the server logs, so a test can check what is (and is
// not) in it.
type logBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *logBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}
func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func TestFailedSignInsAndLimitsAreLoggedWithoutSecrets(t *testing.T) {
	s := newAccountServer(t)
	var lb logBuf
	s.srv.log = slog.New(slog.NewTextHandler(&lb, nil))
	s.addUser(t, "a@x.com", false)
	for range 6 {
		s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {"hunter2 hunter2 hunter2"}}, "")
	}
	out := lb.String()
	if !strings.Contains(out, "sign-in failed") || !strings.Contains(out, "sign-in rate limited") {
		t.Fatalf("missing log lines:\n%s", out)
	}
	if !strings.Contains(out, emailTag("a@x.com")) || !strings.Contains(out, "192.0.2.1") {
		t.Errorf("log lacks the email hash prefix or the client IP:\n%s", out)
	}
	for _, secret := range []string{"hunter2", "a@x.com"} {
		if strings.Contains(out, secret) {
			t.Errorf("log contains %q:\n%s", secret, out)
		}
	}
	if !regexp.MustCompile(`email=[0-9a-f]{12}\b`).MatchString(out) {
		t.Errorf("email is not a 12-hex tag:\n%s", out)
	}
}

// Signing in over a live session ends that session, so it does not linger in
// someone's device list as a valid but unreachable sign-in.
func TestSignInRevokesTheSessionItReplaces(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	s.addUser(t, "b@x.com", false)
	old := s.signIn(t, "a@x.com", testPassword)
	rec := s.do(t, "POST", "/account/login", url.Values{"email": {"b@x.com"}, "password": {testPassword}}, old)
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("second sign-in: %d", rec.Code)
	}
	if _, _, err := s.accounts.Authenticate(t.Context(), old); err == nil {
		t.Error("the replaced session still authenticates")
	}
	// A failed sign-in keeps the existing session.
	cur := s.signIn(t, "b@x.com", testPassword)
	s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {"wrong password!!"}}, cur)
	if _, _, err := s.accounts.Authenticate(t.Context(), cur); err != nil {
		t.Errorf("a failed sign-in ended the live session: %v", err)
	}
}

// The signed-out page carries the script that clears this browser's sync
// state; an ordinary sign-in page does not.
func TestSignedOutPageClearsLocalSync(t *testing.T) {
	s := newAccountServer(t)
	body := s.do(t, "GET", "/account?notice=signed-out", nil, "").Body.String()
	m := regexp.MustCompile(`<script type="module" src="(/static/signout\.js\?v=[0-9a-f]+)"`).FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("signed-out page lacks signout.js:\n%s", body)
	}
	if !strings.Contains(body, "You are signed out.") {
		t.Error("signed-out notice missing")
	}
	res, js := get(t, s.routes, m[1])
	if res.StatusCode != 200 || !strings.Contains(js, "italic-practice") && len(js) == 0 {
		t.Errorf("signout.js: %d, %d bytes", res.StatusCode, len(js))
	}
	if body := s.do(t, "GET", "/account", nil, "").Body.String(); strings.Contains(body, "signout.js") {
		t.Error("the plain sign-in page clears sync state")
	}
	// Logging out and revoking this browser's own session both land on it.
	s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, "a@x.com", testPassword)
	rec := s.do(t, "POST", "/account/logout", url.Values{}, cookie)
	if loc := rec.Header().Get("Location"); loc != "/account?notice=signed-out" {
		t.Errorf("logout redirects to %q", loc)
	}
}

// The debug fixture code is not in the production bundle; it is its own file.
func TestFixtureCodeIsNotInTheProductionBundle(t *testing.T) {
	a, err := loadAssets()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"app.js", "progress.js", "signout.js"} {
		if strings.Contains(string(a[name].body), "wobble") || strings.Contains(string(a[name].body), "missing-letter") {
			t.Errorf("%s carries the fixture builder", name)
		}
	}
	if !strings.Contains(string(a["debug.js"].body), "missing-letter") {
		t.Error("debug.js lacks the fixture builder")
	}
}
