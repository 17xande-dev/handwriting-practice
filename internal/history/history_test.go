package history

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"calligraphy/internal/dbtest"
)

var ctx = context.Background()

func setup(t *testing.T) (*Store, int64, int64) {
	t.Helper()
	d := dbtest.New(t)
	for _, e := range []string{"a@x.com", "b@x.com"} {
		if _, err := d.Exec(`INSERT INTO users (email, password_hash, created_at) VALUES (?, 'h', '')`, e); err != nil {
			t.Fatal(err)
		}
	}
	return NewStore(d), 1, 2
}

func run(kind, id string) Record {
	return Record{Kind: kind, ID: id, Data: json.RawMessage(fmt.Sprintf(`{"id":%q,"ts":1700000000000}`, id))}
}

func pullAll(t *testing.T, s *Store, user, cursor int64) ([]Record, int64) {
	t.Helper()
	recs, next, more, err := s.Pull(ctx, user, cursor, 1000)
	if err != nil || more {
		t.Fatalf("pull: %v more=%v", err, more)
	}
	return recs, next
}

// One user's history is never visible to another.
func TestUsersAreIsolated(t *testing.T) {
	s, a, b := setup(t)
	s.Push(ctx, a, []Record{run("check", "r1")}, nil)
	if recs, _ := pullAll(t, s, b, 0); len(recs) != 0 {
		t.Fatalf("b sees %d of a's records", len(recs))
	}
	// The same id is a different record for a different user.
	if err := s.Push(ctx, b, []Record{run("check", "r1")}, []Ref{{"check", "r1"}}); err != nil {
		t.Fatal(err)
	}
	if recs, _ := pullAll(t, s, a, 0); len(recs) != 1 || recs[0].Data == nil {
		t.Fatal("b's deletion reached a's record")
	}
}

// A device retries a sync whose response it never got: nothing doubles.
func TestPushIsIdempotent(t *testing.T) {
	s, a, _ := setup(t)
	batch := []Record{run("check", "r1"), run("ink", "i1"), run("ink", "i2")}
	s.Push(ctx, a, batch, nil)
	s.Push(ctx, a, batch, nil)
	if recs, _ := pullAll(t, s, a, 0); len(recs) != 3 {
		t.Fatalf("%d records after pushing 3 twice", len(recs))
	}
}

// The iPad deletes a check and its ink while the web, not yet synced, still has
// them: its next push must not bring them back.
func TestTombstoneBeatsLaterPush(t *testing.T) {
	s, a, _ := setup(t)
	s.Push(ctx, a, []Record{run("ink", "i1")}, nil)
	_, cursor := pullAll(t, s, a, 0)

	s.Push(ctx, a, nil, []Ref{{"ink", "i1"}})
	s.Push(ctx, a, []Record{run("ink", "i1")}, nil)

	recs, next := pullAll(t, s, a, cursor)
	if len(recs) != 1 || recs[0].Data != nil || recs[0].ID != "i1" {
		t.Fatalf("after delete + re-push: %+v", recs)
	}
	if next <= cursor {
		t.Error("cursor did not advance past the tombstone")
	}
	if recs, _ := pullAll(t, s, a, 0); len(recs) != 1 || recs[0].Data != nil {
		t.Fatalf("full pull: %+v", recs)
	}
}

// Deleting a run the server never had still records the deletion, for the
// device that does have it.
func TestDeleteOfUnknownRunIsRecorded(t *testing.T) {
	s, a, _ := setup(t)
	s.Push(ctx, a, nil, []Ref{{"check", "ghost"}})
	recs, _ := pullAll(t, s, a, 0)
	if len(recs) != 1 || recs[0].Data != nil {
		t.Fatalf("%+v", recs)
	}
	// A second deletion of the same id adds nothing new.
	_, cursor := pullAll(t, s, a, 0)
	s.Push(ctx, a, nil, []Ref{{"check", "ghost"}})
	if recs, _ := pullAll(t, s, a, cursor); len(recs) != 0 {
		t.Errorf("repeat deletion produced %d changes", len(recs))
	}
}

// Added and removed between two syncs: the push carries both, and the
// result is deleted.
func TestAddThenDeleteInOnePush(t *testing.T) {
	s, a, _ := setup(t)
	s.Push(ctx, a, []Record{run("check", "r1")}, []Ref{{"check", "r1"}})
	recs, _ := pullAll(t, s, a, 0)
	if len(recs) != 1 || recs[0].Data != nil {
		t.Fatalf("%+v", recs)
	}
}

func TestPullPages(t *testing.T) {
	s, a, _ := setup(t)
	var batch []Record
	for i := range 25 {
		batch = append(batch, run("check", fmt.Sprint("r", i)))
	}
	s.Push(ctx, a, batch, nil)
	seen := map[string]bool{}
	var cursor int64
	for pages := 0; ; pages++ {
		if pages > 5 {
			t.Fatal("pagination does not end")
		}
		recs, next, more, err := s.Pull(ctx, a, cursor, 10)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range recs {
			if seen[r.ID] {
				t.Fatalf("%s seen twice", r.ID)
			}
			seen[r.ID] = true
		}
		cursor = next
		if !more {
			break
		}
	}
	if len(seen) != 25 {
		t.Fatalf("saw %d of 25", len(seen))
	}
}

func TestCheckRecord(t *testing.T) {
	good := `{"id":"abc","ts":1700000000000,"anything":"else"}`
	if id, err := CheckRecord("ink", json.RawMessage(good)); err != nil || id != "abc" {
		t.Fatalf("good record: %q %v", id, err)
	}
	for name, raw := range map[string]string{
		"array":      `[1]`,
		"no id":      `{"ts":1}`,
		"numeric id": `{"id":5,"ts":1}`,
		"empty id":   `{"id":"","ts":1}`,
		"long id":    `{"id":"` + strings.Repeat("a", 65) + `","ts":1}`,
		"no ts":      `{"id":"a"}`,
		"string ts":  `{"id":"a","ts":"1"}`,
		"zero ts":    `{"id":"a","ts":0}`,
	} {
		if _, err := CheckRecord("ink", json.RawMessage(raw)); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if _, err := CheckRecord("chord", json.RawMessage(good)); err == nil {
		t.Error("unknown kind accepted")
	}
}
