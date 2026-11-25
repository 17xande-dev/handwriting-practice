package account_test

import (
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"calligraphy/internal/account"
	"calligraphy/internal/auth"
	"calligraphy/internal/dbtest"
	"calligraphy/internal/fonts"
	"calligraphy/internal/handler"
	"calligraphy/internal/history"

	"github.com/17xande-dev/websec/session/sessiontest"
)

const (
	suitePassword = "one test-only passphrase"
	suiteCookie   = "__Host-hp_session"
)

type sessionSuite struct {
	db    *sql.DB
	store *account.Store
}

func newSessionSuite(t *testing.T) sessionSuite {
	db := dbtest.New(t)
	return sessionSuite{db: db, store: account.NewStore(db, account.DefaultLifetimes())}
}

func (s sessionSuite) routes(t *testing.T) http.Handler {
	t.Helper()
	h, err := handler.New(handler.Options{
		Accounts: s.store, History: history.NewStore(s.db), Fonts: fonts.Builtin,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)), CookieSecure: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func sessionRequest(h http.Handler, method, path, contentType, body, cookie, bearer string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "https://suite.example.test"+path, strings.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: suiteCookie, Value: cookie})
	}
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func sessionForm(h http.Handler, path string, form url.Values, cookie string) *httptest.ResponseRecorder {
	return sessionRequest(h, http.MethodPost, path, "application/x-www-form-urlencoded", form.Encode(), cookie, "")
}

func (s sessionSuite) create(t *testing.T, kind, email string) string {
	t.Helper()
	// The suite issues 100 tokens for one address. Use a fresh router for
	// each independent sign-in so it exercises the real login without
	// minting fake tokens, disabling the limiter, or waiting for refills.
	h := s.routes(t)
	if kind == account.KindWeb {
		w := sessionForm(h, "/account/login", url.Values{"email": {email}, "password": {suitePassword}}, "")
		if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/account" {
			t.Fatalf("web login: status %d, want 303 to /account", w.Code)
		}
		for _, c := range w.Result().Cookies() {
			if c.Name == suiteCookie && c.Value != "" {
				return c.Value
			}
		}
		t.Fatal("web login did not issue the session cookie")
	}
	body, err := json.Marshal(map[string]string{"email": email, "password": suitePassword, "label": "Test iPad"})
	if err != nil {
		t.Fatal(err)
	}
	w := sessionRequest(h, http.MethodPost, "/api/token", "application/json", string(body), "", "")
	var reply struct{ Token, Email string }
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &reply) != nil || reply.Token == "" || reply.Email != email {
		t.Fatalf("device login: status %d, want 200 with a token for the right account", w.Code)
	}
	return reply.Token
}

// Derive the stored hash independently of the store, so a change in what
// gets persisted cannot hide behind a matching change in the adapter.
func sessionHash(token string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(token))) }

func sessionStamp(ts time.Time) string { return ts.UTC().Format(time.RFC3339) }

func (s sessionSuite) backdate(t *testing.T, token string, created, lastUsed time.Time, expiry string) {
	t.Helper()
	res, err := s.db.Exec(`UPDATE auth_sessions SET created_at = ?, last_used_at = ?, expires_at = ? WHERE token_hash = ?`,
		sessionStamp(created), sessionStamp(lastUsed), expiry, sessionHash(token))
	if err != nil {
		t.Fatal(err)
	}
	if n, err := res.RowsAffected(); n != 1 || err != nil {
		t.Fatalf("backdated %d rows: %v", n, err)
	}
}

func (s sessionSuite) rawRows(t *testing.T) []string {
	t.Helper()
	rows, err := s.db.Query(`SELECT id, token_hash, user_id, kind, label, created_at, last_used_at, expires_at FROM auth_sessions`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id, userID int64
		var hash, kind, label, created, lastUsed, expires string
		if err := rows.Scan(&id, &hash, &userID, &kind, &label, &created, &lastUsed, &expires); err != nil {
			t.Fatal(err)
		}
		out = append(out, fmt.Sprintf("%d|%s|%d|%s|%s|%s|%s|%s", id, hash, userID, kind, label, created, lastUsed, expires))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSessionStoreConformance(t *testing.T) {
	for _, kind := range []string{account.KindWeb, account.KindDevice} {
		t.Run(kind, func(t *testing.T) {
			s := newSessionSuite(t)
			h := s.routes(t)
			hash, err := auth.HashPassword(t.Context(), suitePassword)
			if err != nil {
				t.Fatal(err)
			}
			admin, err := s.store.Create(t.Context(), "admin@example.test", hash, true)
			if err != nil {
				t.Fatal(err)
			}
			adminCookie := s.create(t, account.KindWeb, admin.Email)
			users := map[string]int64{}
			// Pick the expected policy independently of kind dispatch.
			life := account.DefaultLifetimes().Web
			if kind == account.KindDevice {
				life = account.DefaultLifetimes().Device
			}
			adminAction := func(t *testing.T, email, action, notice string) {
				t.Helper()
				w := sessionForm(h, fmt.Sprintf("/admin/users/%d/%s", users[email], action), nil, adminCookie)
				if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/admin/users?notice="+notice {
					t.Fatalf("admin %s: status %d, want 303 with %s notice", action, w.Code, notice)
				}
			}
			tests := sessiontest.Harness{
				Lifetime: life, TouchEvery: time.Hour,
				// Both lookups pass through HTTP headers. The cookie and
				// bearer transports cannot carry NUL/newline in a token;
				// test truncated and extended tokens instead.
				CookieTokens: true,
				NewUser: func(t *testing.T) string {
					t.Helper()
					email := fmt.Sprintf("suite-%d@example.test", len(users)+1)
					u, err := s.store.Create(t.Context(), email, hash, false)
					if err != nil {
						t.Fatal(err)
					}
					users[email] = u.ID
					return email
				},
				Create: func(t *testing.T, email string) string { return s.create(t, kind, email) },
				Lookup: func(t *testing.T, token string) (string, bool, error) {
					cookie, bearer := token, ""
					if kind == account.KindDevice {
						cookie, bearer = "", token
					}
					w := sessionRequest(h, http.MethodGet, "/api/me", "", "", cookie, bearer)
					switch w.Code {
					case http.StatusUnauthorized:
						return "", false, nil
					case http.StatusOK:
						var reply struct{ Email string }
						err := json.Unmarshal(w.Body.Bytes(), &reply)
						return reply.Email, err == nil, err
					default:
						return "", false, fmt.Errorf("GET /api/me: status %d", w.Code)
					}
				},
				Backdate: func(t *testing.T, token string, created, lastUsed time.Time) {
					s.backdate(t, token, created, lastUsed, sessionStamp(life.ExpiresAt(created, lastUsed)))
				},
				LastSeen: func(t *testing.T, token string) time.Time {
					t.Helper()
					var value string
					if err := s.db.QueryRow(`SELECT last_used_at FROM auth_sessions WHERE token_hash = ?`, sessionHash(token)).Scan(&value); err != nil {
						t.Fatal(err)
					}
					ts, err := time.Parse(time.RFC3339, value)
					if err != nil {
						t.Fatal(err)
					}
					return ts
				},
				Count: func(t *testing.T) int {
					t.Helper()
					var n int
					if err := s.db.QueryRow(`SELECT count(*) FROM auth_sessions`).Scan(&n); err != nil {
						t.Fatal(err)
					}
					return n
				},
				RawRows: s.rawRows,
				Sweep: func(t *testing.T) int {
					t.Helper()
					n, err := s.store.DeleteExpired(t.Context())
					if err != nil {
						t.Fatal(err)
					}
					return int(n)
				},
				Disable:    func(t *testing.T, email string) { adminAction(t, email, "disable", "disabled") },
				RevokeUser: func(t *testing.T, email string) { adminAction(t, email, "signout", "signed-out") },
			}
			if kind == account.KindWeb {
				tests.ChangePassword = func(t *testing.T, email, current string) string {
					t.Helper()
					device := s.create(t, account.KindDevice, email)
					const next = "another test-only passphrase"
					w := sessionForm(h, "/account/password", url.Values{"current": {suitePassword}, "new": {next}, "confirm": {next}}, current)
					if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/account?notice=password-changed" {
						t.Fatalf("change password: status %d, want 303 with password-changed notice", w.Code)
					}
					w = sessionRequest(h, http.MethodGet, "/api/me", "", "", "", device)
					if w.Code != http.StatusUnauthorized {
						t.Fatalf("device after own password change: status %d, want 401", w.Code)
					}
					return current
				}
			} else {
				tests.NotApplicable = map[sessiontest.Case]string{
					sessiontest.CasePasswordChange: "own password change runs only from a browser session; device rows end via the web harness case and TestSetPasswordEndsOtherSessions",
				}
			}
			sessiontest.Run(t, tests)
		})
	}
}

func TestExpiredLegacyDeviceTokenReturns401(t *testing.T) {
	s := newSessionSuite(t)
	hash, err := auth.HashPassword(t.Context(), suitePassword)
	if err != nil {
		t.Fatal(err)
	}
	u, err := s.store.Create(t.Context(), "device@example.test", hash, false)
	if err != nil {
		t.Fatal(err)
	}
	h := s.routes(t)
	t.Run("blank-stored-expiry", func(t *testing.T) {
		token := s.create(t, account.KindDevice, u.Email)
		now := time.Now()
		// Before this release, a blank expiry meant a device never expired.
		s.backdate(t, token, now.Add(-366*24*time.Hour), now.Add(-time.Minute), "")
		w := sessionRequest(h, http.MethodPost, "/api/sync", "application/json", `{}`, "", token)
		if w.Code != http.StatusUnauthorized || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("sync with expired legacy device: status %d, want non-cacheable 401", w.Code)
		}
	})
	t.Run("active-despite-stale-stored-expiry", func(t *testing.T) {
		token := s.create(t, account.KindDevice, u.Email)
		now := time.Now()
		s.backdate(t, token, now.Add(-200*24*time.Hour), now.Add(-time.Minute), sessionStamp(now.Add(-time.Hour)))
		w := sessionRequest(h, http.MethodGet, "/api/me", "", "", "", token)
		if w.Code != http.StatusOK {
			t.Fatalf("active device with stale stored expiry: status %d, want 200", w.Code)
		}
	})
}
