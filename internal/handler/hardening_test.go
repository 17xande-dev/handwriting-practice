package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"calligraphy/internal/auth"

	"github.com/17xande-dev/websec/webtest"
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
		if loc := rec.Header.Get("Location"); loc != "/account" {
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
	if loc := rec.Header.Get("Location"); loc != "/sheet/arches?x=1" {
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
		if rec := s.do(t, "POST", tc.target, body, tc.cookie); rec.Status != http.StatusRequestEntityTooLarge {
			t.Errorf("%s: status %d, want 413", tc.target, rec.Status)
		}
	}
	// A normal form is unaffected.
	if rec := s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}}, ""); rec.Status != http.StatusSeeOther {
		t.Errorf("normal sign-in: %d", rec.Status)
	}
}

// Malformed emails are refused before the limiter, so junk cannot fill its map.
func TestBadEmailsSkipTheLimiter(t *testing.T) {
	s := newAccountServer(t)
	for _, email := range []string{strings.Repeat("a", 250) + "@x.com", "not an email", "Alex <a@x.com>", ""} {
		rec := s.do(t, "POST", "/account/login", url.Values{"email": {email}, "password": {"whatever password"}}, "")
		if rec.Status != http.StatusBadRequest {
			t.Errorf("email %.20q: status %d, want 400", email, rec.Status)
		}
		rec = s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":%q,"password":"x","label":"l"}`, email), "", "")
		if rec.Status != http.StatusBadRequest {
			t.Errorf("token with email %.20q: status %d, want 400", email, rec.Status)
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

// Test the shared limiter boundary, rather than the web/API email parsers:
// those already normalise valid addresses and would hide a raw-key bypass.
func TestLoginAccountKeySharesNormalisedBucket(t *testing.T) {
	s := newAccountServer(t)
	r := httptest.NewRequest("POST", "/account/login", nil)
	for _, email := range []string{"A@X.com", "a@x.com", " a@x.com", "a@x.com ", " A@X.COM "} {
		if !s.srv.allowLogin(r, email) {
			t.Fatal("the account burst ran out before five attempts")
		}
	}
	if s.srv.allowLogin(r, " A@x.com ") {
		t.Error("case or whitespace got a fresh login bucket")
	}
	if n := s.srv.limits.loginEmail.Len(); n != 1 {
		t.Errorf("%d email buckets, want 1 (variants share one)", n)
	}
}

func TestLoginAccountKeyHashesLongAddress(t *testing.T) {
	s := newAccountServer(t)
	r := httptest.NewRequest("POST", "/account/login", nil)
	email := strings.Repeat("a", 64) + "@" + strings.Repeat("b.", 67) + "example"
	for range 5 {
		if !s.srv.allowLogin(r, email) {
			t.Fatal("the account burst ran out before five attempts")
		}
	}
	hash := sha256.Sum256([]byte(email))
	if !s.srv.limits.loginEmail.Exhausted("sha256:" + hex.EncodeToString(hash[:])) {
		t.Error("the long address did not use the kit's bounded key")
	}
}

// Every address in one IPv6 /64 shares the per-IP bucket.
func TestIPv6ClientsShareTheirSlash64(t *testing.T) {
	s := newAccountServer(t)
	for i := range 10 {
		s.loginFrom(t, fmt.Sprintf("[2001:db8:1:2:%x::1]:4000", i+1), nil, fmt.Sprintf("u%d@x.com", i))
	}
	rec := s.loginFrom(t, "[2001:db8:1:2:ffff::9]:4000", nil, "another@x.com")
	if rec != http.StatusTooManyRequests {
		t.Errorf("11th address in the /64: status %d, want 429", rec)
	}
	// A different /64 is a different bucket.
	if s.loginFrom(t, "[2001:db8:1:3::9]:4000", nil, "another@x.com") == http.StatusTooManyRequests {
		t.Error("another /64 was limited")
	}
}

func TestSignInIsShedWhenPasswordQueueExpires(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	auth.ExpirePasswordQueueForTest(t)
	for _, email := range []string{"a@x.com", "unknown@x.com"} {
		rec := s.do(t, "POST", "/account/login", url.Values{"email": {email}, "password": {testPassword}}, "")
		if rec.Status != http.StatusServiceUnavailable || rec.Header.Get("Retry-After") != "5" {
			t.Errorf("form (%s): status %d, Retry-After %q", email, rec.Status, rec.Header.Get("Retry-After"))
		}
	}
	rec := s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":"a@x.com","password":%q}`, testPassword), "", "")
	if rec.Status != http.StatusServiceUnavailable || rec.Header.Get("Retry-After") != "5" ||
		!strings.HasPrefix(rec.Header.Get("Content-Type"), "application/json") || !strings.Contains(rec.Body, "busy") {
		t.Errorf("token: status %d, headers %v, body %s", rec.Status, rec.Header, rec.Body)
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
	if rec.Status != http.StatusServiceUnavailable || rec.Header.Get("Retry-After") != "5" {
		t.Fatalf("admin reset: status %d, Retry-After %q", rec.Status, rec.Header.Get("Retry-After"))
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

func TestFailedSignInsAndLimitsAreLoggedWithoutSecrets(t *testing.T) {
	s := newAccountServer(t)
	log, logs := webtest.Logger(t)
	s.srv.log = log
	s.addUser(t, "a@x.com", false)
	const longEmail = "someone.long@example.com" // NoSecrets needs at least 12 bytes
	s.addUser(t, longEmail, false)
	for range 6 {
		s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {"hunter2 hunter2 hunter2"}}, "")
	}
	s.do(t, "POST", "/account/login", url.Values{"email": {longEmail}, "password": {"hunter2 hunter2 hunter2"}}, "")
	out := logs.String()
	if !strings.Contains(out, "sign-in failed") || !strings.Contains(out, "sign-in rate limited") {
		t.Fatalf("missing log lines:\n%s", out)
	}
	if !strings.Contains(out, emailTag("a@x.com")) || !strings.Contains(out, "192.0.2.1") {
		t.Errorf("log lacks the email hash prefix or the client IP:\n%s", out)
	}
	// The short address and its plain check are kept; NoSecrets adds the
	// encoded forms (base64, hex, escapes) for the password and the longer
	// address, which meets its 12-byte minimum.
	for _, secret := range []string{"hunter2", "a@x.com"} {
		if strings.Contains(out, secret) {
			t.Errorf("log contains %q:\n%s", secret, out)
		}
	}
	webtest.NoSecrets(t, out, "sign-in failed", "hunter2 hunter2 hunter2", longEmail)
	if !regexp.MustCompile(`"email":"[0-9a-f]{12}"`).MatchString(out) {
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
	if rec.Status != http.StatusSeeOther {
		t.Fatalf("second sign-in: %d", rec.Status)
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
	body := s.do(t, "GET", "/account?notice=signed-out", nil, "").Body
	m := regexp.MustCompile(`<script type="module" src="(/static/signout\.js\?v=[0-9a-f]+)"`).FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("signed-out page lacks signout.js:\n%s", body)
	}
	if !strings.Contains(body, "You are signed out.") {
		t.Error("signed-out notice missing")
	}
	res, js := get(t, s.routes, m[1])
	if res.Status != 200 || !strings.Contains(js, "italic-practice") && len(js) == 0 {
		t.Errorf("signout.js: %d, %d bytes", res.Status, len(js))
	}
	if body := s.do(t, "GET", "/account", nil, "").Body; strings.Contains(body, "signout.js") {
		t.Error("the plain sign-in page clears sync state")
	}
	// Logging out and revoking this browser's own session both land on it.
	s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, "a@x.com", testPassword)
	rec := s.do(t, "POST", "/account/logout", url.Values{}, cookie)
	if loc := rec.Header.Get("Location"); loc != "/account?notice=signed-out" {
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

// A sign-in whose password check passed, then overlapped a password reset
// (which deletes sessions), must answer 401 and must not end up holding a
// session. A 500 would make the iPad treat a credential change as a server
// fault instead of asking for the new password.
func TestSignInDoesNotOutliveAPasswordReset(t *testing.T) {
	for _, via := range []string{"web", "token"} {
		t.Run(via, func(t *testing.T) {
			s := newAccountServer(t)
			u := s.addUser(t, "a@x.com", false)
			hash, err := auth.HashPassword(t.Context(), "a brand new password")
			if err != nil {
				t.Fatal(err)
			}
			s.srv.afterVerify = func() {
				if err := s.accounts.SetPassword(t.Context(), u.ID, hash, 0); err != nil {
					t.Error(err)
				}
			}
			var code int
			if via == "web" {
				code = s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {testPassword}}, "").Status
			} else {
				code = s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":"a@x.com","password":%q,"label":"l"}`, testPassword), "", "").Status
			}
			if code != http.StatusUnauthorized {
				t.Errorf("sign-in over a reset: %d, want 401", code)
			}
			var n int
			if err := s.db.QueryRow(`SELECT count(*) FROM auth_sessions WHERE user_id = ?`, u.ID).Scan(&n); err != nil || n != 0 {
				t.Errorf("%d sessions after the racing sign-in (err %v), want 0", n, err)
			}
		})
	}
}
