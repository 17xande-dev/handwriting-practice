// Package db opens the SQLite database and brings its schema up to date.
//
// One file holds every user: the login lookup needs a shared table anyway,
// and the server runs as a single instance. The trigger that would change
// this is running a second instance (see the README's open decisions).
package db

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"

	_ "github.com/mattn/go-sqlite3"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open opens (creating if absent) the database at path.
//
//   - _foreign_keys=on: SQLite enforces no REFERENCES at all without it, so a
//     deleted user would silently leave their sessions and records behind.
//   - _journal_mode=WAL: the sync API writes while pages read, and WAL lets
//     readers carry on during a write. It needs the directory writable (it
//     creates -wal and -shm files) and makes a plain `cp` of the file an
//     unsafe backup, so backups use VACUUM INTO.
//   - busy_timeout is left at the driver's 5s default.
//
// Schema changes go through a numbered migration, never an ALTER run on
// startup: on a STRICT table that leaves the database diverged from the
// schema files.
func Open(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_foreign_keys=on&_journal_mode=WAL", path)
	d, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("db: open %s: %w", path, err)
	}
	// sql.Open is lazy; ping so a bad path or an unwritable directory fails
	// at startup rather than on the first sign-in.
	if err := d.Ping(); err != nil {
		d.Close()
		return nil, fmt.Errorf("db: open %s: %w", path, err)
	}
	return d, nil
}

type migration struct {
	version int
	name    string
	sql     string
}

// migrations lists the embedded NNNN_name.sql files in order. A gap or a
// duplicate number is an error: either means a file was misnamed, and
// applying around it would skip a schema change for good.
func migrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return nil, err
	}
	var ms []migration
	for _, e := range entries {
		num, _, ok := strings.Cut(e.Name(), "_")
		v, err := strconv.Atoi(num)
		if !ok || err != nil {
			return nil, fmt.Errorf("db: migration %q is not named NNNN_name.sql", e.Name())
		}
		b, err := migrationsFS.ReadFile(path.Join("migrations", e.Name()))
		if err != nil {
			return nil, err
		}
		ms = append(ms, migration{version: v, name: e.Name(), sql: string(b)})
	}
	sort.Slice(ms, func(i, j int) bool { return ms[i].version < ms[j].version })
	for i, m := range ms {
		if m.version != i+1 {
			return nil, fmt.Errorf("db: migration %s: want version %d", m.name, i+1)
		}
	}
	return ms, nil
}

// Migrate applies every migration newer than the database's user_version,
// each in its own transaction together with the version bump, so a failed
// migration leaves the database exactly at the previous version. goose was
// the alternative; this is the few lines of it that a single-instance
// SQLite server needs, without its Postgres-shaped locking.
func Migrate(d *sql.DB) (applied []string, err error) {
	ms, err := migrations()
	if err != nil {
		return nil, err
	}
	current, err := Version(d)
	if err != nil {
		return nil, err
	}
	if current > len(ms) {
		return nil, fmt.Errorf("db: database is at version %d but this build knows only %d: refusing to run an older binary against it", current, len(ms))
	}
	for _, m := range ms[current:] {
		tx, err := d.Begin()
		if err != nil {
			return applied, err
		}
		if _, err := tx.Exec(m.sql); err != nil {
			tx.Rollback()
			return applied, fmt.Errorf("db: migration %s: %w", m.name, err)
		}
		// PRAGMA takes no bound parameters; the version is an int we own.
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", m.version)); err != nil {
			tx.Rollback()
			return applied, err
		}
		if err := tx.Commit(); err != nil {
			return applied, fmt.Errorf("db: migration %s: %w", m.name, err)
		}
		applied = append(applied, m.name)
	}
	return applied, nil
}

// Version is the last migration applied.
func Version(d *sql.DB) (int, error) {
	var v int
	err := d.QueryRow("PRAGMA user_version").Scan(&v)
	return v, err
}

// Status describes each known migration as applied or pending, for the
// -migrate-status flag.
func Status(d *sql.DB) ([]string, error) {
	ms, err := migrations()
	if err != nil {
		return nil, err
	}
	v, err := Version(d)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, m := range ms {
		state := "pending"
		if m.version <= v {
			state = "applied"
		}
		out = append(out, fmt.Sprintf("%-8s %s", state, m.name))
	}
	return out, nil
}
