package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"calligraphy/internal/account"
	"calligraphy/internal/auth"
)

// sessionCookie carries a browser's session token.
const sessionCookie = "hp_session"

// notices and accountErrors are the only messages a redirect can ask the
// account page to show. The query carries a code, never text, so a crafted
// link cannot put words on the page.
var notices = map[string]string{
	"signed-out":       "You are signed out.",
	"password-changed": "Your password is changed. Your other devices have been signed out.",
	"revoked":          "That device is signed out.",
}

var accountErrors = map[string]string{
	"wrong-password":    "The current password is not right.",
	"password-mismatch": "The new passwords do not match.",
	"password-short":    auth.ErrPasswordTooShort.Error() + ".",
	"password-long":     auth.ErrPasswordTooLong.Error() + ".",
	"rate-limited":      "Too many attempts. Wait a minute and try again.",
}

// loginFailed is the one message for every failed sign-in: an unknown email,
// a wrong password and a disabled account must be indistinguishable, or the
// form tells anyone which emails have accounts.
const loginFailed = "That email and password do not match an account."

// accountView is the account page's data: exactly one half is set.
type accountView struct {
	SignIn *loginPage
	Signed *accountPage
}

type loginPage struct {
	Email, Next, Error string
}

type accountPage struct {
	User      account.User
	Sessions  []account.Session
	CurrentID int64
	Notice    string
	Error     string
}

// currentUser resolves the request's session cookie. Only the account,
// admin and API routes call it: the page shells stay identical for everyone,
// which is what lets the service worker cache them.
func (s *Server) currentUser(r *http.Request) (account.User, account.Session, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return account.User{}, account.Session{}, false
	}
	u, sess, err := s.accounts.Authenticate(r.Context(), c.Value)
	if err != nil {
		if !errors.Is(err, account.ErrNotFound) {
			s.log.Error("authenticate", "err", err)
		}
		return account.User{}, account.Session{}, false
	}
	return u, sess, true
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		// Browsers accept Secure cookies from http://localhost, so this holds
		// in development too.
		Secure: true,
		// Lax, hard-coded: the cookie signs in an account (and an admin), so it
		// must never ride along on another site's cross-site POST.
		SameSite: http.SameSiteLaxMode,
		// The browser's maximum. The server's own expiry (90 days, sliding)
		// decides when the session ends; the cookie only has to outlive it.
		MaxAge: 400 * 24 * 60 * 60,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true,
		Secure: true, SameSite: http.SameSiteLaxMode, MaxAge: -1})
}

// safeNext keeps a post-sign-in redirect on this site: a path, never
// "//evil.example" or "/\evil.example", which browsers read as another host.
func safeNext(next string) string {
	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/\\") {
		return ""
	}
	return next
}

func (s *Server) accountGet(w http.ResponseWriter, r *http.Request) {
	u, sess, ok := s.currentUser(r)
	if !ok {
		s.renderData(w, http.StatusOK, "account.html", "Sign in", accountView{SignIn: &loginPage{Next: safeNext(r.URL.Query().Get("next"))}})
		return
	}
	sessions, err := s.accounts.Sessions(r.Context(), u.ID)
	if err != nil {
		s.serverError(w, err)
		return
	}
	q := r.URL.Query()
	s.renderData(w, http.StatusOK, "account.html", "Account", accountView{Signed: &accountPage{
		User: u, Sessions: sessions, CurrentID: sess.ID,
		Notice: notices[q.Get("notice")], Error: accountErrors[q.Get("error")],
	}})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	email := strings.TrimSpace(r.PostFormValue("email"))
	password := r.PostFormValue("password")
	next := safeNext(r.PostFormValue("next"))
	fail := func(status int, msg string) {
		s.renderData(w, status, "account.html", "Sign in", accountView{SignIn: &loginPage{Email: email, Next: next, Error: msg}})
	}
	if !s.allowLogin(r, email) {
		fail(http.StatusTooManyRequests, accountErrors["rate-limited"])
		return
	}
	u, err := s.checkPassword(r, email, password)
	if err != nil {
		if errors.Is(err, errBadCredentials) {
			fail(http.StatusUnauthorized, loginFailed)
		} else {
			s.serverError(w, err)
		}
		return
	}
	token, _, err := s.accounts.CreateSession(r.Context(), u.ID, account.KindWeb, browserLabel(r.UserAgent()))
	if err != nil {
		s.serverError(w, err)
		return
	}
	s.accounts.RecordLogin(r.Context(), u.ID)
	s.setSessionCookie(w, token)
	if next == "" {
		next = "/account"
	}
	http.Redirect(w, r, next, http.StatusSeeOther)
}

var errBadCredentials = errors.New("bad credentials")

// allowLogin applies both sign-in limits. The tight one is keyed on the
// email, which an attacker cannot shed the way they can a cookie; the looser
// per-IP ceiling stops one address spraying many emails.
func (s *Server) allowLogin(r *http.Request, email string) bool {
	return s.limits.loginIP.Allow(s.clientIP(r)) && s.limits.loginEmail.Allow(strings.ToLower(email))
}

// checkPassword is the one place a sign-in is decided, shared by the web
// form and the app's token endpoint. Every failure costs one argon2 verify
// and returns errBadCredentials, whatever the cause.
func (s *Server) checkPassword(r *http.Request, email, password string) (account.User, error) {
	u, err := s.accounts.ByEmail(r.Context(), email)
	if errors.Is(err, account.ErrNotFound) {
		auth.SpendVerifyTime(password)
		return account.User{}, errBadCredentials
	}
	if err != nil {
		return account.User{}, err
	}
	ok, err := auth.VerifyPassword(password, u.PasswordHash)
	if err != nil {
		return account.User{}, err
	}
	// Disabled is checked after the password, so a disabled account answers
	// exactly as a wrong password does.
	if !ok || u.Disabled {
		return account.User{}, errBadCredentials
	}
	return u, nil
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		if err := s.accounts.RevokeToken(r.Context(), c.Value); err != nil {
			s.serverError(w, err)
			return
		}
	}
	clearSessionCookie(w)
	http.Redirect(w, r, "/account?notice=signed-out", http.StatusSeeOther)
}

// requireUser wraps a POST that needs a signed-in user. Anyone else is sent
// to the sign-in page and nothing is done.
func (s *Server) requireUser(next func(http.ResponseWriter, *http.Request, account.User, account.Session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, sess, ok := s.currentUser(r)
		if !ok {
			http.Redirect(w, r, "/account", http.StatusSeeOther)
			return
		}
		next(w, r, u, sess)
	}
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request, u account.User, sess account.Session) {
	back := func(code string) {
		http.Redirect(w, r, "/account?error="+code+"#password", http.StatusSeeOther)
	}
	// Limited like sign-in: a form that checks the current password is a
	// guessing oracle for anyone holding a stolen cookie.
	if !s.limits.loginIP.Allow(s.clientIP(r)) || !s.limits.password.Allow(strconv.FormatInt(u.ID, 10)) {
		back("rate-limited")
		return
	}
	ok, err := auth.VerifyPassword(r.PostFormValue("current"), u.PasswordHash)
	if err != nil {
		s.serverError(w, err)
		return
	}
	if !ok {
		back("wrong-password")
		return
	}
	pw := r.PostFormValue("new")
	if pw != r.PostFormValue("confirm") {
		back("password-mismatch")
		return
	}
	switch auth.CheckPolicy(pw) {
	case auth.ErrPasswordTooShort:
		back("password-short")
		return
	case auth.ErrPasswordTooLong:
		back("password-long")
		return
	}
	hash, err := auth.HashPassword(pw)
	if err != nil {
		s.serverError(w, err)
		return
	}
	if err := s.accounts.SetPassword(r.Context(), u.ID, hash, sess.ID); err != nil {
		s.serverError(w, err)
		return
	}
	http.Redirect(w, r, "/account?notice=password-changed", http.StatusSeeOther)
}

func (s *Server) revokeSession(w http.ResponseWriter, r *http.Request, u account.User, sess account.Session) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "bad session id", http.StatusBadRequest)
		return
	}
	if err := s.accounts.Revoke(r.Context(), u.ID, id); err != nil {
		s.serverError(w, err)
		return
	}
	if id == sess.ID {
		clearSessionCookie(w)
		http.Redirect(w, r, "/account?notice=signed-out", http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/account?notice=revoked", http.StatusSeeOther)
}

// browserLabel names a web session in the device list ("Firefox on Linux"),
// from the user agent. A rough guess is enough to tell sessions apart.
func browserLabel(ua string) string {
	browser := "A browser"
	for _, b := range []struct{ token, name string }{
		{"Edg/", "Edge"}, {"Firefox/", "Firefox"}, {"Chrome/", "Chrome"}, {"Safari/", "Safari"},
	} {
		if strings.Contains(ua, b.token) {
			browser = b.name
			break
		}
	}
	for _, o := range []struct{ token, name string }{
		{"iPad", "iPad"}, {"iPhone", "iPhone"}, {"Android", "Android"}, {"Mac OS X", "macOS"},
		{"Windows", "Windows"}, {"Linux", "Linux"},
	} {
		if strings.Contains(ua, o.token) {
			return browser + " on " + o.name
		}
	}
	return browser
}

// when formats a stored time for the page, labelled UTC so nobody misreads
// it as their own timezone.
func when(t time.Time) string {
	if t.IsZero() {
		return "never"
	}
	return t.UTC().Format("2 Jan 2006, 15:04 UTC")
}
