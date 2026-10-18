package main

import (
	"os"
	"testing"

	"calligraphy/internal/auth"
)

// Real argon2 costs ~100ms and 64 MiB per hash; these tests hash and
// verify hundreds of times and are about behaviour, not cost.
func TestMain(m *testing.M) {
	auth.UseFastHashesForTests()
	os.Exit(m.Run())
}
