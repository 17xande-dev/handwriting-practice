package auth

import (
	"testing"

	"github.com/17xande-dev/password"
)

// RunWithFastHashes lowers Argon2id's cost for a test binary whose tests
// exercise app behavior, not the password module's choice of parameters.
func RunWithFastHashes(m *testing.M) int {
	p := password.DefaultParams
	p.Memory, p.Time, p.Parallelism = 64, 1, 1
	defer password.SetParamsForTesting(p)()
	return m.Run()
}
