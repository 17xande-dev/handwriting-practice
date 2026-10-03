package sheets

import (
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"
)

// Slugs are URLs: a duplicate would make one sheet unreachable, and anything
// outside [a-z0-9-] would need escaping in the links the index renders.
func TestSheetsAreWellFormed(t *testing.T) {
	slug := regexp.MustCompile(`^[a-z0-9-]+$`)
	seen := map[string]bool{}
	if len(All()) < 5 {
		t.Fatalf("only %d sheets", len(All()))
	}
	for _, s := range All() {
		if !slug.MatchString(s.Slug) || seen[s.Slug] {
			t.Errorf("bad or duplicate slug %q", s.Slug)
		}
		seen[s.Slug] = true
		if s.Title == "" || len(s.Lines) == 0 {
			t.Errorf("%s: missing title or lines", s.Slug)
		}
		for _, l := range s.Lines {
			if strings.TrimSpace(l) == "" {
				t.Errorf("%s: blank line", s.Slug)
			}
		}
		if got, ok := Get(s.Slug); !ok || got.Title != s.Title {
			t.Errorf("Get(%q) failed", s.Slug)
		}
	}
	if _, ok := Get("nope"); ok {
		t.Error("Get found a sheet that does not exist")
	}
}

// A built-in model line longer than a custom one may be would shrink on an
// iPad to fit the width and stop matching the practice line's size.
func TestBuiltinLinesFit(t *testing.T) {
	for _, s := range All() {
		for _, l := range s.Lines {
			if n := utf8.RuneCountInString(l); n > WrapAt {
				t.Errorf("%s: %q is %d runes, over %d", s.Slug, l, n, WrapAt)
			}
		}
	}
}

// Each section's sheets sit together, so the index shows each heading once,
// in teaching order: letters, then joins, then beyond lowercase.
func TestSectionsInTeachingOrder(t *testing.T) {
	var names []string
	total := 0
	for _, sec := range Sections() {
		names = append(names, sec.Name)
		total += len(sec.Sheets)
	}
	if strings.Join(names, "|") != Letters+"|"+Joins+"|"+Beyond {
		t.Errorf("sections %q", names)
	}
	if total != len(All()) {
		t.Errorf("sections hold %d sheets, catalogue has %d", total, len(All()))
	}
	if All()[0].Slug != "warm-up" {
		t.Errorf("first sheet %q; movement practice comes first", All()[0].Slug)
	}
}
