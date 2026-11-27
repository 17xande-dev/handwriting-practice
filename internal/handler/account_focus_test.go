package handler

import (
	"html"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"
)

// inputTag returns the opening tag of the sign-in form's input with this id.
func inputTag(t *testing.T, body, id string) string {
	t.Helper()
	m := regexp.MustCompile(`<input id="` + id + `"[^>]*>`).FindString(body)
	if m == "" {
		t.Fatalf("no #%s input in the page", id)
	}
	return m
}

// attr reports whether the tag carries the bare attribute.
func hasAttr(tag, name string) bool { return strings.Contains(tag, " "+name) }

// A first visit puts the cursor in the email field.
func TestSignInPageFocusesEmailOnLoad(t *testing.T) {
	s := newAccountServer(t)
	body := s.do(t, "GET", "/account", nil, "").Body
	if !hasAttr(inputTag(t, body, "email"), "autofocus") {
		t.Error("email field is not focused on a fresh page")
	}
	if hasAttr(inputTag(t, body, "password"), "autofocus") {
		t.Error("password field is focused on a fresh page")
	}
}

// After a failed attempt the page comes back with the password focused, the
// email kept (HTML-escaped) and the password never echoed. Every failure
// state follows the same rule, and an unknown email looks like a wrong password.
func TestFailedSignInFocusesPasswordAndKeepsEmail(t *testing.T) {
	s := newAccountServer(t)
	s.addUser(t, "a@x.com", false)
	const secret = "s3cret-Pa55-word-xyz"
	hostile := `"><b>&'@x.com`

	check := func(t *testing.T, email, pw string, status int) {
		t.Helper()
		res := s.do(t, "POST", "/account/login", url.Values{"email": {email}, "password": {pw}}, "")
		if res.Status != status {
			t.Fatalf("status %d, want %d", res.Status, status)
		}
		em, pwTag := inputTag(t, res.Body, "email"), inputTag(t, res.Body, "password")
		if !hasAttr(pwTag, "autofocus") {
			t.Error("password field is not focused")
		}
		if hasAttr(em, "autofocus") {
			t.Error("email field is still focused")
		}
		if !strings.Contains(em, `value="`+html.EscapeString(email)+`"`) {
			t.Errorf("email not kept and escaped in %s", em)
		}
		if strings.Contains(res.Body, pw) {
			t.Error("the submitted password is in the page")
		}
		if strings.Contains(res.Body, "<b>") {
			t.Error("submitted email reached the page unescaped")
		}
	}

	t.Run("wrong password", func(t *testing.T) { check(t, "a@x.com", secret, http.StatusUnauthorized) })
	t.Run("unknown email", func(t *testing.T) { check(t, "nobody@x.com", secret, http.StatusUnauthorized) })
	t.Run("malformed email", func(t *testing.T) { check(t, hostile, secret, http.StatusBadRequest) })
	t.Run("rate limited", func(t *testing.T) {
		for range 5 {
			s.do(t, "POST", "/account/login", url.Values{"email": {"a@x.com"}, "password": {"wrong password!!"}}, "")
		}
		check(t, "a@x.com", secret, http.StatusTooManyRequests)
	})
}
