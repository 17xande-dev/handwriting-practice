package sheets

import (
	"regexp"
	"strings"
	"testing"
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
