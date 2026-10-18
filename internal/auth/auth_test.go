package auth

import (
	"strings"
	"testing"
)

func TestHashRoundTrip(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$") {
		t.Errorf("not a PHC argon2id string: %s", h)
	}
	if ok, err := VerifyPassword("correct horse battery", h); !ok || err != nil {
		t.Errorf("right password: ok=%v err=%v", ok, err)
	}
	if ok, _ := VerifyPassword("correct horse batterY", h); ok {
		t.Error("wrong password verified")
	}
}

// Two hashes of one password differ, so equal hashes in the database never
// reveal equal passwords.
func TestHashIsSalted(t *testing.T) {
	a, _ := HashPassword("same password here")
	b, _ := HashPassword("same password here")
	if a == b {
		t.Error("hashes are equal")
	}
}

// A corrupted hash must be an error, never a match.
func TestVerifyRejectsMalformedHash(t *testing.T) {
	for _, h := range []string{"", "plain", "$argon2i$v=19$m=1,t=1,p=1$c2FsdA$a2V5", "$argon2id$v=19$m=0,t=0,p=0$$"} {
		if ok, err := VerifyPassword("anything", h); ok || err == nil {
			t.Errorf("%q: ok=%v err=%v", h, ok, err)
		}
	}
}

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

// This package's tests never call UseFastHashesForTests, so this pins the
// production cost: a change to it must be deliberate, not a test helper
// leaking out.
func TestProductionParameters(t *testing.T) {
	h, _ := HashPassword("whatever password")
	if !strings.Contains(h, "$m=65536,t=3,p=2$") {
		t.Errorf("hash parameters changed: %s", h)
	}
}
