package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestPolicyIsLengthOnly(t *testing.T) {
	if CheckPolicy("short") == nil {
		t.Error("5 characters accepted")
	}
	if err := CheckPolicy("aaaaaaaaaaaa"); err != nil {
		t.Errorf("12 characters refused: %v", err)
	}
	// Counted in characters, not bytes: twelve accented letters is twelve.
	if err := CheckPolicy("éééééééééééé"); err != nil {
		t.Errorf("12 non-ASCII characters refused: %v", err)
	}
	if CheckPolicy(strings.Repeat("a", MaxPasswordLength+1)) == nil {
		t.Error("over-long password accepted")
	}
}

func TestGeneratedPasswordPassesPolicy(t *testing.T) {
	seen := map[string]bool{}
	for range 50 {
		p := GeneratePassword()
		if err := CheckPolicy(p); err != nil {
			t.Fatal(err)
		}
		if strings.ContainsAny(p, "0O1lI") {
			t.Errorf("ambiguous character in %s", p)
		}
		if seen[p] {
			t.Fatal("repeated password")
		}
		seen[p] = true
	}
}

func TestTokenHashIsStable(t *testing.T) {
	tok := NewToken()
	if len(tok) < 40 {
		t.Errorf("token too short: %s", tok)
	}
	if HashToken(tok) != HashToken(tok) || HashToken(tok) == HashToken(NewToken()) {
		t.Error("token hash not stable and distinct")
	}
}

func TestPasswordLimitsBeforeHashing(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	// The policy bounds bytes, including for passwords with fewer than 256 runes.
	tooLong := strings.Repeat("é", MaxPasswordLength/2+1)
	if _, err := HashPassword(ctx, tooLong); !errors.Is(err, ErrPasswordTooLong) {
		t.Errorf("creation with an overlong password: %v", err)
	}
	if _, err := HashPassword(ctx, ""); !errors.Is(err, ErrPasswordTooShort) {
		t.Errorf("creation with an empty password: %v", err)
	}
	if ok, err := VerifyPassword(ctx, tooLong, "invalid hash"); ok || err != nil {
		t.Errorf("verification with an overlong password: %v, %v", ok, err)
	}
	if err := SpendVerifyTime(ctx, tooLong); err != nil {
		t.Errorf("dummy check with an overlong password: %v", err)
	}
}
