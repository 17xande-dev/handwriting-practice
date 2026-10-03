package sheets

import (
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestCustomSplitsAndWraps(t *testing.T) {
	s, err := Custom("minimum\r\n\r\n   the quick brown fox jumps over the lazy dog\n\tan in un")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"minimum", "the quick brown fox jumps", "over the lazy dog", "an in un"}
	if !slices.Equal(s.Lines, want) {
		t.Errorf("Lines = %q, want %q", s.Lines, want)
	}
}

// Every model line must fit, or it shrinks on the page and stops matching the
// practice line's size.
func TestCustomLinesNeverExceedWrapWidth(t *testing.T) {
	s, err := Custom(strings.Repeat("a", 70) + " " + strings.Repeat("word ", 40))
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Lines) < 3 {
		t.Fatalf("got %d lines", len(s.Lines))
	}
	for _, l := range s.Lines {
		if n := utf8.RuneCountInString(l); n > WrapAt || n == 0 {
			t.Errorf("line %q is %d runes", l, n)
		}
	}
}

func TestCustomRejectsBlankAndStripsInvisibles(t *testing.T) {
	for _, in := range []string{"", "   \n\t\n", "​‮"} {
		if _, err := Custom(in); err != ErrEmpty {
			t.Errorf("Custom(%q) err = %v, want ErrEmpty", in, err)
		}
	}
	s, _ := Custom("a​b‮c\x07d")
	if s.Lines[0] != "abcd" {
		t.Errorf("got %q", s.Lines[0])
	}
}

func TestCustomCapsLength(t *testing.T) {
	s, err := Custom(strings.Repeat("line\n", 100))
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Lines) != MaxCustomLines {
		t.Errorf("%d lines, want %d", len(s.Lines), MaxCustomLines)
	}
	// Multi-byte text must be cut on a rune boundary, never mid-character.
	s, _ = Custom(strings.Repeat("é", MaxCustomRunes+50))
	for _, l := range s.Lines {
		if !utf8.ValidString(l) {
			t.Fatalf("invalid UTF-8 in %q", l)
		}
	}
}
