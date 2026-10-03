// Package fonts is the catalogue of model fonts a worksheet can be shown in.
//
// Each font says how it is loaded (a stylesheet URL and the origin its files
// come from, both of which the CSP must allow) and how steeply it slopes, so
// the practice paper's slant lines can match the model.
package fonts

import (
	"fmt"
	"net/url"
	"regexp"
)

// Font is one model font.
type Font struct {
	// ID names the font in URLs, form values and CSS custom properties
	// (--font-<id>), so it is restricted to [a-z0-9-].
	ID string
	// Label is what the font picker shows.
	Label string
	// Family is the CSS family name. It is written into a generated
	// stylesheet, so it is restricted to a safe character set rather than
	// escaped.
	Family string
	// CSSURL is the stylesheet that defines Family. Empty means the font is
	// expected to be installed locally.
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
}

// Google Fonts serves stylesheets from one origin and font files from
// another. The CSP always allows both, because the worksheet's "any Google
// font" picker loads a family by name in the browser.
const (
	GoogleCSSOrigin  = "https://fonts.googleapis.com"
	GoogleFileOrigin = "https://fonts.gstatic.com"
)

// Builtin is the catalogue, default first. The choices are recorded in the README.
var Builtin = []Font{
	{
		ID:         "italic",
		Label:      "Italic",
		Family:     "Edu SA Beginner",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Edu+SA+Beginner&display=swap",
		FileOrigin: "https://fonts.gstatic.com",
		Slant:      5,
	},
	{
		ID:         "upright",
		Label:      "Upright",
		Family:     "Playwrite US Modern",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Playwrite+US+Modern&display=swap",
		FileOrigin: "https://fonts.gstatic.com",
		Slant:      0,
	},
	// Playwrite England: the GB S (semi-joined) and GB J (joined) school
	// hands, each upright and italic. The italic slants were measured from
	// the fonts' own "l" stems, at about 7°.
	{
		ID:         "gb-s",
		Label:      "England semi-joined",
		Family:     "Playwrite GB S",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Playwrite+GB+S&display=swap",
		FileOrigin: "https://fonts.gstatic.com",
		Slant:      0,
	},
	{
		ID:         "gb-s-italic",
		Label:      "England semi-joined italic",
		Family:     "Playwrite GB S",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Playwrite+GB+S:ital@1&display=swap",
		FileOrigin: "https://fonts.gstatic.com",
		Italic:     true,
		Slant:      7,
	},
	{
		ID:         "gb-j",
		Label:      "England joined",
		Family:     "Playwrite GB J",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Playwrite+GB+J&display=swap",
		FileOrigin: "https://fonts.gstatic.com",
		Slant:      0,
	},
	{
		ID:         "gb-j-italic",
		Label:      "England joined italic",
		Family:     "Playwrite GB J",
		CSSURL:     "https://fonts.googleapis.com/css2?family=Playwrite+GB+J:ital@1&display=swap",
		FileOrigin: "https://fonts.gstatic.com",
		Italic:     true,
		Slant:      7,
	},
}

var (
	idRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
	familyRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$`)
)

// Validate checks a catalogue before it is served. It runs at startup on the
// built-in list now, and is the gate user-supplied fonts will have to pass.
func Validate(list []Font) error {
	if len(list) == 0 {
		return fmt.Errorf("no fonts")
	}
	seen := map[string]bool{}
	for _, f := range list {
		if !idRe.MatchString(f.ID) || seen[f.ID] {
			return fmt.Errorf("font id %q: invalid or duplicate", f.ID)
		}
		seen[f.ID] = true
		if !familyRe.MatchString(f.Family) {
			return fmt.Errorf("font %s: family %q: only letters, digits, spaces and hyphens are allowed", f.ID, f.Family)
		}
		if f.Label == "" {
			return fmt.Errorf("font %s: no label", f.ID)
		}
		if f.Slant < -20 || f.Slant > 20 {
			return fmt.Errorf("font %s: slant %v out of range", f.ID, f.Slant)
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
	return nil
}

// CSS is the generated stylesheet that carries the catalogue into the page:
// a custom property and a class per font. A generated stylesheet keeps the
// family names out of inline styles, which the CSP refuses.
func CSS(list []Font) []byte {
	var b []byte
	b = append(b, ":root {\n"...)
	for _, f := range list {
		b = fmt.Appendf(b, "  --font-%s: %q, cursive;\n", f.ID, f.Family)
	}
	// --ref-font is the default font, used wherever there's no picker.
	b = fmt.Appendf(b, "  --ref-font: var(--font-%s);\n}\n", list[0].ID)
	for _, f := range list {
		style := "normal"
		if f.Italic {
			style = "italic"
		}
		b = fmt.Appendf(b, ".font-%s { font-family: var(--font-%s); font-style: %s; }\n", f.ID, f.ID, style)
	}
	return b
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
