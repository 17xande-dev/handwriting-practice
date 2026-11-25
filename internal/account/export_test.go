package account

import "context"

// CreateSession bypasses the credential guard for fixtures. Production
// sign-ins must go through SignIn.
func (s *Store) CreateSession(ctx context.Context, userID int64, kind, label string) (string, Session, error) {
	return s.createSession(ctx, userID, "", false, kind, label)
}
