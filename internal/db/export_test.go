package db

import (
	"context"
	"database/sql"

	"github.com/17xande-dev/sqlitekit"
)

func SetCheckSettings(f func(context.Context, *sql.DB, sqlitekit.Options) error) { checkSettings = f }
func ResetCheckSettings()                                                        { checkSettings = sqlitekit.Check }
