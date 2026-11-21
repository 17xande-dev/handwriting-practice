package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"calligraphy/internal/account"
	"calligraphy/internal/dbtest"
)

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// The wiring is what the operator relies on: name layout, retention and
// location of the backups. The copying itself is sqlitekit's to test.
func TestBackupsConfig(t *testing.T) {
	b := backups("/data/handwriting.db")
	if b.Dir != "/data/backups" || b.Prefix != "handwriting-" || b.Layout != "20060102" || b.Keep != 7 || b.Location != nil {
		t.Fatalf("backups = %+v", b)
	}
}

// maintain must actually call Backups.Run at startup, and tidy the temporaries
// an older version left behind.
func TestMaintainTakesABackupAndRemovesOldPartials(t *testing.T) {
	d := dbtest.New(t)
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "handwriting.db")
	bdir := filepath.Join(dir, "backups")
	if err := os.MkdirAll(bdir, 0o700); err != nil {
		t.Fatal(err)
	}
	partial := filepath.Join(bdir, "handwriting-20261004.db.partial")
	other := filepath.Join(bdir, "notes.txt")
	// A widened glob (*.partial) would delete this one.
	foreign := filepath.Join(bdir, "notes.partial")
	for _, f := range []string{partial, other, foreign} {
		if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		maintain(ctx, quietLog(), d, account.NewStore(d), dbPath)
		close(done)
	}()
	want := filepath.Join(bdir, "handwriting-"+time.Now().UTC().Format("20060102")+".db")
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(want); err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("maintain made no backup %s", want)
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Error("old .partial file was not removed")
	}
	if _, err := os.Stat(other); err != nil {
		t.Error("an unrelated file was removed")
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Error("notes.partial was removed: the glob is too wide")
	}
}
