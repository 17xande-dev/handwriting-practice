package db_test

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"calligraphy/internal/db"
	"calligraphy/internal/dbtest"
)

// A backup is only worth having if it opens and holds the data.
func TestBackupIsARealDatabase(t *testing.T) {
	d := dbtest.New(t)
	if _, err := d.Exec(`INSERT INTO users (email, password_hash, created_at) VALUES ('a@x.com', 'h', '')`); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "backups")
	day := time.Date(2026, 10, 10, 23, 0, 0, 0, time.UTC)
	path, err := db.Backup(t.Context(), d, dir, day)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "handwriting-20261010.db" {
		t.Errorf("name %s", path)
	}
	b, err := sql.Open("sqlite3", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	var n int
	if err := b.QueryRow(`SELECT count(*) FROM users`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("backup has %d users, err %v", n, err)
	}
	// A second run the same day leaves the first backup alone.
	if again, err := db.Backup(t.Context(), d, dir, day.Add(30*time.Minute)); err != nil || again != path {
		t.Errorf("second backup: %s %v", again, err)
	}
	if _, err := os.Stat(path + ".partial"); !os.IsNotExist(err) {
		t.Error("partial file left behind")
	}
}

func TestPruneKeepsNewestAndOnlyTouchesBackups(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{
		"handwriting-20261001.db", "handwriting-20261002.db", "handwriting-20261003.db",
		"handwriting.db", "notes.txt", "handwriting-20261004.db.partial",
	} {
		os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o600)
	}
	removed, err := db.Prune(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 1 || removed[0] != "handwriting-20261001.db" {
		t.Fatalf("removed %v", removed)
	}
	for _, keep := range []string{"handwriting-20261002.db", "handwriting-20261003.db", "handwriting.db", "notes.txt", "handwriting-20261004.db.partial"} {
		if _, err := os.Stat(filepath.Join(dir, keep)); err != nil {
			t.Errorf("%s was removed", keep)
		}
	}
}
