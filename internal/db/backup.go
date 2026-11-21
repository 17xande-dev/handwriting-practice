package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// backupPrefix and backupSuffix frame the dated file names; Prune deletes
// only files of exactly this shape, never anything else in the directory.
const (
	backupPrefix = "handwriting-"
	backupSuffix = ".db"
)

// Backup writes a consistent copy of the database to dir as
// handwriting-YYYYMMDD.db, unless today's already exists, and returns its
// path. VACUUM INTO is SQLite's own online backup: it copies a single
// transaction's view, so it is safe while the server writes, which a file
// copy of a WAL database is not.
func Backup(ctx context.Context, d *sql.DB, dir string, now time.Time) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, backupPrefix+now.UTC().Format("20060102")+backupSuffix)
	if _, err := os.Stat(path); err == nil {
		return path, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	// Written under a hidden temporary name and renamed, so a crash mid-backup
	// never leaves a truncated file that looks like a good one, and the temp
	// can never match Prune's pattern. VACUUM INTO refuses an existing file; a
	// leftover is from a crashed attempt.
	tmp := filepath.Join(dir, "."+filepath.Base(path)+".tmp")
	if err := os.Remove(tmp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if _, err := d.ExecContext(ctx, `VACUUM INTO ?`, tmp); err != nil {
		os.Remove(tmp)
		return "", fmt.Errorf("db: backup: %w", err)
	}
	// The copy holds account data and password hashes: owner-only.
	if err := os.Chmod(tmp, 0o600); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return path, nil
}

// Prune keeps the newest keep backups in dir and deletes the rest. keep is
// clamped to at least 1, so Prune can never delete the backup just made.
func Prune(dir string, keep int) ([]string, error) {
	keep = max(keep, 1)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var backups []string
	for _, e := range entries {
		n := e.Name()
		if e.Type().IsRegular() && strings.HasPrefix(n, backupPrefix) && strings.HasSuffix(n, backupSuffix) &&
			len(n) == len(backupPrefix)+8+len(backupSuffix) {
			backups = append(backups, n)
		}
	}
	// The date in the name sorts as text.
	sort.Strings(backups)
	var removed []string
	for len(backups) > keep {
		if err := os.Remove(filepath.Join(dir, backups[0])); err != nil {
			return removed, err
		}
		removed = append(removed, backups[0])
		backups = backups[1:]
	}
	return removed, nil
}
