package db_test

import (
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
