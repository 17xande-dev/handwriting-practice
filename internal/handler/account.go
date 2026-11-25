package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"calligraphy/internal/account"
	"calligraphy/internal/auth"

	"github.com/17xande-dev/websec"
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
	Email, Next, Error, Notice string
	// ClearSync loads the script that turns this browser's sync off.
	ClearSync bool
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

// safeNext keeps a post-sign-in redirect on this site. The rules (browsers
// strip tabs and newlines and read a backslash as a slash, so "/\tevil" would
// leave the site) live in websec.SafeRedirect. No Prefix or Deny: any
// same-site page is a fine landing spot, and an empty fallback sends the
// redirect to /account.
func safeNext(next string) string {
	return websec.SafeRedirect(next, websec.RedirectOptions{Fallback: ""})
}

func (s *Server) accountGet(w http.ResponseWriter, r *http.Request) {
	u, sess, ok := s.currentUser(r)
	if !ok {
		q := r.URL.Query()
		// Signing out lands here, signed out. This is where the browser also
		// forgets its local sync state (see static/signout.js), so the next
		// person to use it cannot push their history into this account.
		out := q.Get("notice") == "signed-out"
		s.renderData(w, http.StatusOK, "account.html", "Sign in", accountView{SignIn: &loginPage{
			Next: safeNext(q.Get("next")), Notice: notices[q.Get("notice")], ClearSync: out,
		}})
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
	if !parseForm(w, r, maxFormBody) {
		return
	}
	rawEmail := strings.TrimSpace(r.PostForm.Get("email"))
	password := r.PostForm.Get("password")
	next := safeNext(r.PostForm.Get("next"))
	fail := func(status int, msg string) {
		s.renderData(w, status, "account.html", "Sign in", accountView{SignIn: &loginPage{Email: rawEmail, Next: next, Error: msg}})
	}
	// A malformed email never reaches the limiter, so junk cannot fill its map
	// or cost an argon2 verify.
	email, err := account.NormalizeEmail(rawEmail)
	if err != nil {
		fail(http.StatusBadRequest, "That is not a valid email address.")
		return
	}
	if !s.allowLogin(r, email) {
		fail(http.StatusTooManyRequests, accountErrors["rate-limited"])
		return
	}
	u, rehash, err := s.checkPassword(r, email, password)
	if err != nil {
		if errors.Is(err, errBadCredentials) {
			fail(http.StatusUnauthorized, loginFailed)
		} else {
			s.serverError(w, err)
		}
		return
	}
	token, _, err := s.accounts.SignIn(r.Context(), u, account.KindWeb, browserLabel(r.UserAgent()))
	if err != nil {
		if errors.Is(err, account.ErrStaleCredentials) {
			fail(http.StatusUnauthorized, loginFailed)
			return
		}
		s.serverError(w, err)
		return
	}
	// Signing in over a live session (another account's, say) ends the old
	// one: otherwise it lingers, valid but unreachable, in that account's
	// device list.
	if old, err := r.Cookie(sessionCookie); err == nil && old.Value != token {
		if err := s.accounts.RevokeToken(r.Context(), old.Value); err != nil {
			s.log.Error("revoke previous session", "err", err)
		}
	}
	s.upgradePasswordHash(r.Context(), u, password, rehash)
	s.accounts.RecordLogin(r.Context(), u.ID)
	s.setSessionCookie(w, token)
	if next == "" {
		next = "/account"
	}
	http.Redirect(w, r, next, http.StatusSeeOther)
}

// emailTag identifies an email in the logs without recording it: the first
// bytes of its sha256, enough to correlate attempts on one address.
func emailTag(email string) string {
	sum := sha256.Sum256([]byte(email))
	return hex.EncodeToString(sum[:])[:12]
}

var errBadCredentials = errors.New("bad credentials")

// allowLogin applies both sign-in limits to an already normalised email. The
// tight one is keyed on the email's hash, which an attacker cannot shed the
// way they can a cookie; the looser per-IP ceiling (an IPv6 client counts by
// its /64) stops one address spraying many emails. A request the IP limit
// refused never reaches the email limit: it would otherwise leave a bucket
// per fresh email for as long as buckets live. A refusal is logged.
func (s *Server) allowLogin(r *http.Request, email string) bool {
	ip := s.ipAddr(r)
	ipOK := s.limits.loginIP.Allow(s.ipKey(r))
	emailOK := true
	if ipOK {
		h := sha256.Sum256([]byte(email))
		emailOK = s.limits.loginEmail.Allow(string(h[:]))
	}
	if !ipOK || !emailOK {
		s.log.Warn("sign-in rate limited", "email", emailTag(email), "ip", ip, "path", r.URL.Path,
			"by_ip", !ipOK, "by_email", !emailOK)
	}
	return ipOK && emailOK
}

// checkPassword is the one place a sign-in is decided, shared by the web
// form and the app's token endpoint. Wrong passwords and unknown emails
// each spend one check for inputs within policy. email is normalised.
func (s *Server) checkPassword(r *http.Request, email, pw string) (account.User, bool, error) {
	bad := func(why string) (account.User, bool, error) {
		// Never the password or the email itself; the why is for the operator
		// only, the client sees one message.
		s.log.Warn("sign-in failed", "email", emailTag(email), "ip", s.ipAddr(r), "path", r.URL.Path, "why", why)
		return account.User{}, false, errBadCredentials
	}
	u, err := s.accounts.ByEmail(r.Context(), email)
	if errors.Is(err, account.ErrNotFound) {
		if err := auth.SpendVerifyTime(r.Context(), pw); err != nil {
			return account.User{}, false, err
		}
		return bad("unknown email")
	}
	if err != nil {
		return account.User{}, false, err
	}
	ok, rehash, err := auth.CheckPassword(r.Context(), pw, u.PasswordHash)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return account.User{}, false, err
		}
		return bad("invalid stored password hash")
	}
	// Disabled is checked after the password, so a disabled account answers
	// exactly as a wrong password does.
	if !ok {
		return bad("wrong password")
	}
	if u.Disabled {
		return bad("disabled")
	}
	return u, rehash, nil
}

// Upgrade only after the session has been created so a best-effort rehash
// does not change whether sign-in succeeds.
func (s *Server) upgradePasswordHash(ctx context.Context, u account.User, pw string, rehash bool) {
	if !rehash {
		return
	}
	hash, err := auth.HashPassword(ctx, pw)
	if err == nil {
		err = s.accounts.UpgradePasswordHash(ctx, u.ID, u.PasswordHash, hash)
	}
	if err != nil {
		s.log.Warn("password hash upgrade failed", "user", u.ID, "err", err)
	}
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if !parseForm(w, r, maxFormBody) {
		return
	}
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
		if r.Method == http.MethodPost && !parseForm(w, r, maxPasswordForm) {
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
	if !s.limits.loginIP.Allow(s.ipKey(r)) || !s.limits.password.Allow(strconv.FormatInt(u.ID, 10)) {
		s.log.Warn("password change rate limited", "user", u.ID, "ip", s.ipAddr(r))
		back("rate-limited")
		return
	}
	ok, err := auth.VerifyPassword(r.Context(), r.PostFormValue("current"), u.PasswordHash)
	if err != nil {
		s.serverError(w, err)
		return
	}
	if !ok {
		s.log.Warn("password change failed", "user", u.ID, "ip", s.ipAddr(r))
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
	hash, err := auth.HashPassword(r.Context(), pw)
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
