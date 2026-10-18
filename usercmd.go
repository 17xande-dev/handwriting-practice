package main

import (
	"context"
	"fmt"
	"io"

	"calligraphy/internal/account"
	"calligraphy/internal/auth"
)

// The two operator commands. Everything else about accounts happens in the
// admin pages (/admin/users); these exist only to create the first admin and
// to get back in if every admin is locked out. Both run inside the
// container: docker exec <container> /calligraphy -add-admin EMAIL.
//
// The password is generated and printed rather than typed: the image has no
// shell or stty to turn off echo, and reading a password from a command-line
// argument would put it in shell history and ps.

func addAdmin(ctx context.Context, store *account.Store, email string, out io.Writer) error {
	pw := auth.GeneratePassword()
	hash, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}
	u, err := store.Create(ctx, email, hash, true)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "Created admin %s.\nPassword (shown once): %s\nSign in at /account and change it.\n", u.Email, pw)
	return nil
}

func resetPassword(ctx context.Context, store *account.Store, email string, out io.Writer) error {
	u, err := store.ByEmail(ctx, email)
	if err != nil {
		return fmt.Errorf("%s: %w", email, err)
	}
	pw := auth.GeneratePassword()
	hash, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}
	if err := store.SetPassword(ctx, u.ID, hash, 0); err != nil {
		return err
	}
	fmt.Fprintf(out, "New password for %s (shown once): %s\nTheir other sign-ins have been ended.\n", u.Email, pw)
	return nil
}
