package sheets

import (
	"errors"
	"strings"
	"unicode"
)

// Limits on a custom exercise. The text travels in the URL, so it is kept to
// what a practice session plausibly uses, and well under URL length limits.
const (
	MaxCustomRunes = 1200
	MaxCustomLines = 30
	// WrapAt is the longest model line. Longer lines would shrink to fit an
	// iPad's width and stop matching the practice line's size.
	WrapAt = 28
)

var ErrEmpty = errors.New("no text to practise")

// Custom turns the user's own text into a worksheet: one model line per line
// of input, long lines wrapped at word boundaries, blank lines dropped.
func Custom(text string) (Sheet, error) {
	text = clean(text)
	if r := []rune(text); len(r) > MaxCustomRunes {
		text = string(r[:MaxCustomRunes])
	}
	var lines []string
	for raw := range strings.SplitSeq(text, "\n") {
		lines = append(lines, wrap(strings.Join(strings.Fields(raw), " "), WrapAt)...)
	}
	if len(lines) == 0 {
		return Sheet{}, ErrEmpty
	}
	if len(lines) > MaxCustomLines {
		lines = lines[:MaxCustomLines]
	}
	return Sheet{
		Title: "Your text",
		Note:  "Copy each line onto the practice line beneath it.",
		Lines: lines,
	}, nil
}

// clean normalises line endings and drops control and invisible format
// characters (zero-width spaces, bidi overrides) that a paste can carry and
// that would render oddly or not at all in a model line.
func clean(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n':
			return r
		case r == '\t':
			return ' '
		case unicode.IsControl(r), unicode.Is(unicode.Cf, r):
			return -1
		}
		return r
	}, s)
}

// wrap breaks a line into pieces of at most width runes at spaces. A single
// word longer than width is cut, since a model line can't run off the page.
func wrap(line string, width int) []string {
	var out []string
	var cur []rune
	for _, word := range strings.Fields(line) {
		w := []rune(word)
		for len(w) > width {
			if len(cur) > 0 {
				out = append(out, string(cur))
				cur = nil
			}
			out = append(out, string(w[:width]))
			w = w[width:]
		}
		switch {
		case len(cur) == 0:
			cur = w
		case len(cur)+1+len(w) <= width:
			cur = append(append(cur, ' '), w...)
		default:
			out = append(out, string(cur))
			cur = w
		}
	}
	if len(cur) > 0 {
		out = append(out, string(cur))
	}
	return out
}
