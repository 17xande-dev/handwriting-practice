package account

import (
	"context"
	"errors"
	"testing"
	"time"

	"calligraphy/internal/dbtest"
)

var ctx = context.Background()

func newStore(t *testing.T) *Store {
	t.Helper()
	return NewStore(dbtest.New(t))
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

func TestWebSessionExpiresAndSlides(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "u@x.com", false)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	tok, _, _ := s.CreateSession(ctx, u.ID, KindWeb, "")

	// Used just before expiry: the window slides forward from that use.
	now = now.Add(WebSessionTTL - time.Hour)
	if _, _, err := s.Authenticate(ctx, tok); err != nil {
		t.Fatalf("before expiry: %v", err)
	}
	now = now.Add(WebSessionTTL - time.Hour)
	if _, _, err := s.Authenticate(ctx, tok); err != nil {
		t.Fatalf("after sliding: %v", err)
	}
	now = now.Add(WebSessionTTL + time.Hour)
	if _, _, err := s.Authenticate(ctx, tok); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired session accepted: %v", err)
	}
}

// A device stays signed in until revoked, however long it sits unused.
func TestDeviceSessionDoesNotExpire(t *testing.T) {
	s := newStore(t)
	u := mustCreate(t, s, "u@x.com", false)
	now := time.Now()
	s.now = func() time.Time { return now }
	tok, _, _ := s.CreateSession(ctx, u.ID, KindDevice, "iPad")
	now = now.Add(5 * 365 * 24 * time.Hour)
	if _, _, err := s.Authenticate(ctx, tok); err != nil {
		t.Errorf("device session expired: %v", err)
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
	s.CreateSession(ctx, u.ID, KindWeb, "")
	s.CreateSession(ctx, u.ID, KindDevice, "iPad")
	list, err := s.List(ctx)
	if err != nil || len(list) != 1 || list[0].Sessions != 2 {
		t.Fatalf("list = %+v, %v", list, err)
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
