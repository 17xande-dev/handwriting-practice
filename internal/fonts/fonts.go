// Package fonts is the catalogue of model fonts a worksheet can be shown in.
//
// Each font says how it is loaded (a file bundled with the app, or a Google
// Fonts stylesheet whose origins the CSP must allow), which family it belongs
// to in the picker, and how steeply it slopes, so the practice paper's slant
// lines can match the model.
package fonts

import (
	"fmt"
	"net/url"
	"regexp"
)

// Font is one model font: one variant within a family in the picker.
type Font struct {
	// ID names the font in form values, stored settings and CSS custom
	// properties (--font-<id>), so it is restricted to [a-z0-9-]. IDs are
	// kept stable so a device's remembered choice survives catalogue changes.
	ID string
	// Group is the family tile the font sits under, by its real name.
	Group string
	// Variant is the font's real name, shown on its chip.
	Variant string
	// Note says in plain words what sets this variant apart (joined, italic).
	Note string
	// Family is the CSS family name. It is written into a generated
	// stylesheet, so it is restricted to a safe character set rather than
	// escaped. For a bundled File it is our own name for the face, which
	// keeps it from colliding with a Google family of the same name.
	Family string
	// File is a bundled font file, a static asset path such as
	// "fonts/BriemHand-Regular.ttf". A font has a File or a CSSURL, not both.
	File string
	// CSSURL is the stylesheet that defines Family.
	CSSURL string
	// FileOrigin is where that stylesheet loads its font files from. It can't
	// be derived from CSSURL: Google serves the CSS from fonts.googleapis.com
	// and the files from fonts.gstatic.com.
	FileOrigin string
	// Italic selects the font's italic style rather than its upright one.
	Italic bool
	// Slant is the writing slope in degrees right of vertical. The guides
	// draw their slant lines at this angle; 0 means upright paper.
	Slant float64
	// Default marks the model a worksheet opens with. Exactly one font has it.
	Default bool
}

// Google Fonts serves stylesheets from one origin and font files from
// another. The CSP always allows both, because the worksheet's "any Google
// font" picker loads a family by name in the browser.
const (
	GoogleCSSOrigin  = "https://fonts.googleapis.com"
	GoogleFileOrigin = "https://fonts.gstatic.com"
)

// Builtin is the catalogue in picker order: families in the order their tiles
// appear, variants in the order of their chips. The choices are recorded in
// the README.
var Builtin = []Font{
	// Gunnlaugur Briem's handwriting model, bundled from the Briem-Hand
	// v1.004 release (third_party/briem-hand). Slants measured from the
	// fonts' ascender stems.
	{
		ID:      "briem-print",
		Group:   "Briem Hand",
		Variant: "Briem Hand Unjoined",
		Note:    "print",
		Family:  "Briem Hand Print",
		File:    "fonts/BriemHandUnjoined-Regular.ttf",
		Slant:   3.5,
	},
	{
		ID:      "briem-hand",
		Group:   "Briem Hand",
		Variant: "Briem Hand",
		Note:    "joined",
		Family:  "Briem Hand Joined",
		File:    "fonts/BriemHand-Regular.ttf",
		Slant:   3.5,
	},
	// The Getty-Dubay stand-in, and the default. It measures 6°; 5° is
	// Getty-Dubay's own slope.
	{
		ID:         "italic",
		Group:      "Edu SA Beginner",
		Variant:    "Edu SA Beginner",
		Note:       "italic",
		Family:     "Edu SA Beginner",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Edu+SA+Beginner&display=swap",
		FileOrigin: GoogleFileOrigin,
		Slant:      5,
		Default:    true,
	},
	// Playwrite England: GB S (semi-joined) and GB J (joined), each upright
	// and italic. The italics measure about 7°.
	{
		ID:         "gb-s",
		Group:      "Playwrite GB",
		Variant:    "Playwrite GB S",
		Note:       "semi-joined",
		Family:     "Playwrite GB S",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Playwrite+GB+S&display=swap",
		FileOrigin: GoogleFileOrigin,
	},
	{
		ID:         "gb-s-italic",
		Group:      "Playwrite GB",
		Variant:    "Playwrite GB S Italic",
		Note:       "semi-joined, italic",
		Family:     "Playwrite GB S",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Playwrite+GB+S:ital@1&display=swap",
		FileOrigin: GoogleFileOrigin,
		Italic:     true,
		Slant:      7,
	},
	{
		ID:         "gb-j",
		Group:      "Playwrite GB",
		Variant:    "Playwrite GB J",
		Note:       "joined",
		Family:     "Playwrite GB J",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Playwrite+GB+J&display=swap",
		FileOrigin: GoogleFileOrigin,
	},
	{
		ID:         "gb-j-italic",
		Group:      "Playwrite GB",
		Variant:    "Playwrite GB J Italic",
		Note:       "joined, italic",
		Family:     "Playwrite GB J",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Playwrite+GB+J:ital@1&display=swap",
		FileOrigin: GoogleFileOrigin,
		Italic:     true,
		Slant:      7,
	},
	{
		ID:         "upright",
		Group:      "Playwrite US",
		Variant:    "Playwrite US Modern",
		Note:       "upright",
		Family:     "Playwrite US Modern",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Playwrite+US+Modern&display=swap",
		FileOrigin: GoogleFileOrigin,
	},
}

// Group is one family tile in the picker and the variants under it.
type Group struct {
	Name  string
	Fonts []Font
}

// Groups gathers the catalogue into families, keeping catalogue order for
// both the families and the variants within them.
func Groups(list []Font) []Group {
	var out []Group
	index := map[string]int{}
	for _, f := range list {
		i, ok := index[f.Group]
		if !ok {
			i = len(out)
			index[f.Group] = i
			out = append(out, Group{Name: f.Group})
		}
		out[i].Fonts = append(out[i].Fonts, f)
	}
	return out
}

// DefaultFont is the font marked Default. Validate guarantees there is one.
func DefaultFont(list []Font) Font {
	for _, f := range list {
		if f.Default {
			return f
		}
	}
	return list[0]
}

var (
	idRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
	familyRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$`)
	fileRe   = regexp.MustCompile(`^fonts/[A-Za-z0-9-]+\.ttf$`)
)

// Validate checks a catalogue before it is served. It runs at startup.
func Validate(list []Font) error {
	if len(list) == 0 {
		return fmt.Errorf("no fonts")
	}
	seen := map[string]bool{}
	defaults := 0
	for _, f := range list {
		if !idRe.MatchString(f.ID) || seen[f.ID] || f.ID == "custom" {
			return fmt.Errorf("font id %q: invalid, duplicate or reserved", f.ID)
		}
		seen[f.ID] = true
		if !familyRe.MatchString(f.Family) {
			return fmt.Errorf("font %s: family %q: only letters, digits, spaces and hyphens are allowed", f.ID, f.Family)
		}
		if f.Group == "" || f.Variant == "" {
			return fmt.Errorf("font %s: no group or variant name", f.ID)
		}
		if f.Slant < -20 || f.Slant > 30 {
			return fmt.Errorf("font %s: slant %v out of range", f.ID, f.Slant)
		}
		if f.Default {
			defaults++
		}
		switch {
		case f.File != "" && f.CSSURL != "":
			return fmt.Errorf("font %s: has both a bundled file and a stylesheet", f.ID)
		case f.File != "":
			if !fileRe.MatchString(f.File) {
				return fmt.Errorf("font %s: file %q must be fonts/<name>.ttf", f.ID, f.File)
			}
		}
		for _, u := range []string{f.CSSURL, f.FileOrigin} {
			if u == "" {
				continue
			}
			if _, err := PublicOrigin(u); err != nil {
				return fmt.Errorf("font %s: %w", f.ID, err)
			}
		}
	}
	if defaults != 1 {
		return fmt.Errorf("%d fonts marked default, want exactly 1", defaults)
	}
	return nil
}

// CSS is the generated stylesheet that carries the catalogue into the page:
// an @font-face per bundled file, and a custom property and class per font.
// assetURL turns a bundled file's path into its content-hashed URL. A
// generated stylesheet keeps the family names out of inline styles, which the
// CSP refuses.
func CSS(list []Font, assetURL func(string) (string, error)) ([]byte, error) {
	var b []byte
	faces := map[string]bool{}
	for _, f := range list {
		if f.File == "" || faces[f.Family] {
			continue
		}
		faces[f.Family] = true
		u, err := assetURL(f.File)
		if err != nil {
			return nil, fmt.Errorf("font %s: %w", f.ID, err)
		}
		b = fmt.Appendf(b, "@font-face {\n  font-family: %q;\n  src: url(%q) format(\"truetype\");\n  font-display: swap;\n}\n", f.Family, u)
	}
	b = append(b, ":root {\n"...)
	for _, f := range list {
		b = fmt.Appendf(b, "  --font-%s: %q, cursive;\n", f.ID, f.Family)
	}
	// --ref-font is the default font, used wherever there's no picker.
	b = fmt.Appendf(b, "  --ref-font: var(--font-%s);\n}\n", DefaultFont(list).ID)
	for _, f := range list {
		style := "normal"
		if f.Italic {
			style = "italic"
		}
		b = fmt.Appendf(b, ".font-%s { font-family: var(--font-%s); font-style: %s; }\n", f.ID, f.ID, style)
	}
	return b, nil
}

// PublicOrigin reduces an https URL to scheme://host for use as a CSP source.
// CSP source paths are exact matches rather than prefixes, so a source with a
// path would allow only that one URL and refuse everything else on the host.
func PublicOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if u.Scheme != "https" || u.Host == "" {
		return "", fmt.Errorf("%q: must be an absolute https URL", raw)
	}
	return u.Scheme + "://" + u.Host, nil
}
