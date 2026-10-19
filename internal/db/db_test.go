package db_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"calligraphy/internal/db"
	"calligraphy/internal/dbtest"
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

// A newer database means a rollback deploy; running old code against a
// schema it does not know would misread it.
func TestRefusesNewerDatabase(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "x.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Exec("PRAGMA user_version = 999"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Migrate(d); err == nil {
		t.Fatal("migrated a database newer than the build")
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
	if err != nil || len(applied) != 1 {
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
