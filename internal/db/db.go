// Package db opens the SQLite database and brings its schema up to date with
// goose migrations on STRICT tables (sqlitekit/goosestrict).
//
// One file holds every user: the login lookup needs a shared table anyway,
// and the server runs as a single instance. The trigger that would change
// this is running a second instance (see the README's open decisions).
package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/17xande-dev/sqlitekit"
	"github.com/17xande-dev/sqlitekit/goosestrict"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// checkSettings is a variable only so a test can prove Open refuses a database
// whose settings did not take; nothing else replaces it.
var checkSettings = sqlitekit.Check

// lockTimeout bounds the wait for another process's migration.
const lockTimeout = time.Minute

// lock takes the migration lock (a <db>.migrate-lock file beside the database,
// never deleted) on the absolute path the database is opened with. It must
// come before the first query on the database, Check included: the first open
// of a fresh database can fail with SQLITE_BUSY that the busy timeout does not
// cover, and goose reads its pending list before it takes SQLite's write lock,
// so two processes migrating at once (a restart overlapping its predecessor,
// a flag command beside the server) could both apply the same migration.
func lock(path string) (abs string, release func(), err error) {
	abs, err = filepath.Abs(path)
	if err != nil {
		return "", nil, fmt.Errorf("db: open %s: %w", path, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), lockTimeout)
	defer cancel()
	unlock, err := sqlitekit.MigrationLock(ctx, abs)
	if err != nil {
		return "", nil, fmt.Errorf("db: open %s: lock migrations: %w", path, err)
	}
	return abs, func() { _ = unlock() }, nil
}

// open opens the database with the house settings and refuses to return it
// unless Check confirms they took. The caller holds the migration lock.
func open(path string) (*sql.DB, error) {
	opts := sqlitekit.Options{}
	dsn, err := sqlitekit.DSN(path, opts)
	if err != nil {
		return nil, fmt.Errorf("db: open %s: %w", path, err)
	}
	d, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("db: open %s: %w", path, err)
	}
	// sql.Open is lazy; Check is the first query, so a bad path or an
	// unwritable directory fails at startup rather than on the first sign-in,
	// and so does a setting the driver silently ignored.
	if err := checkSettings(context.Background(), d, opts); err != nil {
		d.Close()
		return nil, fmt.Errorf("db: open %s: refusing to run: %w", path, err)
	}
	return d, nil
}

// Open opens (creating if absent) the database at path with the house
// settings from sqlitekit (foreign keys, WAL, busy timeout, immediate
// transactions) and refuses to return it unless Check confirms they took.
// It does not migrate: use OpenMigrated for that. It holds the migration lock
// around Check (which can switch a fresh database to WAL) and releases it
// before returning.
//
// WAL matters here because the sync API writes while pages read. It also
// means a plain copy of the file is not a backup: see the README.
//
// Schema changes go through a numbered migration, never an ALTER run on
// startup: on a STRICT table that leaves the database diverged from the
// schema files.
func Open(path string) (*sql.DB, error) {
	abs, release, err := lock(path)
	if err != nil {
		return nil, err
	}
	defer release()
	return open(abs)
}

// OpenMigrated is Open followed by Migrate, with the migration lock held from
// before the first query until the schema is current. It returns the names of
// the migrations it applied. Every path that writes the schema (the server,
// the account commands) goes through it.
func OpenMigrated(path string) (*sql.DB, []string, error) {
	abs, release, err := lock(path)
	if err != nil {
		return nil, nil, err
	}
	defer release()
	d, err := open(abs)
	if err != nil {
		return nil, nil, err
	}
	applied, err := Migrate(d)
	if err != nil {
		d.Close()
		return nil, applied, err
	}
	return d, applied, nil
}

// legacyVersionTable is goose's version table; its presence means the
// database has been through goose (or adopted into it).
const legacyVersionTable = "goose_db_version"

func migrationsDir() (fs.FS, error) { return fs.Sub(migrationsFS, "migrations") }

func countMigrations() (int, error) {
	entries, err := fs.ReadDir(migrationsFS, "migrations")
	return len(entries), err
}

// state reports whether the database has goose's version table, how many
// user tables it has, and the old runner's PRAGMA user_version.
func state(ctx context.Context, d *sql.DB) (hasVersion bool, tables int, userVersion int64, err error) {
	err = d.QueryRowContext(ctx, `SELECT
		coalesce(sum(name = ?), 0) > 0,
		coalesce(sum(name NOT LIKE 'sqlite_%' AND name <> ?), 0)
		FROM sqlite_master WHERE type = 'table'`, legacyVersionTable, legacyVersionTable).Scan(&hasVersion, &tables)
	if err != nil {
		return
	}
	err = d.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&userVersion)
	return
}

// provider returns the goose provider, first adopting a database made by the
// old PRAGMA user_version runner. That runner applied migrations 1..user_version
// in order, each with its version bump in one transaction, so goose is told
// exactly those are done and runs the rest. A database with tables and
// user_version 0 has no known history and is refused, as is one newer than
// this build (checked before anything is written).
func provider(ctx context.Context, d *sql.DB) (*goose.Provider, error) {
	hasVersion, tables, uv, err := state(ctx, d)
	if err != nil {
		return nil, err
	}
	if !hasVersion && tables > 0 {
		n, err := countMigrations()
		if err != nil {
			return nil, err
		}
		switch {
		case uv == 0:
			return nil, errors.New("db: the database has tables but no migration history (user_version 0): refusing to guess its schema")
		case uv > int64(n):
			return nil, fmt.Errorf("db: database is at version %d but this build knows only %d: refusing to run an older binary against it", uv, n)
		}
		if err := goosestrict.Adopt(ctx, d, uv); err != nil {
			return nil, fmt.Errorf("db: adopting a user_version %d database into goose: %w", uv, err)
		}
	}
	dir, err := migrationsDir()
	if err != nil {
		return nil, err
	}
	return goosestrict.NewProvider(d, dir)
}

// Migrate applies every migration not yet recorded in goose's version table
// (adopting a database from the old user_version runner first), each in its
// own transaction, and returns the file names it applied.
//
// The caller must hold the migration lock for d's database; prefer
// OpenMigrated, which does. It stays exported only for tests that build an
// old-runner database by hand between Open and the migration.
func Migrate(d *sql.DB) (applied []string, err error) {
	ctx := context.Background()
	p, err := provider(ctx, d)
	if err != nil {
		return nil, err
	}
	results, err := p.Up(ctx)
	for _, r := range results {
		applied = append(applied, filepath.Base(r.Source.Path))
	}
	return applied, err
}

// StatusAt is the -migrate-status command: it reports each migration of the
// database at path as applied or pending. It never creates a database: a
// missing file is reported as not yet migrated. For an existing file it holds
// the migration lock from before the first query until it has closed the
// database, because reading the status of an empty file still writes goose's
// version table, and that write must not race another process's migration.
func StatusAt(path string) ([]string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("db: status %s: %w", path, err)
	}
	if _, err := os.Stat(abs); errors.Is(err, fs.ErrNotExist) {
		return []string{fmt.Sprintf("no database at %s: not yet migrated", abs)}, nil
	} else if err != nil {
		return nil, fmt.Errorf("db: status %s: %w", path, err)
	}
	abs, release, err := lock(abs)
	if err != nil {
		return nil, err
	}
	defer release()
	d, err := open(abs)
	if err != nil {
		return nil, err
	}
	defer d.Close()
	lines, err := Status(d)
	statusHook()
	return lines, err
}

// statusHook runs after the status is read and before the database is closed
// and the lock released, so a test can prove the lock is still held then.
var statusHook = func() {}

// Status describes each known migration as applied or pending. It never adopts
// a legacy database (it is reported from its user_version), but on an empty
// database goose still creates its version table, and Status takes no lock of
// its own: the -migrate-status command goes through StatusAt, which does.
func Status(d *sql.DB) ([]string, error) {
	ctx := context.Background()
	hasVersion, tables, uv, err := state(ctx, d)
	if err != nil {
		return nil, err
	}
	var out []string
	if !hasVersion && tables > 0 {
		entries, err := fs.ReadDir(migrationsFS, "migrations")
		if err != nil {
			return nil, err
		}
		for i, e := range entries {
			st := "pending"
			if int64(i+1) <= uv {
				st = "applied"
			}
			out = append(out, fmt.Sprintf("%-8s %s", st, e.Name()))
		}
		return out, nil
	}
	p, err := provider(ctx, d)
	if err != nil {
		return nil, err
	}
	sts, err := p.Status(ctx)
	if err != nil {
		return nil, err
	}
	for _, s := range sts {
		st := "pending"
		if s.State == goose.StateApplied {
			st = "applied"
		}
		out = append(out, fmt.Sprintf("%-8s %s", st, filepath.Base(s.Source.Path)))
	}
	return out, nil
}
