-- Accounts and synced practice history. Every table is STRICT and every
-- status column carries its CHECK from the start: neither can be added to an
-- existing table later without rebuilding it.

CREATE TABLE users (
	id            INTEGER PRIMARY KEY,
	email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
	password_hash TEXT    NOT NULL,
	is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
	disabled      INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
	created_at    TEXT    NOT NULL,
	-- "" until the first sign-in.
	last_login_at TEXT    NOT NULL DEFAULT ''
) STRICT;

-- A signed-in browser ('web', cookie) or app ('device', bearer token). Only
-- the sha256 of the token is stored, so a copy of the database signs nobody in.
CREATE TABLE auth_sessions (
	id           INTEGER PRIMARY KEY,
	token_hash   TEXT    NOT NULL UNIQUE,
	user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	kind         TEXT    NOT NULL CHECK (kind IN ('web', 'device')),
	label        TEXT    NOT NULL DEFAULT '',
	created_at   TEXT    NOT NULL,
	last_used_at TEXT    NOT NULL,
	-- "" never expires (devices stay signed in until revoked).
	expires_at   TEXT    NOT NULL DEFAULT ''
) STRICT;

CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

-- One record (a checked line, or the ink of one), stored as the client's own JSON. data is NULL for a
-- tombstone: the record was deleted, and other devices must delete it too.
-- seq is the sync cursor: every insert or tombstone takes a new, higher one,
-- and AUTOINCREMENT guarantees a deleted seq is never handed out again.
CREATE TABLE records (
	seq     INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	kind    TEXT    NOT NULL CHECK (kind IN ('check', 'ink')),
	id      TEXT    NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
	data    TEXT,
	UNIQUE (user_id, kind, id)
) STRICT;

CREATE INDEX records_user_seq ON records(user_id, seq);
