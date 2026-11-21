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
	if _, err := os.Stat(filepath.Join(dir, "."+filepath.Base(path)+".tmp")); !os.IsNotExist(err) {
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

// The backup holds account data and password hashes: nobody but the owner
// may read it, and the directory is closed to others too.
func TestBackupIsOwnerOnly(t *testing.T) {
	d := dbtest.New(t)
	dir := filepath.Join(t.TempDir(), "backups")
	path, err := db.Backup(t.Context(), d, dir, time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("backup mode %v, err %v; want 0600", fi.Mode().Perm(), err)
	}
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("backup dir mode %v, err %v; want 0700", fi.Mode().Perm(), err)
	}
}

// Prune runs right after Backup, so a keep of zero must never delete the
// backup just made.
func TestPruneKeepsAtLeastOne(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"handwriting-20261001.db", "handwriting-20261002.db"} {
		os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o600)
	}
	for _, keep := range []int{0, -3} {
		if _, err := db.Prune(dir, keep); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(dir, "handwriting-20261002.db")); err != nil {
			t.Fatalf("keep=%d removed the newest backup", keep)
		}
	}
}

// VACUUM INTO refuses an existing file, so a temp left by a crashed run must
// be replaced rather than wedge every later backup; and the hidden temp name
// is never something Prune can match.
func TestBackupReplacesLeftoverTemp(t *testing.T) {
	d := dbtest.New(t)
	dir := t.TempDir()
	day := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)
	tmp := filepath.Join(dir, ".handwriting-20261010.db.tmp")
	if err := os.WriteFile(tmp, []byte("crashed"), 0o600); err != nil {
		t.Fatal(err)
	}
	path, err := db.Backup(t.Context(), d, dir, day)
	if err != nil {
		t.Fatalf("backup with leftover temp: %v", err)
	}
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Error("leftover temp still present")
	}
	b, err := sql.Open("sqlite3", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	var n int
	if err := b.QueryRow(`SELECT count(*) FROM sqlite_master`).Scan(&n); err != nil || n == 0 {
		t.Fatalf("backup unreadable: %d %v", n, err)
	}
}

// A hidden temp, and files that merely resemble a backup, are foreign to Prune.
func TestPruneNeverTouchesForeignFiles(t *testing.T) {
	dir := t.TempDir()
	foreign := []string{".handwriting-20260101.db.tmp", "handwriting-20260101.db.bak", "xhandwriting-20260101.db", "handwriting-2026.db"}
	for _, n := range append([]string{"handwriting-20261001.db", "handwriting-20261002.db"}, foreign...) {
		os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o600)
	}
	if _, err := db.Prune(dir, 1); err != nil {
		t.Fatal(err)
	}
	for _, n := range foreign {
		if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
			t.Errorf("foreign file %s was removed", n)
		}
	}
}
