package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

// NewToken returns an opaque 256-bit session token for the cookie or the
// device's Authorization header. Only HashToken of it is stored.
func NewToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// HashToken is how a token is stored and looked up. A plain sha256 is right
// here, unlike for passwords: the token already carries 256 random bits, so
// there is nothing for a slow hash to protect.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
