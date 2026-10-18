package main

import (
	"bytes"
	"context"
	"regexp"
	"testing"

	"calligraphy/internal/account"
	"calligraphy/internal/auth"
	"calligraphy/internal/dbtest"
)

var printedPassword = regexp.MustCompile(`\(shown once\): (\S+)`)

// The printed password is the only copy anywhere, so it must be the one the
// account actually accepts.
func TestAddAdminPrintsAWorkingPassword(t *testing.T) {
	ctx := context.Background()
	store := account.NewStore(dbtest.New(t))
	var out bytes.Buffer
	if err := addAdmin(ctx, store, "Boss@Example.com", &out); err != nil {
		t.Fatal(err)
	}
	m := printedPassword.FindStringSubmatch(out.String())
	if m == nil {
		t.Fatalf("no password in %q", out.String())
	}
	u, err := store.ByEmail(ctx, "boss@example.com")
	if err != nil || !u.IsAdmin {
		t.Fatalf("admin not created: %+v %v", u, err)
	}
	if ok, _ := auth.VerifyPassword(m[1], u.PasswordHash); !ok {
		t.Error("printed password does not verify")
	}
	if err := addAdmin(ctx, store, "boss@example.com", &out); err == nil {
		t.Error("second add of the same email succeeded")
	}
}

func TestResetPasswordReplacesIt(t *testing.T) {
	ctx := context.Background()
	store := account.NewStore(dbtest.New(t))
	addAdmin(ctx, store, "a@x.com", &bytes.Buffer{})
	var out bytes.Buffer
	if err := resetPassword(ctx, store, "a@x.com", &out); err != nil {
		t.Fatal(err)
	}
	pw := printedPassword.FindStringSubmatch(out.String())[1]
	u, _ := store.ByEmail(ctx, "a@x.com")
	if ok, _ := auth.VerifyPassword(pw, u.PasswordHash); !ok {
		t.Error("reset password does not verify")
	}
	if err := resetPassword(ctx, store, "nobody@x.com", &out); err == nil {
		t.Error("reset of a missing user succeeded")
	}
}
