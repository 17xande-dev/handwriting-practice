package main

import (
	"context"
	"database/sql"
	"log/slog"
	"path/filepath"
	"time"

	"calligraphy/internal/account"
	"calligraphy/internal/db"
)

// keepBackups is a week of daily backups.
const keepBackups = 7

// backupDir sits beside the database, so in the container the backups land
// on the same data volume. That guards against a bad migration or a
// mistaken delete, not against losing the volume: an off-box copy is a
// separate, still-open decision (README).
func backupDir(dbPath string) string {
	return filepath.Join(filepath.Dir(dbPath), "backups")
}

// maintain runs the daily chores until ctx ends: back up the database,
// prune old backups, and delete expired browser sessions. The first run is
// at startup, so a deploy always leaves a fresh backup of the state it
// started from.
func maintain(ctx context.Context, log *slog.Logger, database *sql.DB, accounts *account.Store, dbPath string) {
	tick := time.NewTicker(24 * time.Hour)
	defer tick.Stop()
	for {
		dir := backupDir(dbPath)
		if path, err := db.Backup(ctx, database, dir, time.Now()); err != nil {
			log.Error("backup", "err", err)
		} else {
			log.Info("backup", "path", path)
			if removed, err := db.Prune(dir, keepBackups); err != nil {
				log.Error("prune backups", "err", err)
			} else if len(removed) > 0 {
				log.Info("pruned backups", "removed", removed)
			}
		}
		if n, err := accounts.DeleteExpired(ctx); err != nil {
			log.Error("expire sessions", "err", err)
		} else if n > 0 {
			log.Info("expired sessions", "deleted", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
