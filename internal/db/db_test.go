package db_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"calligraphy/internal/db"
	"calligraphy/internal/dbtest"

	"github.com/17xande-dev/sqlitekit"
)

// Checked against sqlite_master rather than the .sql files, because
// CREATE TABLE ... STRICT on an existing table reports success and changes
// nothing — the file can say STRICT while the database is not.
func TestEveryTableIsStrict(t *testing.T) {
	d := dbtest.New(t)
	rows, err := d.Query(`SELECT name, sql FROM sqlite_master
	                      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var name, ddl string
		if err := rows.Scan(&name, &ddl); err != nil {
			t.Fatal(err)
		}
		n++
		if !strings.Contains(strings.ToUpper(ddl), ") STRICT") {
			t.Errorf("table %s is not STRICT", name)
		}
	}
	// Without a floor this passes vacuously the day the schema stops applying.
	if n < 3 {
		t.Fatalf("found %d tables, want at least 3", n)
	}
}

// A redeploy runs Migrate against an up-to-date database every time.
func TestMigrateTwiceIsANoOp(t *testing.T) {
	d := dbtest.New(t)
	applied, err := db.Migrate(d)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 0 {
		t.Errorf("second run applied %v", applied)
	}
}

// Without _foreign_keys=on every REFERENCES is decoration: deleting a user
// would leave their sessions able to sign in as nobody.
func TestForeignKeysEnforced(t *testing.T) {
	d := dbtest.New(t)
	_, err := d.Exec(`INSERT INTO auth_sessions (token_hash, user_id, kind, created_at, last_used_at)
	                  VALUES ('x', 999, 'web', '', '')`)
	if err == nil {
		t.Fatal("session for a missing user was accepted")
	}
}

// legacyDB builds a database exactly as the old PRAGMA user_version runner
// did: each embedded migration applied in its own transaction together with
// the version bump, no migration table. Rows are inserted at the end.
func legacyDB(t *testing.T, version int) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "legacy.db")
	d, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	files := []string{"0001_init.sql", "0002_strokes_kind.sql", "0003_prefs_kind.sql"}
	for i, f := range files[:version] {
		b, err := os.ReadFile("migrations/" + f)
		if err != nil {
			t.Fatal(err)
		}
		tx, err := d.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(string(b)); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	return d, path
}

func statusLines(t *testing.T, d *sql.DB) string {
	t.Helper()
	lines, err := db.Status(d)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(strings.Fields(strings.Join(lines, "|")), " ")
}

// The adoption path: a production database made by the old runner, with rows,
// must be adopted (not re-migrated), keep every row, report 1..N applied and
// still take a later migration. Without Adopt, goose would run 0001 against
// existing tables and fail, so this test is what proves Adopt is wired in.
func TestAdoptsOldRunnerDatabase(t *testing.T) {
	d, _ := legacyDB(t, 2)
	for _, q := range []string{
		`INSERT INTO users (email, password_hash, created_at) VALUES ('a@x.com', 'h', '')`,
		`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'strokes', 's1', '{}')`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if got := statusLines(t, d); got != "applied 0001_init.sql|applied 0002_strokes_kind.sql|pending 0003_prefs_kind.sql" {
		t.Fatalf("status before adoption: %s", got)
	}
	var tables int
	d.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name = 'goose_db_version'`).Scan(&tables)
	if tables != 0 {
		t.Fatal("-migrate-status wrote the version table")
	}
	applied, err := db.Migrate(d)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 1 || applied[0] != "0003_prefs_kind.sql" {
		t.Fatalf("applied %v, want only 0003 (1..2 adopted)", applied)
	}
	var users, recs int
	d.QueryRow(`SELECT count(*) FROM users`).Scan(&users)
	d.QueryRow(`SELECT count(*) FROM records`).Scan(&recs)
	if users != 1 || recs != 1 {
		t.Fatalf("rows after adoption: %d users, %d records", users, recs)
	}
	if got := statusLines(t, d); got != "applied 0001_init.sql|applied 0002_strokes_kind.sql|applied 0003_prefs_kind.sql" {
		t.Fatalf("status after: %s", got)
	}
	// A second start is a no-op.
	if applied, err := db.Migrate(d); err != nil || len(applied) != 0 {
		t.Fatalf("second run: %v, %v", applied, err)
	}
}

// An up-to-date old database is adopted with nothing left to run.
func TestAdoptsCurrentOldRunnerDatabase(t *testing.T) {
	d, _ := legacyDB(t, 3)
	applied, err := db.Migrate(d)
	if err != nil || len(applied) != 0 {
		t.Fatalf("applied %v, %v", applied, err)
	}
}

// A fresh database runs everything from zero.
func TestFreshDatabaseMigratesFromZero(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "fresh.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	applied, err := db.Migrate(d)
	if err != nil || len(applied) != 3 {
		t.Fatalf("applied %v, %v", applied, err)
	}
	if got := statusLines(t, d); got != "applied 0001_init.sql|applied 0002_strokes_kind.sql|applied 0003_prefs_kind.sql" {
		t.Fatalf("status: %s", got)
	}
}

// A newer database means a rollback deploy; running old code against a
// schema it does not know would misread it. Both an unadopted old-runner
// database and an already-goose one are refused, and the first untouched.
func TestRefusesNewerDatabase(t *testing.T) {
	d, _ := legacyDB(t, 3)
	if _, err := d.Exec("PRAGMA user_version = 999"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(d); err == nil {
		t.Fatal("adopted a user_version database newer than the build")
	}
	var n int
	d.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name = 'goose_db_version'`).Scan(&n)
	if n != 0 {
		t.Error("a refused database was written to")
	}

	g := dbtest.New(t)
	if _, err := g.Exec(`INSERT INTO goose_db_version (version_id, is_applied) VALUES (999, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(g); err == nil {
		t.Fatal("migrated a goose database newer than the build")
	}
}

// Tables but no recorded version: the schema is unknowable, so refuse.
func TestRefusesTablesWithoutHistory(t *testing.T) {
	d, _ := legacyDB(t, 3)
	if _, err := d.Exec("PRAGMA user_version = 0"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(d); err == nil {
		t.Fatal("adopted a database with tables and user_version 0")
	}
}

func TestStrictRefusesWrongType(t *testing.T) {
	d := dbtest.New(t)
	_, err := d.Exec(`INSERT INTO users (email, password_hash, is_admin, created_at)
	                  VALUES ('a@b.c', 'h', 'yes', '')`)
	if err == nil {
		t.Fatal("STRICT accepted a string in an INTEGER column")
	}
}

// The strokes migration rebuilds records: every row and seq survives, the seq counter does not go
// back, the CHECK now allows 'strokes' (and still nothing else), and the table is STRICT.
func TestStrokesMigrationKeepsRecords(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "x.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	// The schema as it was at version 1.
	v1, err := os.ReadFile("migrations/0001_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(string(v1)); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`PRAGMA user_version = 1`); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO users (email, password_hash, created_at) VALUES ('a@x.com', 'h', '')`,
		`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'check', 'c1', '{"id":"c1","ts":1}')`,
		`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'ink', 'i1', '{"id":"i1","ts":1}')`,
		`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'ink', 'i2', NULL)`,
		// A deleted top seq: the counter is ahead of every row.
		`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'ink', 'gone', '{}')`,
		`DELETE FROM records WHERE id = 'gone'`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if _, err := d.Exec(`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'strokes', 's', '{}')`); err == nil {
		t.Fatal("version 1 accepted a strokes record")
	}
	applied, err := db.Migrate(d)
	if err != nil || len(applied) != 2 {
		t.Fatalf("applied %v, %v", applied, err)
	}
	var n int
	d.QueryRow(`SELECT count(*) FROM records`).Scan(&n)
	if n != 3 {
		t.Fatalf("%d rows after migration, want 3", n)
	}
	var seq int
	d.QueryRow(`SELECT seq FROM records WHERE id = 'i2'`).Scan(&seq)
	if seq != 3 {
		t.Errorf("seq of i2 is %d, want 3", seq)
	}
	if _, err := d.Exec(`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'strokes', 's', '{}')`); err != nil {
		t.Fatalf("strokes refused after migration: %v", err)
	}
	d.QueryRow(`SELECT seq FROM records WHERE id = 's'`).Scan(&seq)
	if seq != 5 {
		t.Errorf("new seq %d, want 5 (the counter must not go back to 4)", seq)
	}
	if _, err := d.Exec(`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'sketch', 's', '{}')`); err == nil {
		t.Fatal("an unknown kind was accepted")
	}
	var idx int
	d.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'records_user_seq'`).Scan(&idx)
	if idx != 1 {
		t.Error("records_user_seq index missing")
	}
	var left int
	d.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name = 'records_old'`).Scan(&left)
	if left != 0 {
		t.Error("records_old left behind")
	}
}

// The prefs migration rebuilds records again: rows and seq survive, the counter does not go back,
// 'prefs' is accepted (and still no unknown kind).
func TestPrefsMigrationKeepsRecords(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "x.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	for _, f := range []string{"migrations/0001_init.sql", "migrations/0002_strokes_kind.sql"} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := d.Exec(string(b)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := d.Exec(`PRAGMA user_version = 2`); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO users (email, password_hash, created_at) VALUES ('a@x.com', 'h', '')`,
		`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'check', 'c1', '{"id":"c1","ts":1}')`,
		`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'strokes', 's1', NULL)`,
		`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'ink', 'gone', '{}')`,
		`DELETE FROM records WHERE id = 'gone'`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	if _, err := d.Exec(`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'prefs', 'p', '{}')`); err == nil {
		t.Fatal("version 2 accepted a prefs record")
	}
	applied, err := db.Migrate(d)
	if err != nil || len(applied) != 1 {
		t.Fatalf("applied %v, %v", applied, err)
	}
	var n, seq int
	d.QueryRow(`SELECT count(*) FROM records`).Scan(&n)
	d.QueryRow(`SELECT seq FROM records WHERE id = 's1'`).Scan(&seq)
	if n != 2 || seq != 2 {
		t.Fatalf("%d rows, seq of s1 %d; want 2 and 2", n, seq)
	}
	if _, err := d.Exec(`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'prefs', 'prefs-favourites', '{}')`); err != nil {
		t.Fatalf("prefs refused after migration: %v", err)
	}
	d.QueryRow(`SELECT seq FROM records WHERE id = 'prefs-favourites'`).Scan(&seq)
	if seq != 4 {
		t.Errorf("new seq %d, want 4 (the counter must not go back to 3)", seq)
	}
	if _, err := d.Exec(`INSERT INTO records (user_id, kind, id, data) VALUES (1, 'sketch', 's', '{}')`); err == nil {
		t.Fatal("an unknown kind was accepted")
	}
}

// A transaction holds the write lock from the moment it begins, so a read
// followed by a write inside it cannot be invalidated by another connection's
// commit in between ("database is locked", which busy_timeout cannot cure).
func TestTransactionsBeginImmediate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	d, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	tx, err := d.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	// A second handle with no wait: it can only write if tx holds no lock yet.
	other, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(0)")
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	_, err = other.Exec(`INSERT INTO users (email, password_hash, created_at) VALUES ('a@x.com', 'h', '')`)
	if err == nil || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("a write succeeded while a transaction was open (err = %v); transactions must begin immediate", err)
	}
}

// Open must run the settings check, not just ping: both drivers silently
// ignore a misspelled DSN parameter. Swapping the check for a failing one
// proves Open consults it and refuses to return the database.
func TestOpenRefusesWhenSettingsCheckFails(t *testing.T) {
	want := errors.New("settings did not take")
	db.SetCheckSettings(func(context.Context, *sql.DB, sqlitekit.Options) error { return want })
	t.Cleanup(db.ResetCheckSettings)
	d, err := db.Open(filepath.Join(t.TempDir(), "x.db"))
	if err == nil {
		d.Close()
		t.Fatal("Open returned a database whose settings check failed")
	}
	if !errors.Is(err, want) {
		t.Fatalf("Open error = %v, want it to wrap the check's error", err)
	}
}

// Open's DSN really yields the house settings.
func TestOpenAppliesSettings(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "x.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	var fk, busy int
	var mode string
	d.QueryRow(`PRAGMA foreign_keys`).Scan(&fk)
	d.QueryRow(`PRAGMA busy_timeout`).Scan(&busy)
	d.QueryRow(`PRAGMA journal_mode`).Scan(&mode)
	if fk != 1 || busy != 5000 || mode != "wal" {
		t.Errorf("foreign_keys=%d busy_timeout=%d journal_mode=%s", fk, busy, mode)
	}
}

// A database that cannot be opened fails Open itself (via Check), at startup.
func TestOpenFailsOnUnwritablePath(t *testing.T) {
	if _, err := db.Open(filepath.Join(t.TempDir(), "missing", "x.db")); err == nil {
		t.Fatal("Open succeeded in a directory that does not exist")
	}
}
