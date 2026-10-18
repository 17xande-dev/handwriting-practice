package handler

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"calligraphy/internal/auth"
)

// adminRoutes collects every admin route as "METHOD /path", with {id}
// filled in, straight from registerAdmin.
func adminRoutes(t *testing.T, s *testServer, id string) []string {
	t.Helper()
	var routes []string
	s.srv.registerAdmin(func(pattern string, _ http.Handler) {
		routes = append(routes, strings.NewReplacer("{id}", id, "{$}", "").Replace(pattern))
	})
	// A floor, so the sweep below cannot pass by checking nothing.
	if len(routes) < 9 {
		t.Fatalf("only %d admin routes registered", len(routes))
	}
	return routes
}

// Every admin route, by its own method: a GET-only sweep would meet 405s on
// the POST routes and prove nothing.
func TestAdminRoutesRefuseOthers(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "admin@x.com", true)
	member := s.addUser(t, "m@x.com", false)
	cookie := s.signIn(t, "m@x.com", testPassword)
	id := itoa(member.ID)

	for _, route := range adminRoutes(t, s, id) {
		method, path, _ := strings.Cut(route, " ")
		var form url.Values
		if method == "POST" {
			form = url.Values{"email": {"new@x.com"}}
		}
		// Signed out: sent to sign in.
		rec := s.do(t, method, path, form, "")
		if rec.Code != http.StatusSeeOther || !strings.HasPrefix(rec.Header().Get("Location"), "/account") {
			t.Errorf("%s anonymous: %d %s", route, rec.Code, rec.Header().Get("Location"))
		}
		// Signed in without the role: a plain 404, as if nothing were there.
		rec = s.do(t, method, path, form, cookie)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s as a member: %d, want 404", route, rec.Code)
		}
	}
	// None of it happened.
	if _, err := s.accounts.ByEmail(t.Context(), "new@x.com"); err == nil {
		t.Error("a member created an account")
	}
	if u, _ := s.accounts.ByID(t.Context(), member.ID); u.IsAdmin || u.Disabled {
		t.Errorf("a member changed their own account: %+v", u)
	}
}

// Every response under /admin, a 404 included, must stay out of caches and
// search indexes: the pages list people's emails.
func TestAdminHeaders(t *testing.T) {
	s := newAccountServer(t)
	for _, p := range []string{"/admin/users", "/admin/nope"} {
		rec := s.do(t, "GET", p, nil, "")
		if rec.Header().Get("X-Robots-Tag") != "noindex" || rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s: headers %v", p, rec.Header())
		}
	}
	if rec := s.do(t, "GET", "/", nil, ""); rec.Header().Get("X-Robots-Tag") != "" {
		t.Error("public page carries the admin headers")
	}
}

var shownPassword = regexp.MustCompile(`<code>([A-Za-z0-9]{20})</code>`)

// The password on the create response is the only copy, so it must be the
// one that signs in.
func TestAdminCreatesAccountWithWorkingPassword(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "admin@x.com", true)
	cookie := s.signIn(t, "admin@x.com", testPassword)

	rec := s.do(t, "POST", "/admin/users", url.Values{"email": {" New@X.com "}}, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("create: %d", rec.Code)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Error("password page is cacheable")
	}
	m := shownPassword.FindStringSubmatch(rec.Body.String())
	if m == nil {
		t.Fatal("no password shown")
	}
	s.signIn(t, "new@x.com", m[1])
	if u, _ := s.accounts.ByEmail(t.Context(), "new@x.com"); u.IsAdmin {
		t.Error("created as admin without the box ticked")
	}

	rec = s.do(t, "POST", "/admin/users", url.Values{"email": {"NEW@x.com"}}, cookie)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "already an account") {
		t.Errorf("duplicate: %d", rec.Code)
	}
	rec = s.do(t, "POST", "/admin/users", url.Values{"email": {"not an email"}}, cookie)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad email: %d", rec.Code)
	}
	rec = s.do(t, "POST", "/admin/users", url.Values{"email": {"boss@x.com"}, "admin": {"1"}}, cookie)
	if u, _ := s.accounts.ByEmail(t.Context(), "boss@x.com"); rec.Code != 200 || !u.IsAdmin {
		t.Error("admin box ignored")
	}
}

func TestAdminResetPassword(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "admin@x.com", true)
	u := s.addUser(t, "u@x.com", false)
	userCookie := s.signIn(t, "u@x.com", testPassword)
	cookie := s.signIn(t, "admin@x.com", testPassword)

	rec := s.do(t, "POST", "/admin/users/"+itoa(u.ID)+"/reset", url.Values{}, cookie)
	m := shownPassword.FindStringSubmatch(rec.Body.String())
	if m == nil {
		t.Fatalf("no password shown: %d", rec.Code)
	}
	got, _ := s.accounts.ByID(t.Context(), u.ID)
	if ok, _ := auth.VerifyPassword(m[1], got.PasswordHash); !ok {
		t.Error("shown password does not verify")
	}
	if !strings.Contains(s.do(t, "GET", "/account", nil, userCookie).Body.String(), `action="/account/login"`) {
		t.Error("the user's session survived the reset")
	}
}

// The store's last-admin guard must reach the page as a notice, not a 500,
// and an admin cannot disable or delete themselves from the list.
func TestAdminGuards(t *testing.T) {
	s := newAccountServer(t)
	me := s.addUser(t, "admin@x.com", true)
	other := s.addUser(t, "other@x.com", true)
	cookie := s.signIn(t, "admin@x.com", testPassword)

	for _, action := range []string{"disable", "demote", "delete", "reset", "signout"} {
		rec := s.do(t, "POST", "/admin/users/"+itoa(me.ID)+"/"+action, url.Values{}, cookie)
		if loc := rec.Header().Get("Location"); loc != "/admin/users?notice=self" {
			t.Errorf("%s on self: %d %s", action, rec.Code, loc)
		}
	}
	// Disable the other admin, then demote them: fine, they are disabled.
	for _, action := range []string{"disable", "demote", "enable"} {
		rec := s.do(t, "POST", "/admin/users/"+itoa(other.ID)+"/"+action, url.Values{}, cookie)
		if loc := rec.Header().Get("Location"); strings.Contains(loc, "last-admin") || rec.Code != http.StatusSeeOther {
			t.Errorf("%s other: %d %s", action, rec.Code, loc)
		}
	}
	got, _ := s.accounts.ByID(t.Context(), other.ID)
	if got.IsAdmin || got.Disabled {
		t.Errorf("other admin not demoted and re-enabled: %+v", got)
	}
	rec := s.do(t, "POST", "/admin/users/999/disable", url.Values{}, cookie)
	if loc := rec.Header().Get("Location"); loc != "/admin/users?notice=not-found" {
		t.Errorf("missing user: %s", loc)
	}
	rec = s.do(t, "GET", "/admin/users?notice=last-admin", nil, cookie)
	if !strings.Contains(rec.Body.String(), "no enabled admin") {
		t.Error("last-admin notice not shown")
	}
	// Unknown notice codes show nothing.
	if strings.Contains(s.do(t, "GET", "/admin/users?notice=%3Cb%3Ehi", nil, cookie).Body.String(), "&lt;b&gt;hi") {
		t.Error("an unknown notice was echoed")
	}
}

func TestAdminDeleteNeedsConfirmation(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "admin@x.com", true)
	u := s.addUser(t, "u@x.com", false)
	cookie := s.signIn(t, "admin@x.com", testPassword)
	rec := s.do(t, "GET", "/admin/users/"+itoa(u.ID)+"/delete", nil, cookie)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Delete u@x.com?") {
		t.Fatalf("confirm page: %d", rec.Code)
	}
	if _, err := s.accounts.ByID(t.Context(), u.ID); err != nil {
		t.Fatal("the confirm page deleted the account")
	}
	rec = s.do(t, "POST", "/admin/users/"+itoa(u.ID)+"/delete", url.Values{}, cookie)
	if loc := rec.Header().Get("Location"); loc != "/admin/users?notice=deleted" {
		t.Fatalf("delete: %s", loc)
	}
	if _, err := s.accounts.ByID(t.Context(), u.ID); err == nil {
		t.Error("account still exists")
	}
}

// The admin pages are under the same CSP: no inline styles or handlers.
func TestAdminPagesHaveNoInlineContent(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "admin@x.com", true)
	u := s.addUser(t, "u@x.com", false)
	cookie := s.signIn(t, "admin@x.com", testPassword)
	pages := map[string]string{
		"list":     s.do(t, "GET", "/admin/users", nil, cookie).Body.String(),
		"delete":   s.do(t, "GET", "/admin/users/"+itoa(u.ID)+"/delete", nil, cookie).Body.String(),
		"password": s.do(t, "POST", "/admin/users", url.Values{"email": {"n@x.com"}}, cookie).Body.String(),
		"account":  s.do(t, "GET", "/account", nil, cookie).Body.String(),
	}
	onAttr := regexp.MustCompile(`(?i)\son[a-z]+\s*=`)
	styleAttr := regexp.MustCompile(`(?i)\sstyle\s*=`)
	for name, body := range pages {
		if len(body) < 500 {
			t.Errorf("%s: page did not render", name)
		}
		if onAttr.MatchString(body) || styleAttr.MatchString(body) {
			t.Errorf("%s has an inline style or handler", name)
		}
	}
}
