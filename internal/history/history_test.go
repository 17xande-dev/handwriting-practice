package history

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

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
	recs, next, more, err := s.Pull(ctx, user, cursor, 1000, 4<<20)
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
		recs, next, more, err := s.Pull(ctx, a, cursor, 10, 4<<20)
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

// Whatever the reason a record is refused, its id comes back with the
// reason, or a client cannot tell which queued record was refused and would
// resend it for ever.
func TestCheckRecordRejectionsCarryTheID(t *testing.T) {
	for name, raw := range map[string]string{
		"no ts":        `{"id":"a"}`,
		"string ts":    `{"id":"a","ts":"1"}`,
		"zero ts":      `{"id":"a","ts":0}`,
		"case clash":   `{"id":"a","ts":1,"ID":"b"}`,
		"oversize":     `{"id":"a","ts":1,"x":"` + strings.Repeat("y", MaxRecordBytes) + `"}`,
		"oversize ts":  `{"id":"a","x":"` + strings.Repeat("y", MaxRecordBytes) + `"}`,
		"too long id":  `{"id":"` + strings.Repeat("a", 65) + `","ts":1}`,
		"multibyte id": `{"id":"` + strings.Repeat("é", 33) + `","ts":1}`,
		"empty id":     `{"id":"","ts":1}`,
	} {
		id, err := CheckRecord("check", json.RawMessage(raw))
		if err == nil {
			t.Errorf("%s accepted", name)
			continue
		}
		want := `a`
		switch name {
		case "too long id":
			want = strings.Repeat("a", 65)
		case "multibyte id":
			want = strings.Repeat("é", 33)
		case "empty id":
			want = ""
		}
		if id != want {
			t.Errorf("%s: rejected with id %q, want %q (%v)", name, truncate(id), truncate(want), err)
		}
	}
	// Not a string id: nothing to report.
	if id, err := CheckRecord("check", json.RawMessage(`{"id":5,"ts":1}`)); err == nil || id != "" {
		t.Errorf("numeric id: %q %v", id, err)
	}
}

func truncate(s string) string {
	if len(s) > 20 {
		return s[:20] + "..."
	}
	return s
}

// "id" and "ID" would read as one field to Go's decoder and two to the
// iPad's, so a record with both is refused rather than stored ambiguously.
func TestCheckRecordRefusesCaseInsensitiveDuplicates(t *testing.T) {
	for _, raw := range []string{
		`{"id":"a","ts":1,"ID":"b"}`,
		`{"id":"a","ts":1,"Ts":2}`,
		`{"id":"a","ts":1,"note":1,"NOTE":2}`,
		`{"id":"a","ts":1,"id":"b"}`,
	} {
		if _, err := CheckRecord("check", json.RawMessage(raw)); err == nil || !strings.Contains(err.Error(), "duplicate top-level field") {
			t.Errorf("%s: %v", raw, err)
		}
	}
	// A record with only "ID" has no "id" the iPad would find either.
	if _, err := CheckRecord("check", json.RawMessage(`{"ID":"a","ts":1}`)); err == nil {
		t.Error("an upper-case-only ID was accepted")
	}
}

// A pull page is capped by the bytes it carries as well as by its record
// count, and always advances by at least one record.
func TestPullCapsPagesByBytes(t *testing.T) {
	s, user, _ := setup(t)
	pad := strings.Repeat("x", 1000)
	var recs []Record
	for i := range 10 {
		id := fmt.Sprintf("r%d", i)
		recs = append(recs, Record{Kind: "check", ID: id, Data: json.RawMessage(fmt.Sprintf(`{"id":%q,"ts":1,"p":%q}`, id, pad))})
	}
	if err := s.Push(ctx, user, recs, nil); err != nil {
		t.Fatal(err)
	}
	var cursor int64
	var pages, total int
	for {
		got, next, more, err := s.Pull(ctx, user, cursor, 1000, 3500)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) == 0 || len(got) > 3 {
			t.Fatalf("page of %d records under a 3500 byte cap (1 KB each)", len(got))
		}
		total += len(got)
		pages++
		cursor = next
		if !more {
			break
		}
	}
	if total != 10 || pages != 4 {
		t.Errorf("%d records in %d pages, want 10 in 4", total, pages)
	}
	// One record bigger than the cap still comes back alone.
	got, _, _, err := s.Pull(ctx, user, 0, 1000, 10)
	if err != nil || len(got) != 1 {
		t.Errorf("tiny cap: %d records, %v", len(got), err)
	}
}

func strokesRec(id string, ts int) Record {
	return Record{Kind: "strokes", ID: id, Data: json.RawMessage(fmt.Sprintf(`{"id":%q,"ts":%d}`, id, ts))}
}

// A strokes record is replaced by a greater ts (taking a new seq so other devices pull it), never by an
// equal or older one; the other kinds stay immutable.
func TestStrokesRecordsReplaceByTS(t *testing.T) {
	s, a, _ := setup(t)
	s.Push(ctx, a, []Record{strokesRec("strokes-x", 10)}, nil)
	_, c1 := pullAll(t, s, a, 0)
	s.Push(ctx, a, []Record{strokesRec("strokes-x", 10), strokesRec("strokes-x", 5)}, nil)
	if recs, c := pullAll(t, s, a, c1); len(recs) != 0 || c != c1 {
		t.Fatalf("equal or older ts changed the record: %d", len(recs))
	}
	s.Push(ctx, a, []Record{strokesRec("strokes-x", 20)}, nil)
	recs, _ := pullAll(t, s, a, c1)
	if len(recs) != 1 || recordTS(recs[0].Data) != 20 {
		t.Fatalf("newer ts did not replace: %+v", recs)
	}
	// An ink record with a newer ts does not replace the stored one.
	s.Push(ctx, a, []Record{run("ink", "i1")}, nil)
	_, c2 := pullAll(t, s, a, 0)
	s.Push(ctx, a, []Record{{Kind: "ink", ID: "i1", Data: json.RawMessage(`{"id":"i1","ts":1900000000000}`)}}, nil)
	if recs, _ := pullAll(t, s, a, c2); len(recs) != 0 {
		t.Fatal("an ink record was replaced")
	}
}

func TestCheckRecordAcceptsStrokes(t *testing.T) {
	if id, err := CheckRecord("strokes", json.RawMessage(`{"id":"strokes-italic","ts":5}`)); err != nil || id != "strokes-italic" {
		t.Fatalf("%q %v", id, err)
	}
	if _, err := CheckRecord("sketch", json.RawMessage(`{"id":"a","ts":5}`)); err == nil {
		t.Fatal("unknown kind accepted")
	}
}

func prefsRec(ts int) Record {
	return Record{Kind: "prefs", ID: "prefs-favourites", Data: json.RawMessage(fmt.Sprintf(`{"id":"prefs-favourites","ts":%d,"v":1,"favourites":[]}`, ts))}
}

// A prefs record is edited in place like strokes: a greater ts replaces it with a new seq, an equal or
// older one is ignored, and a tombstone wins over any later push.
func TestPrefsRecordsReplaceByTS(t *testing.T) {
	s, a, _ := setup(t)
	s.Push(ctx, a, []Record{prefsRec(10)}, nil)
	_, c1 := pullAll(t, s, a, 0)
	s.Push(ctx, a, []Record{prefsRec(10), prefsRec(5)}, nil)
	if recs, c := pullAll(t, s, a, c1); len(recs) != 0 || c != c1 {
		t.Fatalf("equal or older ts changed the record: %d", len(recs))
	}
	s.Push(ctx, a, []Record{prefsRec(20)}, nil)
	recs, c2 := pullAll(t, s, a, c1)
	if len(recs) != 1 || recordTS(recs[0].Data) != 20 || c2 <= c1 {
		t.Fatalf("newer ts did not replace: %+v", recs)
	}
	s.Push(ctx, a, nil, []Ref{{Kind: "prefs", ID: "prefs-favourites"}})
	s.Push(ctx, a, []Record{prefsRec(30)}, nil)
	all, _ := pullAll(t, s, a, c2)
	if len(all) != 1 || all[0].Data != nil {
		t.Fatalf("a tombstoned prefs record came back: %+v", all)
	}
	if id, err := CheckRecord("prefs", json.RawMessage(`{"id":"prefs-favourites","ts":5}`)); err != nil || id != "prefs-favourites" {
		t.Fatalf("%q %v", id, err)
	}
}

func TestCheckRecordRefusesFarFutureTSForMutableKinds(t *testing.T) {
	soon := time.Now().Add(time.Hour).UnixMilli()
	far := time.Now().Add(48 * time.Hour).UnixMilli()
	for _, kind := range []string{"strokes", "prefs"} {
		if _, err := CheckRecord(kind, json.RawMessage(fmt.Sprintf(`{"id":"x","ts":%d}`, soon))); err != nil {
			t.Fatalf("%s an hour ahead: %v", kind, err)
		}
		id, err := CheckRecord(kind, json.RawMessage(fmt.Sprintf(`{"id":"x","ts":%d}`, far)))
		if err == nil || id != "x" || !strings.Contains(err.Error(), "ts in the future") {
			t.Fatalf("%s two days ahead: %q %v", kind, id, err)
		}
	}
	// Immutable kinds are never replaced by ts, so a future ts does no harm there.
	if _, err := CheckRecord("ink", json.RawMessage(fmt.Sprintf(`{"id":"x","ts":%d}`, far))); err != nil {
		t.Fatal(err)
	}
	// Not finite: 1e999 overflows float64 and is not a usable number.
	for _, ts := range []string{`1e999`, `"NaN"`, `-1`, `0`} {
		if _, err := CheckRecord("strokes", json.RawMessage(`{"id":"x","ts":`+ts+`}`)); err == nil {
			t.Fatalf("ts %s accepted", ts)
		}
	}
	// A `~` in an id (later parts of a split strokes file) is fine.
	if id, err := CheckRecord("strokes", json.RawMessage(`{"id":"strokes-custom-a~1","ts":5}`)); err != nil || id != "strokes-custom-a~1" {
		t.Fatalf("%q %v", id, err)
	}
}
