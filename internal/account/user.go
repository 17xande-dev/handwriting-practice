// Package account stores users and their signed-in sessions.
package account

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"
)

var (
	ErrNotFound  = errors.New("account: no such user")
	ErrExists    = errors.New("account: a user with that email already exists")
	ErrLastAdmin = errors.New("account: that would leave no enabled admin")
	ErrBadEmail  = errors.New("account: not a valid email address")
)

// User is one account. Admins manage the other accounts; everyone syncs
// their own history.
type User struct {
	ID           int64
	Email        string
	PasswordHash string
	IsAdmin      bool
	Disabled     bool
	CreatedAt    time.Time
	// LastLoginAt is the zero time for someone who has never signed in.
	LastLoginAt time.Time
}

// Store is the users and sessions tables.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db, now: time.Now}
}

// timestamp is how every time is stored: SQLite has no datetime type, and
// RFC3339 in UTC sorts and compares correctly as text.
func timestamp(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

// NormalizeEmail trims and lower-cases an address and refuses anything that
// is not a bare address. The column is COLLATE NOCASE as well, but storing
// one spelling keeps "Alex@x" and "alex@x " from reading as two people.
func NormalizeEmail(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	a, err := mail.ParseAddress(s)
	if err != nil || a.Address != s || len(s) > 254 {
		return "", ErrBadEmail
	}
	return s, nil
}

const userColumns = `id, email, password_hash, is_admin, disabled, created_at, last_login_at`

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	var created, lastLogin string
	err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.IsAdmin, &u.Disabled, &created, &lastLogin)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}
	u.CreatedAt, u.LastLoginAt = parseTime(created), parseTime(lastLogin)
	return u, nil
}

// Create adds a user. One statement, so two admins creating the same email
// at once cannot both succeed or overwrite each other: the loser gets
// ErrExists.
func (s *Store) Create(ctx context.Context, email, passwordHash string, admin bool) (User, error) {
	email, err := NormalizeEmail(email)
	if err != nil {
		return User{}, err
	}
	res, err := s.db.ExecContext(ctx, `INSERT INTO users (email, password_hash, is_admin, created_at)
		VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING`,
		email, passwordHash, admin, timestamp(s.now()))
	if err != nil {
		return User{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return User{}, ErrExists
	}
	return s.ByEmail(ctx, email)
}

func (s *Store) ByEmail(ctx context.Context, email string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE email = ?`,
		strings.TrimSpace(email)))
}

func (s *Store) ByID(ctx context.Context, id int64) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id))
}

// UserSummary is a row of the admin's user list.
type UserSummary struct {
	User
	// Sessions counts live web and device sign-ins.
	Sessions int
}

// List returns every user, admins first, then by email.
func (s *Store) List(ctx context.Context) ([]UserSummary, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userColumns+`,
		(SELECT count(*) FROM auth_sessions a WHERE a.user_id = users.id
		   AND (a.expires_at = '' OR a.expires_at > ?))
		FROM users ORDER BY is_admin DESC, email`, timestamp(s.now()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UserSummary
	for rows.Next() {
		var u UserSummary
		var created, lastLogin string
		if err := rows.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.IsAdmin, &u.Disabled, &created, &lastLogin, &u.Sessions); err != nil {
			return nil, err
		}
		u.CreatedAt, u.LastLoginAt = parseTime(created), parseTime(lastLogin)
		out = append(out, u)
	}
	return out, rows.Err()
}

// SetPassword replaces a user's password and ends their sessions, except
// keepSession (the one making the change, or 0 for none). Whoever knew the
// old password is signed out everywhere.
func (s *Store) SetPassword(ctx context.Context, userID int64, passwordHash string, keepSession int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM auth_sessions WHERE user_id = ? AND id != ?`, userID, keepSession); err != nil {
		return err
	}
	return tx.Commit()
}

// RecordLogin stamps last_login_at.
func (s *Store) RecordLogin(ctx context.Context, userID int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET last_login_at = ? WHERE id = ?`, timestamp(s.now()), userID)
	return err
}

// lastAdminGuard is true when changing this row cannot leave zero enabled
// admins: the row is not an enabled admin, or another enabled admin exists.
// It goes in the statement's own WHERE, so the count and the change are one
// atomic step. As a separate query first, two admins disabling each other at
// once would each see "2 admins", each pass, and lock everyone out.
const lastAdminGuard = `(is_admin = 0 OR disabled = 1 OR
	(SELECT count(*) FROM users WHERE is_admin = 1 AND disabled = 0) > 1)`

// guarded runs an UPDATE or DELETE on one user under lastAdminGuard and
// turns "no row changed" into the reason.
func (s *Store) guarded(ctx context.Context, userID int64, stmt string, args ...any) error {
	res, err := s.db.ExecContext(ctx, stmt+` WHERE id = ? AND `+lastAdminGuard, append(args, userID)...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 1 {
		return nil
	}
	if _, err := s.ByID(ctx, userID); err != nil {
		return err
	}
	return ErrLastAdmin
}

// SetDisabled disables or re-enables a user. Disabling also ends their
// sessions, so it takes effect at once rather than at the next sign-in.
func (s *Store) SetDisabled(ctx context.Context, userID int64, disabled bool) error {
	if !disabled {
		_, err := s.db.ExecContext(ctx, `UPDATE users SET disabled = 0 WHERE id = ?`, userID)
		return err
	}
	if err := s.guarded(ctx, userID, `UPDATE users SET disabled = 1`); err != nil {
		return err
	}
	return s.RevokeAll(ctx, userID)
}

// SetAdmin grants or removes the admin role.
func (s *Store) SetAdmin(ctx context.Context, userID int64, admin bool) error {
	if admin {
		res, err := s.db.ExecContext(ctx, `UPDATE users SET is_admin = 1 WHERE id = ?`, userID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return nil
	}
	return s.guarded(ctx, userID, `UPDATE users SET is_admin = 0`)
}

// Delete removes a user; their sessions and history go with them (ON DELETE
// CASCADE).
func (s *Store) Delete(ctx context.Context, userID int64) error {
	return s.guarded(ctx, userID, `DELETE FROM users`)
}

// String is for logs: never the hash.
func (u User) String() string {
	return fmt.Sprintf("user %d <%s>", u.ID, u.Email)
}
