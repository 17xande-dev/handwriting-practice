// Package sheets holds the built-in practice worksheets.
//
// The sequence follows what the respected italic courses share (see the
// README's "Worksheets" section for sources): movement first, then
// lowercase in families of shared strokes, then joins one kind at a time,
// then numerals, punctuation, capitals, spacing and running text.
//
//   - Briem (briem.net) starts with zigzags and turns them into letters by
//     adding "recognition points", and treats the a-family (triangular bowl)
//     and the b-family (the same bowl inverted) as the core shapes.
//   - Getty-Dubay teaches lowercase by families and joins in a numbered
//     sequence; Reynolds and Eager teach diagonal joins first, then
//     horizontal joins out of o, f, t, v and w, and which letters never join.
//
// The groupings are a synthesis, not a copy of any one book's numbering.
package sheets

// Sheet is one worksheet: a title, a short note on what to watch for, and the
// model lines to copy.
type Sheet struct {
	Slug    string
	Section string
	Title   string
	Note    string
	Lines   []string
}

// Sections, in teaching order.
const (
	Letters = "Letters"
	Joins   = "Joins"
	Beyond  = "Beyond lowercase"
)

var all = []Sheet{
	// Letters: movement, then the families.
	{
		Slug:    "warm-up",
		Section: Letters,
		Title:   "Zigzags and patterns",
		Note:    "Writing is a zigzag with recognition points added. Keep the zigzag even, then dot every second stem to turn uuu into uiui.",
		Lines:   []string{"vvvvvvvvvv", "uuuuuuuu", "uiuiuiui", "nnnnnnnn", "nununununu"},
	},
	{
		Slug:    "straight",
		Section: Letters,
		Title:   "Straight-line letters",
		Note:    "One stroke each, pulled down at the slant. Dot the i and j above the x-height.",
		Lines:   []string{"i i i l l l", "j j j i l j", "ill lili jill"},
	},
	{
		Slug:    "arches",
		Section: Letters,
		Title:   "Branching arches",
		Note:    "Start the stem, retrace up, then branch out about halfway up. The arch is narrow and springs from inside the stem.",
		Lines:   []string{"n n n m m m", "h h h r r r", "k k k", "him rim ink"},
	},
	{
		Slug:    "b-family",
		Section: Letters,
		Title:   "The b family",
		Note:    "The triangular bowl of the a, turned upside down. Branch out of the stem and close the bowl at the base.",
		Lines:   []string{"b b b p p p", "bp pb bp pb", "bib nip limp brim"},
	},
	{
		Slug:    "a-family",
		Section: Letters,
		Title:   "The a family",
		Note:    "A flat-topped, triangular bowl closed by a straight stem. The same shape carries on into u and y. Pause at each corner.",
		Lines:   []string{"a a a d d d", "g g g q q q", "u u u y y y", "add quay guy"},
	},
	{
		Slug:    "ovals",
		Section: Letters,
		Title:   "Ovals",
		Note:    "Elliptical, not round. Start at the top right and travel counter-clockwise. Make the e in two movements.",
		Lines:   []string{"o o o e e e", "c c c s s s", "once moss cocoa"},
	},
	{
		Slug:    "diagonals",
		Section: Letters,
		Title:   "Diagonals",
		Note:    "Keep the diagonals parallel to each other, and the letters narrow.",
		Lines:   []string{"v v v w w w", "x x x z z z", "vex wax zoo"},
	},
	{
		Slug:    "f-and-t",
		Section: Letters,
		Title:   "f and t",
		Note:    "Both are crossed at the x-height, and the crossbar is where they join on. In Getty-Dubay italic the f descends below the baseline, though some model fonts keep it on the line.",
		Lines:   []string{"f f f t t t", "ft tt ff ft", "fit tuft fifty"},
	},

	// Joins: one kind at a time, then when not to join.
	{
		Slug:    "diagonal-joins",
		Section: Joins,
		Title:   "Diagonal joins into n and m",
		Note:    "A diagonal join runs from the base of one letter up to the top of the next stem.",
		Lines:   []string{"an in un mn", "am im um", "minimum"},
	},
	{
		Slug:    "round-joins",
		Section: Joins,
		Title:   "Joins into round letters",
		Note:    "The diagonal comes up and over into the top of the bowl, then the bowl is written as usual.",
		Lines:   []string{"ac ad ag ao", "nc nd ne no", "code dog quad"},
	},
	{
		Slug:    "horizontal-joins",
		Section: Joins,
		Title:   "Horizontal joins",
		Note:    "Out of o, f, t, v and w the join runs level along the x-height into the next letter.",
		Lines:   []string{"on om oi ou", "ti tu fi fo", "wo vi to from"},
	},
	{
		Slug:    "no-joins",
		Section: Joins,
		Title:   "Letters that don't join",
		Note:    "Lift after b, g, j, p, q, s, x, y and z, and before letters that start at the top of an ascender. Leave only a small gap.",
		Lines:   []string{"by gap jog", "sky box zip", "big quiz"},
	},
	{
		Slug:    "chains",
		Section: Joins,
		Title:   "Joining chains",
		Note:    "Every letter joined in and out of n: a drill for even rhythm and spacing.",
		Lines:   []string{"nanbncndnenfn", "ngnhninjnknln", "nmnonpnqnrnsn", "ntnunvnwnxnynzn"},
	},

	// Beyond lowercase.
	{
		Slug:    "numerals",
		Section: Beyond,
		Title:   "Numerals and punctuation",
		Note:    "Numerals are as tall as capitals, a little under the ascender line. Punctuation stays small and close to its word.",
		Lines:   []string{"1 2 3 4 5", "6 7 8 9 0", "12 May 2026", "yes, no; why? so!"},
	},
	{
		Slug:    "capitals",
		Section: Beyond,
		Title:   "Capitals",
		Note:    "Italic capitals follow Roman inscriptional proportions: some letters a full square, others half as wide. Keep them below the ascender line.",
		Lines:   []string{"I L T H E F", "O C G Q D", "N M A V W", "Anna Ben Oslo"},
	},
	{
		Slug:    "spacing",
		Section: Beyond,
		Title:   "Spacing",
		Note:    "Even space between letters, and the width of an n between words.",
		Lines:   []string{"minimum illumination", "a an and band", "one word at a time"},
	},
	{
		Slug:    "sentences",
		Section: Beyond,
		Title:   "Sentences",
		Note:    "Every letter in context, with capitals and punctuation. Aim for a steady rhythm rather than speed.",
		Lines: []string{
			"The quick brown fox",
			"jumps over the lazy dog.",
			"Pack my box with five",
			"dozen liquor jugs.",
			"How vexingly quick daft",
			"zebras jump!",
		},
	},
}

// All returns every worksheet in teaching order.
func All() []Sheet { return all }

// Section is one heading on the index and the worksheets under it.
type Section struct {
	Name   string
	Sheets []Sheet
}

// Sections groups the worksheets under their headings, in teaching order.
func Sections() []Section {
	var out []Section
	for _, s := range all {
		if len(out) == 0 || out[len(out)-1].Name != s.Section {
			out = append(out, Section{Name: s.Section})
		}
		out[len(out)-1].Sheets = append(out[len(out)-1].Sheets, s)
	}
	return out
}

// Get looks a worksheet up by slug.
func Get(slug string) (Sheet, bool) {
	for _, s := range all {
		if s.Slug == slug {
			return s, true
		}
	}
	return Sheet{}, false
}
