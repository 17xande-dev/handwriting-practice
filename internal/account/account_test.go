package account

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"calligraphy/internal/dbtest"
)

var ctx = context.Background()

func newStore(t *testing.T) *Store {
	t.Helper()
	return NewStore(dbtest.New(t), DefaultLifetimes())
}

func mustCreate(t *testing.T, s *Store, email string, admin bool) User {
	t.Helper()
	u, err := s.Create(ctx, email, "hash", admin)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// The admin types emails by hand; " Alex@X.com" and "alex@x.com" are one
// person and must not become two accounts with two histories.
func TestCreateRefusesDuplicateEmail(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "alex@example.com", false)
	for _, e := range []string{"alex@example.com", "ALEX@example.com", "  Alex@Example.com "} {
		if _, err := s.Create(ctx, e, "h", false); !errors.Is(err, ErrExists) {
			t.Errorf("%q: err = %v, want ErrExists", e, err)
		}
	}
	got, err := s.ByEmail(ctx, "Alex@Example.COM")
	if err != nil || got.ID != u.ID {
		t.Errorf("case-insensitive lookup: %v %v", got, err)
	}
}

func TestCreateRefusesBadEmail(t *testing.T) {
	s := newStore(t)
	for _, e := range []string{"", "nope", "Alex <a@b.c>", "a@b.c, d@e.f"} {
		if _, err := s.Create(ctx, e, "h", false); !errors.Is(err, ErrBadEmail) {
			t.Errorf("%q: err = %v", e, err)
		}
	}
}

// A reset password must lock out whoever knew the old one, on every device.
func TestSetPasswordEndsOtherSessions(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "a@x.com", false)
	keepTok, keep, _ := s.CreateSession(ctx, u.ID, KindWeb, "")
	otherTok, _, _ := s.CreateSession(ctx, u.ID, KindDevice, "iPad")
	if err := s.SetPassword(ctx, u.ID, "new", keep.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Authenticate(ctx, keepTok); err != nil {
		t.Errorf("the session that changed the password was ended: %v", err)
	}
	if _, _, err := s.Authenticate(ctx, otherTok); !errors.Is(err, ErrNotFound) {
		t.Errorf("other session survived: %v", err)
	}
	if err := s.SetPassword(ctx, u.ID, "newer", 0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Authenticate(ctx, keepTok); !errors.Is(err, ErrNotFound) {
		t.Error("an admin reset left a session signed in")
	}
}

func TestLastAdminGuard(t *testing.T) {
	s := newStore(t)
	a := mustCreate(t, s, "a@x.com", true)
	b := mustCreate(t, s, "b@x.com", true)
	member := mustCreate(t, s, "m@x.com", false)

	// Two admins disabling each other: the first succeeds, the second must
	// be refused, or nobody can sign in to undo it.
	if err := s.SetDisabled(ctx, a.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetDisabled(ctx, b.ID, true); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("disabling the last admin: %v", err)
	}
	if err := s.SetAdmin(ctx, b.ID, false); !errors.Is(err, ErrLastAdmin) {
		t.Errorf("demoting the last admin: %v", err)
	}
	if err := s.Delete(ctx, b.ID); !errors.Is(err, ErrLastAdmin) {
		t.Errorf("deleting the last admin: %v", err)
	}
	// A disabled admin does not count and can be changed freely, and members
	// are never guarded.
	if err := s.SetAdmin(ctx, a.ID, false); err != nil {
		t.Errorf("demoting a disabled admin: %v", err)
	}
	if err := s.Delete(ctx, member.ID); err != nil {
		t.Errorf("deleting a member: %v", err)
	}
	if err := s.Delete(ctx, 9999); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleting a missing user: %v", err)
	}
	got, _ := s.ByID(ctx, b.ID)
	if got.Disabled || !got.IsAdmin {
		t.Errorf("the last admin was changed: %+v", got)
	}
}

// Disabling takes effect at once, not at the next sign-in.
func TestDisableEndsSessions(t *testing.T) {
	s := newStore(t)
	mustCreate(t, s, "admin@x.com", true)
	u := mustCreate(t, s, "u@x.com", false)
	tok, _, _ := s.CreateSession(ctx, u.ID, KindDevice, "")
	if err := s.SetDisabled(ctx, u.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Authenticate(ctx, tok); !errors.Is(err, ErrNotFound) {
		t.Error("disabled user still authenticated")
	}
}

func TestTouchDoesNotExtendAbsoluteDeadline(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "u@x.com", false)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	tok, sess, err := s.SignIn(ctx, u, KindWeb, "")
	if err != nil {
		t.Fatal(err)
	}
	absolute := now.Add(90 * 24 * time.Hour)
	read := func() (string, string) {
		t.Helper()
		var lastUsed, expires string
		if err := s.db.QueryRow(`SELECT last_used_at, expires_at FROM auth_sessions WHERE id = ?`, sess.ID).
			Scan(&lastUsed, &expires); err != nil {
			t.Fatal(err)
		}
		return lastUsed, expires
	}
	if last, expiry := read(); last != timestamp(now) || expiry != timestamp(now.Add(30*24*time.Hour)) {
		t.Fatalf("new row: last use %s, expiry %s", last, expiry)
	}
	for _, days := range []int{29, 58, 87} {
		now = sess.CreatedAt.Add(time.Duration(days) * 24 * time.Hour)
		if _, _, err := s.Authenticate(ctx, tok); err != nil {
			t.Fatalf("day %d: %v", days, err)
		}
		want := min(now.Add(30*24*time.Hour).Unix(), absolute.Unix())
		if last, expiry := read(); last != timestamp(now) || expiry != timestamp(time.Unix(want, 0)) {
			t.Fatalf("day %d: last use %s, expiry %s, want expiry %s", days, last, expiry, timestamp(time.Unix(want, 0)))
		}
	}
	now = absolute
	if _, _, err := s.Authenticate(ctx, tok); !errors.Is(err, ErrNotFound) {
		t.Fatalf("session accepted at its absolute deadline: %v", err)
	}
}

// Revoke is scoped to the owner, so a guessed id cannot sign another user out.
func TestRevokeIsScopedToOwner(t *testing.T) {
	s := newStore(t)
	a := mustCreate(t, s, "a@x.com", false)
	b := mustCreate(t, s, "b@x.com", false)
	tok, sess, _ := s.CreateSession(ctx, a.ID, KindWeb, "")
	s.Revoke(ctx, b.ID, sess.ID)
	if _, _, err := s.Authenticate(ctx, tok); err != nil {
		t.Error("another user revoked a's session")
	}
	s.Revoke(ctx, a.ID, sess.ID)
	if _, _, err := s.Authenticate(ctx, tok); !errors.Is(err, ErrNotFound) {
		t.Error("owner could not revoke")
	}
}

func TestListCountsLiveSessions(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "u@x.com", false)
	now := s.Now().UTC().Truncate(time.Second)
	s.now = func() time.Time { return now }
	s.CreateSession(ctx, u.ID, KindWeb, "browser")
	s.CreateSession(ctx, u.ID, KindDevice, "live iPad")
	_, old, err := s.CreateSession(ctx, u.ID, KindDevice, "idle iPad")
	if err != nil {
		t.Fatal(err)
	}
	// Stale values left by the previous binary: the active rows appear
	// expired, and the idle device has no stored expiry at all.
	if _, err := s.db.Exec(`UPDATE auth_sessions SET expires_at = ?`, timestamp(now.Add(-time.Hour))); err != nil {
		t.Fatal(err)
	}
	idle := timestamp(now.Add(-90 * 24 * time.Hour))
	if _, err := s.db.Exec(`UPDATE auth_sessions SET created_at = ?, last_used_at = ?, expires_at = '' WHERE id = ?`,
		idle, idle, old.ID); err != nil {
		t.Fatal(err)
	}
	sessions, err := s.Sessions(ctx, u.ID)
	if err != nil || len(sessions) != 2 || sessions[0].Label != "live iPad" || sessions[1].Label != "browser" {
		t.Errorf("Sessions = %+v, %v; want only the live iPad and browser, newest first", sessions, err)
	}
	list, err := s.List(ctx)
	if err != nil || len(list) != 1 || list[0].Sessions != 2 {
		t.Fatalf("list = %+v, %v", list, err)
	}
}

func TestExpiryFloorsLastUseAtCreation(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "u@x.com", false)
	now := s.Now().UTC().Truncate(time.Second)
	s.now = func() time.Time { return now }
	tok, sess, err := s.SignIn(ctx, u, KindWeb, "")
	if err != nil {
		t.Fatal(err)
	}
	// A clock moved back after sign-in. Authentication repairs last use;
	// the list and sweep must keep that session until creation + idle.
	now = now.Add(-2 * time.Hour)
	if _, _, err := s.Authenticate(ctx, tok); err != nil {
		t.Fatal(err)
	}
	now = sess.CreatedAt.Add(30*24*time.Hour - time.Hour)
	if n, err := s.DeleteExpired(ctx); n != 0 || err != nil {
		t.Fatalf("sweep before idle deadline removed %d: %v", n, err)
	}
	if rows, err := s.Sessions(ctx, u.ID); len(rows) != 1 || err != nil {
		t.Fatalf("list before idle deadline returned %d sessions: %v", len(rows), err)
	}
	now = now.Add(time.Hour)
	if n, err := s.DeleteExpired(ctx); n != 1 || err != nil {
		t.Fatalf("sweep at idle deadline removed %d: %v", n, err)
	}
}

// Deleting a user takes their sessions with them (foreign-key cascade).
func TestDeleteCascades(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "u@x.com", false)
	tok, _, _ := s.CreateSession(ctx, u.ID, KindDevice, "")
	if err := s.Delete(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	s.db.QueryRow(`SELECT count(*) FROM auth_sessions`).Scan(&n)
	if n != 0 {
		t.Errorf("%d sessions left after delete", n)
	}
	if _, _, err := s.Authenticate(ctx, tok); !errors.Is(err, ErrNotFound) {
		t.Error("deleted user's token still works")
	}
}

// Model a reset or disable between verification and insertion without relying
// on goroutine scheduling to hit that interleaving.
func TestSignInRefusesStaleCredentials(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "a@x.com", false)
	if _, _, err := s.SignIn(ctx, u, KindWeb, ""); err != nil {
		t.Fatalf("fresh sign-in: %v", err)
	}
	if err := s.SetPassword(ctx, u.ID, "new-hash", 0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.SignIn(ctx, u, KindWeb, ""); !errors.Is(err, ErrStaleCredentials) {
		t.Errorf("sign-in with the replaced hash: %v, want ErrStaleCredentials", err)
	}
	cur, err := s.ByID(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetDisabled(ctx, cur.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.SignIn(ctx, cur, KindDevice, ""); !errors.Is(err, ErrStaleCredentials) {
		t.Errorf("sign-in on a disabled account: %v, want ErrStaleCredentials", err)
	}
}

// A device label is cut at 100 characters, never inside a multi-byte rune.
func TestSessionLabelTruncatesByRunes(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "a@x.com", false)
	label := strings.Repeat("é", 150) // two bytes each
	_, sess, err := s.CreateSession(ctx, u.ID, KindDevice, label)
	if err != nil {
		t.Fatal(err)
	}
	if want := strings.Repeat("é", 100); sess.Label != want || !utf8.ValidString(sess.Label) {
		t.Errorf("label has %d runes, valid=%v; want 100 whole runes", utf8.RuneCountInString(sess.Label), utf8.ValidString(sess.Label))
	}
}
