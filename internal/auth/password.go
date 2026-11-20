// Package auth holds the credential primitives: password hashing, generated
// passwords, and session tokens. It knows nothing about HTTP or the database.
package auth

import (
	"context"
	"crypto/rand"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/17xande-dev/password"
)

// MinPasswordLength is the whole password policy. Composition rules push
// people towards short mangled words; length plus argon2id is what actually
// makes guessing expensive.
const MinPasswordLength = 12

// MaxPasswordLength bounds the bytes one request can ask argon2 to hash.
const MaxPasswordLength = 256

var queueWait = 2 * time.Second

var ErrPasswordTooShort = fmt.Errorf("the password must be at least %d characters", MinPasswordLength)
var ErrPasswordTooLong = fmt.Errorf("the password must be at most %d characters", MaxPasswordLength)

// CheckPolicy reports why a new password is unacceptable, or nil.
func CheckPolicy(pw string) error {
	n := utf8.RuneCountInString(pw)
	if n < MinPasswordLength {
		return ErrPasswordTooShort
	}
	if len(pw) > MaxPasswordLength {
		return ErrPasswordTooLong
	}
	return nil
}

// HashPassword enforces the app's policy before queuing to hash a new password.
func HashPassword(ctx context.Context, pw string) (string, error) {
	if err := CheckPolicy(pw); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, queueWait)
	defer cancel()
	return password.Hash(ctx, pw)
}

// VerifyPassword reports whether pw matches the stored hash. Existing
// credentials aren't subject to the new-password minimum length.
func VerifyPassword(ctx context.Context, pw, hash string) (bool, error) {
	ok, _, err := CheckPassword(ctx, pw, hash)
	return ok, err
}

// CheckPassword also reports whether a verified hash should be upgraded.
func CheckPassword(ctx context.Context, pw, hash string) (ok, rehash bool, err error) {
	if len(pw) > MaxPasswordLength {
		return false, false, nil
	}
	ctx, cancel := context.WithTimeout(ctx, queueWait)
	defer cancel()
	return password.Check(ctx, hash, pw)
}

// SpendVerifyTime does one dummy check for an unknown email.
func SpendVerifyTime(ctx context.Context, pw string) error {
	if len(pw) > MaxPasswordLength {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, queueWait)
	defer cancel()
	_, err := password.CheckDummy(ctx, pw)
	return err
}

// passwordAlphabet leaves out characters that read alike (0/O, 1/l/I), since
// a generated password is read off one screen and typed into another device.
const passwordAlphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// GeneratePassword returns a random 20-character password, about 116 bits:
// what an admin hands to a new user, who changes it after signing in.
func GeneratePassword() string {
	b := make([]byte, 20)
	for i := range b {
		b[i] = passwordAlphabet[randIntn(len(passwordAlphabet))]
	}
	return string(b)
}

// randIntn is uniform in [0, n) by rejection sampling, so no character is
// more likely than another.
func randIntn(n int) int {
	limit := 256 - 256%n
	var buf [1]byte
	for {
		if _, err := rand.Read(buf[:]); err != nil {
			panic(err) // crypto/rand does not fail on supported platforms
		}
		if int(buf[0]) < limit {
			return int(buf[0]) % n
		}
	}
}
