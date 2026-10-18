// Package dbtest gives each test its own migrated database file. Tests run
// against real SQLite, not a mock: STRICT, CHECK and foreign-key behaviour is
// exactly what a mock would get wrong.
package dbtest

import (
	"database/sql"
	"path/filepath"
	"testing"

	"calligraphy/internal/db"
)

// New opens a fresh, fully migrated database in the test's temp directory.
func New(t testing.TB) *sql.DB {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if _, err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	return d
}
