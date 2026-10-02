// Package sheets holds the built-in practice worksheets.
//
// The letter groups follow the Getty-Dubay idea of teaching lowercase italic
// in families of shared strokes (straight lines, branching arches, the "a"
// shape, ovals, diagonals) rather than alphabetical order. The groupings are a
// starting point and not a copy of any particular book's numbering.
package sheets

// Sheet is one worksheet: a title, a short note on what to watch for, and the
// model lines to copy.
type Sheet struct {
	Slug  string
	Title string
	Note  string
	Lines []string
}

var all = []Sheet{
	{
		Slug:  "warm-up",
		Title: "Warm-up patterns",
		Note:  "Keep the rhythm even. Arches branch out of the stem about halfway up the x-height.",
		Lines: []string{"nnnnnnnn", "uuuuuuuu", "nununununu", "mmmmmm"},
	},
	{
		Slug:  "straight",
		Title: "Straight-line letters",
		Note:  "One stroke each, pulled down at a 5° slant. Dot the i and j, cross the t at the x-height.",
		Lines: []string{"i i i l l l", "t t t j j j", "il it lit tilt"},
	},
	{
		Slug:  "arches",
		Title: "Branching arches",
		Note:  "Start the stem, retrace up, then branch out. The arch is narrow and springs from inside the stem.",
		Lines: []string{"n n n m m m", "h h h r r r", "k k k b b b p p p", "him burn pink"},
	},
	{
		Slug:  "a-family",
		Title: "The “a” family",
		Note:  "A flat-topped, wedge-shaped bowl closed by a straight stem. Pause at each corner.",
		Lines: []string{"a a a d d d", "g g g q q q", "u u u y y y", "add quay guy"},
	},
	{
		Slug:  "ovals",
		Title: "Ovals",
		Note:  "Elliptical, not round. Start at the top right and travel counter-clockwise.",
		Lines: []string{"o o o e e e", "c c c s s s", "ose cose sees"},
	},
	{
		Slug:  "diagonals",
		Title: "Diagonals",
		Note:  "Keep the diagonals parallel to each other, and the letters narrow.",
		Lines: []string{"v v v w w w", "x x x z z z", "vex wax zoo"},
	},
	{
		Slug:  "f",
		Title: "The letter f",
		Note:  "In Getty-Dubay italic the f descends below the baseline, though the model font keeps it on the line. Cross it at the x-height.",
		Lines: []string{"f f f f f f", "fit off fifty"},
	},
	{
		Slug:  "joins",
		Title: "Simple joins",
		Note:  "A diagonal join runs from the base of one letter to the top of the next stem.",
		Lines: []string{"an in un mn", "am im um", "minimum"},
	},
	{
		Slug:  "pangram",
		Title: "Pangram",
		Note:  "Every letter in context. Aim for even spacing between words.",
		Lines: []string{"the quick brown fox", "jumps over the lazy dog"},
	},
}

// All returns every worksheet in teaching order.
func All() []Sheet { return all }

// Get looks a worksheet up by slug.
func Get(slug string) (Sheet, bool) {
	for _, s := range all {
		if s.Slug == slug {
			return s, true
		}
	}
	return Sheet{}, false
}
