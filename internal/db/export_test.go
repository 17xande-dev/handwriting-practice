package db

import (
	"context"
	"database/sql"

	"github.com/17xande-dev/sqlitekit"
)

func SetCheckSettings(f func(context.Context, *sql.DB, sqlitekit.Options) error) { checkSettings = f }
func ResetCheckSettings()                                                        { checkSettings = sqlitekit.Check }

// SetStatusHook runs f inside StatusAt after the status is read, before the
// database is closed and the lock released; the returned func restores it.
func SetStatusHook(f func()) (restore func()) {
	old := statusHook
	statusHook = f
	return func() { statusHook = old }
}
