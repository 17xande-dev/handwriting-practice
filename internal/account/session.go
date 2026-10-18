package account

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"calligraphy/internal/auth"
)

// Session kinds: a browser holds a cookie, the iPad app a bearer token.
const (
	KindWeb    = "web"
	KindDevice = "device"
)

// WebSessionTTL is how long a browser stays signed in without visiting. It
// slides: every use pushes it out again.
const WebSessionTTL = 90 * 24 * time.Hour

// touchInterval bounds how often a session's last-use time is written, so a
// page load is not a database write.
const touchInterval = time.Hour

// Session is one signed-in browser or device.
type Session struct {
	ID         int64
	UserID     int64
	Kind       string
	Label      string
	CreatedAt  time.Time
	LastUsedAt time.Time
	// ExpiresAt is the zero time for a device, which stays signed in until
	// revoked.
	ExpiresAt time.Time
}

// CreateSession signs a user in and returns the token to hand to the client.
// Only the token's hash is stored.
func (s *Store) CreateSession(ctx context.Context, userID int64, kind, label string) (string, Session, error) {
	token := auth.NewToken()
	now := s.now()
	var expires time.Time
	if kind == KindWeb {
		expires = now.Add(WebSessionTTL)
	}
	if len(label) > 100 {
		label = label[:100]
	}
	res, err := s.db.ExecContext(ctx, `INSERT INTO auth_sessions
		(token_hash, user_id, kind, label, created_at, last_used_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		auth.HashToken(token), userID, kind, label, timestamp(now), timestamp(now), timestamp(expires))
	if err != nil {
		return "", Session{}, err
	}
	id, _ := res.LastInsertId()
	return token, Session{ID: id, UserID: userID, Kind: kind, Label: label, CreatedAt: now, LastUsedAt: now, ExpiresAt: expires}, nil
}

// Authenticate resolves a token to its session and user. A missing, expired
// or revoked token, or a disabled user, is ErrNotFound: to the caller all of
// them mean "not signed in".
func (s *Store) Authenticate(ctx context.Context, token string) (User, Session, error) {
	if token == "" {
		return User{}, Session{}, ErrNotFound
	}
	var sess Session
	var created, lastUsed, expires string
	row := s.db.QueryRowContext(ctx, `SELECT a.id, a.user_id, a.kind, a.label, a.created_at, a.last_used_at, a.expires_at
		FROM auth_sessions a JOIN users u ON u.id = a.user_id
		WHERE a.token_hash = ? AND u.disabled = 0`, auth.HashToken(token))
	err := row.Scan(&sess.ID, &sess.UserID, &sess.Kind, &sess.Label, &created, &lastUsed, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, Session{}, ErrNotFound
	}
	if err != nil {
		return User{}, Session{}, err
	}
	sess.CreatedAt, sess.LastUsedAt, sess.ExpiresAt = parseTime(created), parseTime(lastUsed), parseTime(expires)
	now := s.now()
	if !sess.ExpiresAt.IsZero() && !now.Before(sess.ExpiresAt) {
		s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE id = ?`, sess.ID)
		return User{}, Session{}, ErrNotFound
	}
	if now.Sub(sess.LastUsedAt) >= touchInterval {
		if !sess.ExpiresAt.IsZero() {
			sess.ExpiresAt = now.Add(WebSessionTTL)
		}
		sess.LastUsedAt = now
		s.db.ExecContext(ctx, `UPDATE auth_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?`,
			timestamp(now), timestamp(sess.ExpiresAt), sess.ID)
	}
	u, err := s.ByID(ctx, sess.UserID)
	if err != nil {
		return User{}, Session{}, err
	}
	return u, sess, nil
}

// Sessions lists a user's live sessions, most recently used first.
func (s *Store) Sessions(ctx context.Context, userID int64) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, user_id, kind, label, created_at, last_used_at, expires_at
		FROM auth_sessions WHERE user_id = ? AND (expires_at = '' OR expires_at > ?)
		ORDER BY last_used_at DESC, id DESC`, userID, timestamp(s.now()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var sess Session
		var created, lastUsed, expires string
		if err := rows.Scan(&sess.ID, &sess.UserID, &sess.Kind, &sess.Label, &created, &lastUsed, &expires); err != nil {
			return nil, err
		}
		sess.CreatedAt, sess.LastUsedAt, sess.ExpiresAt = parseTime(created), parseTime(lastUsed), parseTime(expires)
		out = append(out, sess)
	}
	return out, rows.Err()
}

// Revoke ends one of a user's sessions. Scoped to the user in the statement,
// so a guessed session id cannot sign someone else out.
func (s *Store) Revoke(ctx context.Context, userID, sessionID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE id = ? AND user_id = ?`, sessionID, userID)
	return err
}

// RevokeToken ends the session a token belongs to (sign out).
func (s *Store) RevokeToken(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE token_hash = ?`, auth.HashToken(token))
	return err
}

// RevokeAll signs a user out everywhere.
func (s *Store) RevokeAll(ctx context.Context, userID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE user_id = ?`, userID)
	return err
}

// DeleteExpired removes web sessions past their expiry; the background sweep
// calls it so abandoned sign-ins do not accumulate.
func (s *Store) DeleteExpired(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE expires_at != '' AND expires_at <= ?`, timestamp(s.now()))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
