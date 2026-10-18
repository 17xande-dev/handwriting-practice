package handler

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"calligraphy/internal/account"
	"calligraphy/internal/auth"
)

// The admin area: creating and managing accounts. There is no sign-up, so
// this is how every account after the first comes to exist.

var adminNotices = map[string]string{
	"disabled":    "The account is disabled and signed out everywhere.",
	"enabled":     "The account is enabled.",
	"promoted":    "The account is now an admin.",
	"demoted":     "The account is no longer an admin.",
	"signed-out":  "The account is signed out on every device.",
	"deleted":     "The account and its history are deleted.",
	"last-admin":  "That would leave no enabled admin, so nothing was changed.",
	"self":        "You can't do that to your own account here.",
	"not-found":   "That account no longer exists.",
	"bad-request": "That request was not understood.",
}

type adminUsersPage struct {
	Users  []account.UserSummary
	SelfID int64
	Notice string
	// Create form state, kept when the form is refused.
	Email, Error string
	Admin        bool
}

// adminPasswordPage shows a generated password, once.
type adminPasswordPage struct {
	Email    string
	Password string
	Created  bool
}

type adminDeletePage struct {
	User account.User
}

// requireAdmin wraps an admin route. Someone signed out is sent to sign in;
// someone signed in without the role gets the same 404 as a path that does
// not exist, so the area does not announce itself.
func (s *Server) requireAdmin(next func(http.ResponseWriter, *http.Request, account.User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, _, ok := s.currentUser(r)
		if !ok {
			target := "/account"
			if r.Method == http.MethodGet {
				target = "/account?next=" + url.QueryEscape(r.URL.Path)
			}
			http.Redirect(w, r, target, http.StatusSeeOther)
			return
		}
		if !u.IsAdmin {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodPost && !parseForm(w, r, maxFormBody) {
			return
		}
		next(w, r, u)
	}
}

// adminHeaders marks every response under /admin, its 404s included, as
// never to be indexed or cached: the pages list people's emails.
func adminHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/admin" || strings.HasPrefix(r.URL.Path, "/admin/") {
			w.Header().Set("X-Robots-Tag", "noindex")
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request, me account.User) {
	s.renderAdminUsers(w, r, me, http.StatusOK, adminUsersPage{Notice: adminNotices[r.URL.Query().Get("notice")]})
}

func (s *Server) renderAdminUsers(w http.ResponseWriter, r *http.Request, me account.User, status int, page adminUsersPage) {
	users, err := s.accounts.List(r.Context())
	if err != nil {
		s.serverError(w, err)
		return
	}
	page.Users, page.SelfID = users, me.ID
	s.renderData(w, status, "admin_users.html", "Accounts", page)
}

// adminCreate makes an account with a generated password and shows that
// password on this response, once. There is no redirect: a redirect would
// need the password in the URL (history, logs) or stored somewhere to show
// it after.
func (s *Server) adminCreate(w http.ResponseWriter, r *http.Request, me account.User) {
	email := strings.TrimSpace(r.PostFormValue("email"))
	admin := r.PostFormValue("admin") == "1"
	refuse := func(status int, msg string) {
		s.renderAdminUsers(w, r, me, status, adminUsersPage{Email: email, Admin: admin, Error: msg})
	}
	pw := auth.GeneratePassword()
	hash, err := auth.HashPassword(pw)
	if err != nil {
		s.serverError(w, err)
		return
	}
	u, err := s.accounts.Create(r.Context(), email, hash, admin)
	switch {
	case errors.Is(err, account.ErrBadEmail):
		refuse(http.StatusBadRequest, "That is not a valid email address.")
		return
	case errors.Is(err, account.ErrExists):
		refuse(http.StatusConflict, "There is already an account for that email.")
		return
	case err != nil:
		s.serverError(w, err)
		return
	}
	s.log.Info("account created", "by", me.Email, "user", u.Email, "admin", admin)
	s.renderData(w, http.StatusOK, "admin_password.html", "New account", adminPasswordPage{Email: u.Email, Password: pw, Created: true})
}

// adminTarget reads the {id} in the path and loads that user. An admin
// acting on their own account is refused for the destructive actions: the
// account page is where you manage yourself, and it keeps an admin from
// locking themselves out with one click.
func (s *Server) adminTarget(w http.ResponseWriter, r *http.Request, me account.User, allowSelf bool) (account.User, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		adminRedirect(w, r, "bad-request")
		return account.User{}, false
	}
	if id == me.ID && !allowSelf {
		adminRedirect(w, r, "self")
		return account.User{}, false
	}
	u, err := s.accounts.ByID(r.Context(), id)
	if errors.Is(err, account.ErrNotFound) {
		adminRedirect(w, r, "not-found")
		return account.User{}, false
	}
	if err != nil {
		s.serverError(w, err)
		return account.User{}, false
	}
	return u, true
}

func adminRedirect(w http.ResponseWriter, r *http.Request, notice string) {
	http.Redirect(w, r, "/admin/users?notice="+notice, http.StatusSeeOther)
}

func (s *Server) adminReset(w http.ResponseWriter, r *http.Request, me account.User) {
	u, ok := s.adminTarget(w, r, me, false)
	if !ok {
		return
	}
	pw := auth.GeneratePassword()
	hash, err := auth.HashPassword(pw)
	if err != nil {
		s.serverError(w, err)
		return
	}
	// Ends every session: whoever knew the old password is out.
	if err := s.accounts.SetPassword(r.Context(), u.ID, hash, 0); err != nil {
		s.serverError(w, err)
		return
	}
	s.log.Info("password reset", "by", me.Email, "user", u.Email)
	s.renderData(w, http.StatusOK, "admin_password.html", "New password", adminPasswordPage{Email: u.Email, Password: pw})
}

// adminAction builds the one-step POST actions. Each changes one thing and
// redirects back to the list with a notice.
func (s *Server) adminAction(do func(r *http.Request, u account.User) error, notice string) func(http.ResponseWriter, *http.Request, account.User) {
	return func(w http.ResponseWriter, r *http.Request, me account.User) {
		u, ok := s.adminTarget(w, r, me, false)
		if !ok {
			return
		}
		err := do(r, u)
		switch {
		case errors.Is(err, account.ErrLastAdmin):
			adminRedirect(w, r, "last-admin")
		case errors.Is(err, account.ErrNotFound):
			adminRedirect(w, r, "not-found")
		case err != nil:
			s.serverError(w, err)
		default:
			s.log.Info("account changed", "by", me.Email, "user", u.Email, "change", notice)
			adminRedirect(w, r, notice)
		}
	}
}

func (s *Server) adminDeleteConfirm(w http.ResponseWriter, r *http.Request, me account.User) {
	u, ok := s.adminTarget(w, r, me, false)
	if !ok {
		return
	}
	s.renderData(w, http.StatusOK, "admin_delete.html", "Delete account", adminDeletePage{User: u})
}

// registerAdmin registers every admin route. TestAdminRoutesRefuseOthers
// collects them from here, so a route added later is checked too.
func (s *Server) registerAdmin(handle handleFunc) {
	handle("GET /admin/users", s.requireAdmin(s.adminUsers))
	handle("POST /admin/users", s.requireAdmin(s.adminCreate))
	handle("POST /admin/users/{id}/reset", s.requireAdmin(s.adminReset))
	handle("POST /admin/users/{id}/disable", s.requireAdmin(s.adminAction(func(r *http.Request, u account.User) error {
		return s.accounts.SetDisabled(r.Context(), u.ID, true)
	}, "disabled")))
	handle("POST /admin/users/{id}/enable", s.requireAdmin(s.adminAction(func(r *http.Request, u account.User) error {
		return s.accounts.SetDisabled(r.Context(), u.ID, false)
	}, "enabled")))
	handle("POST /admin/users/{id}/promote", s.requireAdmin(s.adminAction(func(r *http.Request, u account.User) error {
		return s.accounts.SetAdmin(r.Context(), u.ID, true)
	}, "promoted")))
	handle("POST /admin/users/{id}/demote", s.requireAdmin(s.adminAction(func(r *http.Request, u account.User) error {
		return s.accounts.SetAdmin(r.Context(), u.ID, false)
	}, "demoted")))
	handle("POST /admin/users/{id}/signout", s.requireAdmin(s.adminAction(func(r *http.Request, u account.User) error {
		return s.accounts.RevokeAll(r.Context(), u.ID)
	}, "signed-out")))
	handle("GET /admin/users/{id}/delete", s.requireAdmin(s.adminDeleteConfirm))
	handle("POST /admin/users/{id}/delete", s.requireAdmin(s.adminAction(func(r *http.Request, u account.User) error {
		return s.accounts.Delete(r.Context(), u.ID)
	}, "deleted")))
	handle("GET /admin/{$}", s.requireAdmin(func(w http.ResponseWriter, r *http.Request, _ account.User) {
		http.Redirect(w, r, "/admin/users", http.StatusSeeOther)
	}))
}
