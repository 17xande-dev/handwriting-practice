// Command calligraphy serves the italic handwriting practice app: worksheets,
// the Deno-bundled TypeScript that checks the writing, and accounts that sync
// the history between devices.
package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"calligraphy/internal/account"
	"calligraphy/internal/config"
	"calligraphy/internal/db"
	"calligraphy/internal/fonts"
	"calligraphy/internal/handler"
	"calligraphy/internal/history"
	"calligraphy/internal/middleware"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe the running server's /healthz and exit 0 if healthy (see healthcheck.go)")
	migrateStatus := flag.Bool("migrate-status", false, "list each database migration as applied or pending, and exit")
	addAdminEmail := flag.String("add-admin", "", "create an admin `EMAIL` with a generated password, print it, and exit")
	resetEmail := flag.String("reset-password", "", "give `EMAIL` a new generated password, print it, end their sessions, and exit")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if *healthcheck {
		cfg, err := config.Load(os.Getenv)
		if err == nil {
			err = probe(cfg.Addr, 3*time.Second)
		}
		if err != nil {
			log.Error("unhealthy", "err", err)
			os.Exit(1)
		}
		return
	}
	if *addAdminEmail != "" || *resetEmail != "" {
		err := withStore(func(ctx context.Context, store *account.Store) error {
			if *addAdminEmail != "" {
				return addAdmin(ctx, store, *addAdminEmail, os.Stdout)
			}
			return resetPassword(ctx, store, *resetEmail, os.Stdout)
		})
		if err != nil {
			log.Error("account command", "err", err)
			os.Exit(1)
		}
		return
	}
	if *migrateStatus {
		if err := printMigrateStatus(); err != nil {
			log.Error("migrate-status", "err", err)
			os.Exit(1)
		}
		return
	}
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	database, err := openDB(cfg)
	if err != nil {
		return err
	}
	defer database.Close()
	applied, err := db.Migrate(database)
	for _, name := range applied {
		log.Info("migrated", "migration", name)
	}
	if err != nil {
		return err
	}

	accounts := account.NewStore(database)
	h, err := handler.New(handler.Options{
		Fonts:    fonts.Builtin,
		Log:      log,
		Accounts: accounts,
		History:  history.NewStore(database),
		ClientIP: middleware.ClientIP(cfg.ClientIPHeader),
		HSTS:     cfg.HSTS,
	})
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           middleware.Chain(h, middleware.Logging(log)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go maintain(ctx, log, database, accounts, cfg.DBPath)

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.Addr)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}

	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

// openDB opens the configured database. The flag commands share it with the
// server, so each refuses a missing DB_PATH the same way.
func openDB(cfg config.Config) (*sql.DB, error) {
	if cfg.DBPath == "" {
		return nil, errors.New("DB_PATH is not set: it names the SQLite file for accounts and history (e.g. /data/handwriting.db)")
	}
	return db.Open(cfg.DBPath)
}

func printMigrateStatus() error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	database, err := openDB(cfg)
	if err != nil {
		return err
	}
	defer database.Close()
	lines, err := db.Status(database)
	if err != nil {
		return err
	}
	for _, l := range lines {
		fmt.Println(l)
	}
	return nil
}

// withStore opens and migrates the database for a one-off command. Migrating
// here lets -add-admin run against a brand-new volume before the server's
// first start.
func withStore(fn func(context.Context, *account.Store) error) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	database, err := openDB(cfg)
	if err != nil {
		return err
	}
	defer database.Close()
	if _, err := db.Migrate(database); err != nil {
		return err
	}
	return fn(context.Background(), account.NewStore(database))
}
