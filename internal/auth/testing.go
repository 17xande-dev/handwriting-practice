package auth

import "testing"

// HoldSlotsForTest takes every argon2 slot and shortens the wait, so a test
// can see how callers behave under load. The returned func gives them back
// (it is also run at cleanup, once).
func HoldSlotsForTest(t testing.TB) (release func()) {
	t.Helper()
	old := acquireWait
	acquireWait = 10 * 1e6 // 10 ms
	for range maxConcurrent {
		if err := acquire(); err != nil {
			t.Fatal(err)
		}
	}
	done := false
	release = func() {
		if done {
			return
		}
		done = true
		acquireWait = old
		for range maxConcurrent {
			<-slots
		}
	}
	t.Cleanup(release)
	return release
}
