// Package history stores each user's synced practice records.
//
// The apps are local-first: each keeps its own history and treats the
// server as a place to swap records with the user's other devices. A record
// is one checked line ("check") or the ink of one checked attempt ("ink"),
// stored as the client's own JSON and never edited, so syncing is a union by
// (kind, id). A deletion is a tombstone: the row stays with data NULL, so
// every other device learns to delete it too.
//
// Every insert and tombstone takes a new seq. A client keeps the highest
// seq it has seen as its cursor and asks only for what came after it.
package history

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// Kinds are the two records the apps keep: a checked line, and the
// quantized strokes of one checked attempt.
var Kinds = []string{"check", "ink"}

func validKind(k string) bool {
	return k == "check" || k == "ink"
}

// MaxRecordBytes bounds one record's JSON. A check is a few KB; the ink of a
// long line, quantized, is the largest.
const MaxRecordBytes = 64 << 10

// Record is one record. Data is nil for a tombstone.
type Record struct {
	Kind string
	ID   string
	Data json.RawMessage
}

// Ref names a record without its data (a deletion).
type Ref struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// MaxIDBytes is the longest record id, in bytes of UTF-8.
const MaxIDBytes = 64

// topLevel reads a JSON object's members in order, keeping each name exactly
// as written. Go's own struct decoding would match "ID" to a field called
// "id" and let the last duplicate win, which is a different reading from the
// iPad's; reading the members ourselves lets CheckRecord refuse the ambiguity.
func topLevel(raw json.RawMessage) (names []string, values map[string]json.RawMessage, err error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, nil, fmt.Errorf("not a JSON object")
	}
	values = map[string]json.RawMessage{}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, nil, fmt.Errorf("not a JSON object")
		}
		name, _ := t.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, nil, fmt.Errorf("not a JSON object")
		}
		names = append(names, name)
		values[name] = v
	}
	if _, err := dec.Token(); err != nil {
		return nil, nil, fmt.Errorf("not a JSON object")
	}
	return names, values, nil
}

// CheckRecord reports why raw cannot be stored as a record of kind, or nil, and
// returns the record's id. The server checks only what syncing relies on: an
// object with a string id (1-64 bytes of UTF-8) and a positive numeric ts, no
// two top-level names that differ only in case, and a size. The rest of the
// shape belongs to the apps, which validate every record they read anyway.
//
// Whenever the record has a string "id", it is returned alongside the error,
// whatever the reason for refusing it, so the client can match the rejection
// to its queue and stop resending the record.
func CheckRecord(kind string, raw json.RawMessage) (string, error) {
	if !validKind(kind) {
		return "", fmt.Errorf("unknown kind %q", kind)
	}
	names, values, err := topLevel(raw)
	if err != nil {
		return "", err
	}
	var id string
	hasID := json.Unmarshal(values["id"], &id) == nil && values["id"] != nil && values["id"][0] == '"'
	reject := func(format string, a ...any) (string, error) {
		if hasID {
			return id, fmt.Errorf(format, a...)
		}
		return "", fmt.Errorf(format, a...)
	}
	if len(raw) > MaxRecordBytes {
		return reject("record over %d bytes", MaxRecordBytes)
	}
	seen := make(map[string]string, len(names))
	for _, n := range names {
		folded := strings.ToLower(n)
		if prev, dup := seen[folded]; dup {
			return reject("duplicate top-level field: %q and %q differ at most in case", prev, n)
		}
		seen[folded] = n
	}
	if !hasID || len(id) == 0 || len(id) > MaxIDBytes {
		return reject("id must be a string of 1-%d bytes", MaxIDBytes)
	}
	var ts float64
	if v := values["ts"]; v == nil || json.Unmarshal(v, &ts) != nil || !(ts > 0) || math.IsInf(ts, 0) {
		return reject("ts must be a positive number")
	}
	return id, nil
}

// Push stores new records and deletions in one transaction, so a failed sync
// leaves nothing half-applied and the client can simply send it again.
//
// A record that already exists, or was deleted, is skipped: records are never
// edited, and a deletion must win over a device that still has the record and
// pushes it again before it has heard of the deletion. Records are applied
// before deletions, so a record added and removed between two syncs ends up
// deleted.
func (s *Store) Push(ctx context.Context, userID int64, records []Record, deleted []Ref) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	insert, err := tx.PrepareContext(ctx, `INSERT INTO records (user_id, kind, id, data) VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, kind, id) DO NOTHING`)
	if err != nil {
		return err
	}
	defer insert.Close()
	for _, r := range records {
		if _, err := insert.ExecContext(ctx, userID, r.Kind, r.ID, string(r.Data)); err != nil {
			return err
		}
	}
	// A tombstone replaces the row (delete, then insert) rather than
	// updating it, so it takes a new, higher seq and every device's next
	// pull sees it. An id already tombstoned is left alone.
	for _, d := range deleted {
		if !validKind(d.Kind) || len(d.ID) == 0 || len(d.ID) > MaxIDBytes {
			continue
		}
		res, err := tx.ExecContext(ctx, `DELETE FROM records WHERE user_id = ? AND kind = ? AND id = ? AND data IS NOT NULL`,
			userID, d.Kind, d.ID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			// Not stored as a live record: either already a tombstone (leave it)
			// or never pushed (record the tombstone anyway, in case another
			// device still holds it).
			if _, err := tx.ExecContext(ctx, `INSERT INTO records (user_id, kind, id, data) VALUES (?, ?, ?, NULL)
				ON CONFLICT(user_id, kind, id) DO NOTHING`, userID, d.Kind, d.ID); err != nil {
				return err
			}
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO records (user_id, kind, id, data) VALUES (?, ?, ?, NULL)`,
			userID, d.Kind, d.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Pull returns up to limit changes after cursor, oldest first, whose data
// adds up to at most maxBytes (a tombstone counts for its id and a little
// framing), the cursor to ask from next time, and whether more are waiting.
// A page always holds at least one change, so a client can always advance.
func (s *Store) Pull(ctx context.Context, userID, cursor int64, limit, maxBytes int) ([]Record, int64, bool, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT seq, kind, id, data FROM records
		WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?`, userID, cursor, limit+1)
	if err != nil {
		return nil, cursor, false, err
	}
	defer rows.Close()
	var out []Record
	next := cursor
	more := false
	used := 0
	for rows.Next() {
		if len(out) == limit {
			more = true
			break
		}
		var seq int64
		var r Record
		var data sql.NullString
		if err := rows.Scan(&seq, &r.Kind, &r.ID, &data); err != nil {
			return nil, cursor, false, err
		}
		size := 64 + len(r.ID)
		if data.Valid {
			r.Data = json.RawMessage(data.String)
			size = len(data.String)
		}
		if len(out) > 0 && used+size > maxBytes {
			more = true
			break
		}
		used += size
		out = append(out, r)
		next = seq
	}
	return out, next, more, rows.Err()
}
