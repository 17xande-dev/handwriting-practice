package db_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"calligraphy/internal/db"

	"github.com/17xande-dev/sqlitekit"
)

// A status command that creates a database makes "is it set up?" answer yes
// by asking; it must leave a missing path alone, lock file included.
func TestStatusAtMissingDatabaseCreatesNothing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "none.db")
	lines, err := db.StatusAt(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || !strings.Contains(lines[0], "not yet migrated") {
		t.Fatalf("status = %q", lines)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("status created %d files in the data directory", len(entries))
	}
}

// Reading the status of an empty file still writes goose's version table (and
// Check can switch the file to WAL), so it must do that under the migration
// lock: held elsewhere, status waits and writes nothing.
func TestStatusAtWaitsForTheMigrationLockBeforeWriting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fresh.db")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	release, err := sqlitekit.MigrationLock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan []string, 1)
	go func() {
		lines, err := db.StatusAt(path)
		if err != nil {
			t.Error(err)
		}
		done <- lines
	}()
	select {
	case <-done:
		t.Fatal("status finished while another process held the migration lock")
	case <-time.After(400 * time.Millisecond):
	}
	if fi, err := os.Stat(path); err != nil || fi.Size() != 0 {
		t.Fatalf("status wrote to the database while the lock was held (%v, %v)", fi, err)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
	select {
	case lines := <-done:
		if len(lines) == 0 || !strings.HasPrefix(lines[0], "pending") {
			t.Fatalf("status = %q, want every migration pending", lines)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("status did not finish after the lock was released")
	}
}
