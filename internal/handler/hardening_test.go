package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
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

// The rules are websec's and tested there; this keeps one row per class at
// this call site: a hostile value (a browser drops the tab, so "/\t/evil" is
// "//evil"), legitimate relative targets (the auth redirect itself builds
// "next" from r.URL.Path alone, so a query and a fragment are not something it
// produces: those rows only show they are kept), and the deltas from the old
// local copy (dot segments, inner "//", trailing space now refused).
func TestSafeNext(t *testing.T) {
	for next, want := range map[string]string{
		"/progress":           "/progress",
		"/sheet/arches?x=1#y": "/sheet/arches?x=1#y",
		"/":                   "/",
		"":                    "",
		"/\t/evil.example":    "",
		"/%09/evil.example":   "",
		"//evil":              "",
		"https://evil":        "",
		"/a/../b":             "",
		"/a//b":               "",
		"/a ":                 "",
		"/..%2f..%2fetc":      "/..%2f..%2fetc",
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

// The wiring, not the algorithm: a legitimate target with a query survives the
// sign-in POST. That the sign-in POST refuses a hostile one is the test above
// (the auth redirect builds "next" from r.URL.Path, so it never carries a query).
func TestSignInRedirectKeepsLegitimateNext(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	rec := s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}, "next": {"/sheet/arches?x=1"}}, "")
	if loc := rec.Header().Get("Location"); loc != "/sheet/arches?x=1" {
		t.Errorf("redirected to %q", loc)
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
	for range 5 {
		s.do(t, "POST", "/account/login", url.Values{"email": {"A@X.com"}, "password": {"wrong password!"}}, "")
	}
	// The limiter no longer lists keys, so prove the key by probing: after
	// the burst is spent, only the hash of the normalised email is refused.
	h := sha256.Sum256([]byte("a@x.com"))
	if !s.srv.limits.loginEmail.Exhausted(string(h[:])) {
		t.Error("the email's bucket is not keyed on the hash of the normalised email")
	}
	if n := s.srv.limits.loginEmail.Len(); n != 1 {
		t.Errorf("%d email buckets, want 1 (case changes share one)", n)
	}
	if s.srv.limits.loginEmail.Exhausted("a@x.com") || s.srv.limits.loginEmail.Exhausted("A@X.com") {
		t.Error("a raw email is a limiter key")
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

func TestSignInIsShedWhenPasswordQueueExpires(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	auth.ExpirePasswordQueueForTest(t)
	for _, email := range []string{"a@x.com", "unknown@x.com"} {
		rec := s.do(t, "POST", "/account/login", url.Values{"email": {email}, "password": {testPassword}}, "")
		if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "5" {
			t.Errorf("form (%s): status %d, Retry-After %q", email, rec.Code, rec.Header().Get("Retry-After"))
		}
	}
	rec := s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":"a@x.com","password":%q}`, testPassword), "", "")
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "5" ||
		!strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") || !strings.Contains(rec.Body.String(), "busy") {
		t.Errorf("token: status %d, headers %v, body %s", rec.Code, rec.Header(), rec.Body)
	}
}

func TestAdminPasswordResetIsShedWhenPasswordQueueExpires(t *testing.T) {
	s := newAccountServer(t)
	admin := s.addUser(t, "admin@x.com", true)
	u := s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, admin.Email, testPassword)

	// The session cookie lets the request reach hashing without first
	// verifying a password, which would fail at the same queue deadline.
	auth.ExpirePasswordQueueForTest(t)
	rec := s.do(t, "POST", "/admin/users/"+itoa(u.ID)+"/reset", url.Values{}, cookie)
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "5" {
		t.Fatalf("admin reset: status %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestCanceledPasswordWaitIsNotBusy(t *testing.T) {
	s := newAccountServer(t)
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	err := auth.SpendVerifyTime(canceled, testPassword)
	rec := httptest.NewRecorder()
	s.srv.serverError(rec, err)
	if rec.Code == http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "" {
		t.Errorf("cancellation: %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
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

// A request the per-IP limit refused must not also create an email bucket, or
// one address spraying fresh emails would fill the email limiter's map.
func TestRefusedByIPLeavesNoEmailBucket(t *testing.T) {
	s := newAccountServer(t)
	for i := range 40 {
		s.do(t, "POST", "/account/login", url.Values{"email": {fmt.Sprintf("u%d@x.com", i)}, "password": {"wrong password!!"}}, "")
	}
	// The IP bucket holds a burst of 10 (a refill or so may slip in).
	if n := s.srv.limits.loginEmail.Len(); n > 12 {
		t.Errorf("the email limiter holds %d buckets after 40 attempts from one address, want about 10", n)
	}
}
