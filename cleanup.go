package main

import (
	"context"
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"calligraphy/internal/account"

	"github.com/17xande-dev/sqlitekit"
)

// keepBackups is a week of daily backups.
const keepBackups = 7

// backups describes the daily backups: dated VACUUM INTO copies beside the
// database, so in the container they land on the same data volume. That
// guards against a bad migration or a mistaken delete, not against losing the
// volume: an off-box copy is a separate, still-open decision (README).
func backups(dbPath string) sqlitekit.Backups {
	return sqlitekit.Backups{
		Dir:    filepath.Join(filepath.Dir(dbPath), "backups"),
		Prefix: "handwriting-",
		Layout: "20060102",
		Keep:   keepBackups,
	}
}

// removeOldPartials deletes handwriting-*.partial files, the temporaries an
// earlier version left when it crashed mid-backup. sqlitekit names and sweeps
// its own temporaries, so nothing makes these any more and nothing else would
// ever remove them.
func removeOldPartials(log *slog.Logger, dir string) {
	matches, err := filepath.Glob(filepath.Join(dir, "handwriting-*.partial"))
	if err != nil {
		return
	}
	for _, m := range matches {
		if err := os.Remove(m); err != nil {
			log.Error("remove old partial backup", "path", m, "err", err)
			continue
		}
		log.Info("removed old partial backup", "path", m)
	}
}

// maintain runs the daily chores until ctx ends: back up the database (which
// also prunes old backups), and delete expired browser sessions. The first
// run is at startup, but there is one backup per day: if today's already
// exists a restart writes none, so the daily file is the first of the day, not
// a snapshot of what a deploy started from. Take a backup before a deploy.
func maintain(ctx context.Context, log *slog.Logger, database *sql.DB, accounts *account.Store, dbPath string) {
	b := backups(dbPath)
	removeOldPartials(log, b.Dir)
	tick := time.NewTicker(24 * time.Hour)
	defer tick.Stop()
	for {
		if path, made, err := b.Run(ctx, database, time.Now()); err != nil {
			log.Error("backup", "err", err)
		} else if made {
			log.Info("backup", "path", path)
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
