package account

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"time"

	"calligraphy/internal/auth"

	"github.com/17xande-dev/websec/session"
)

// Session kinds: a browser holds a cookie, the iPad app a bearer token.
const (
	KindWeb    = "web"
	KindDevice = "device"
)

// Lifetimes holds the validated policies for the two credential kinds.
type Lifetimes struct {
	Web, Device session.Lifetime
}

// DefaultLifetimes returns the server defaults independently of environment.
func DefaultLifetimes() Lifetimes {
	const day = 24 * time.Hour
	return Lifetimes{
		Web:    session.Lifetime{Idle: 30 * day, Absolute: 90 * day},
		Device: session.Lifetime{Idle: 90 * day, Absolute: 365 * day},
	}
}

// Lifetime selects the policy for a kind from the auth_sessions constraint.
func (l Lifetimes) Lifetime(kind string) session.Lifetime {
	if kind == KindDevice {
		return l.Device
	}
	return l.Web
}

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
	ExpiresAt  time.Time // derived server deadline (idle or absolute, whichever is earlier)
}

// SignIn returns a token whose hash is stored only if the verified password
// hash is still current and the account is enabled. The guard and insert
// share a statement so a concurrent password reset or disable cannot leave
// a new session behind. It returns ErrStaleCredentials if the guard fails.
func (s *Store) SignIn(ctx context.Context, u User, kind, label string) (string, Session, error) {
	return s.createSession(ctx, u.ID, u.PasswordHash, true, kind, label)
}

func (s *Store) createSession(ctx context.Context, userID int64, verifiedHash string, guard bool, kind, label string) (string, Session, error) {
	token := auth.NewToken()
	now := s.now().UTC().Truncate(time.Second)
	expires := s.lifetimes.Lifetime(kind).ExpiresAt(now, now)
	// 100 characters, not bytes: a byte cut can split a UTF-8 rune.
	if r := []rune(label); len(r) > 100 {
		label = string(r[:100])
	}
	var res sql.Result
	var err error
	if guard {
		res, err = s.db.ExecContext(ctx, `INSERT INTO auth_sessions
			(token_hash, user_id, kind, label, created_at, last_used_at, expires_at)
			SELECT ?, id, ?, ?, ?, ?, ? FROM users
			WHERE id = ? AND password_hash = ? AND disabled = 0`,
			auth.HashToken(token), kind, label, timestamp(now), timestamp(now), timestamp(expires), userID, verifiedHash)
	} else {
		res, err = s.db.ExecContext(ctx, `INSERT INTO auth_sessions
			(token_hash, user_id, kind, label, created_at, last_used_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			auth.HashToken(token), userID, kind, label, timestamp(now), timestamp(now), timestamp(expires))
	}
	if err != nil {
		return "", Session{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", Session{}, ErrStaleCredentials
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
	var created, lastUsed string
	hash := auth.HashToken(token)
	row := s.db.QueryRowContext(ctx, `SELECT a.id, a.user_id, a.kind, a.label, a.created_at, a.last_used_at
		FROM auth_sessions a JOIN users u ON u.id = a.user_id
		WHERE a.token_hash = ? AND u.disabled = 0`, hash)
	err := row.Scan(&sess.ID, &sess.UserID, &sess.Kind, &sess.Label, &created, &lastUsed)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, Session{}, ErrNotFound
	}
	if err != nil {
		return User{}, Session{}, err
	}
	sess.CreatedAt, sess.LastUsedAt = parseTime(created), parseTime(lastUsed)
	now := s.now().UTC().Truncate(time.Second)
	life := s.lifetimes.Lifetime(sess.Kind)
	if life.Expired(sess.CreatedAt, sess.LastUsedAt, now) {
		// Don't delete a row that an in-flight request just touched, or a
		// replacement that reused its ID. A cleanup failure is still a miss.
		if _, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE id = ? AND token_hash = ? AND last_used_at = ?`,
			sess.ID, hash, lastUsed); err != nil {
			slog.ErrorContext(ctx, "delete expired session", "err", err)
		}
		return User{}, Session{}, ErrNotFound
	}
	if session.NeedsTouchAfter(sess.LastUsedAt, now, touchInterval) {
		// The predicate enforces the hourly throttle under concurrency and
		// repairs timestamps left by a clock that was ahead.
		res, err := s.db.ExecContext(ctx, `UPDATE auth_sessions SET last_used_at = ?, expires_at = ?
			WHERE id = ? AND token_hash = ? AND (last_used_at <= ? OR last_used_at > ?)`,
			timestamp(now), timestamp(life.ExpiresAt(sess.CreatedAt, now)), sess.ID, hash,
			timestamp(now.Add(-touchInterval)), timestamp(now))
		if err != nil {
			slog.ErrorContext(ctx, "touch session", "err", err)
		} else if n, _ := res.RowsAffected(); n != 0 {
			sess.LastUsedAt = now
		}
	}
	sess.ExpiresAt = life.ExpiresAt(sess.CreatedAt, sess.LastUsedAt)
	u, err := s.ByID(ctx, sess.UserID)
	if err != nil {
		return User{}, Session{}, err
	}
	return u, sess, nil
}

// Sessions lists a user's live sessions, most recently used first.
func (s *Store) Sessions(ctx context.Context, userID int64) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, user_id, kind, label, created_at, last_used_at
		FROM auth_sessions WHERE user_id = ? AND NOT `+expiredSessions+`
		ORDER BY last_used_at DESC, id DESC`, append([]any{userID}, s.expiryCutoffs()...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var sess Session
		var created, lastUsed string
		if err := rows.Scan(&sess.ID, &sess.UserID, &sess.Kind, &sess.Label, &created, &lastUsed); err != nil {
			return nil, err
		}
		sess.CreatedAt, sess.LastUsedAt = parseTime(created), parseTime(lastUsed)
		sess.ExpiresAt = s.lifetimes.Lifetime(sess.Kind).ExpiresAt(sess.CreatedAt, sess.LastUsedAt)
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

// expiredSessions mirrors Lifetime.Expired using fixed-width UTC timestamps.
// max floors last use at creation: repairing a clock ahead of ours can leave
// last_used_at earlier than created_at. expires_at is for older binaries only.
const expiredSessions = `((kind = ? AND (created_at <= ? OR max(created_at, last_used_at) <= ?))
	OR (kind = ? AND (created_at <= ? OR max(created_at, last_used_at) <= ?)))`

func (s *Store) expiryCutoffs() []any {
	now := s.now()
	web, device := s.lifetimes.Web, s.lifetimes.Device
	return []any{
		KindWeb, timestamp(now.Add(-web.Absolute)), timestamp(now.Add(-web.Idle)),
		KindDevice, timestamp(now.Add(-device.Absolute)), timestamp(now.Add(-device.Idle)),
	}
}

// DeleteExpired sweeps both credential kinds and returns the number removed.
// Request-time checks don't wait for the background sweep to reject a token.
func (s *Store) DeleteExpired(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE `+expiredSessions, s.expiryCutoffs()...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
