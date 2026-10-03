package fonts

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestBuiltinIsValid(t *testing.T) {
	if err := Validate(Builtin); err != nil {
		t.Fatal(err)
	}
	if len(Builtin) < 2 {
		t.Fatalf("only %d fonts", len(Builtin))
	}
}

// The picker shows families in this order, by their real names, and the app
// opens on Edu SA Beginner: it is Getty-Dubay practice first.
func TestBuiltinFamilyOrderAndDefault(t *testing.T) {
	var names []string
	for _, g := range Groups(Builtin) {
		names = append(names, g.Name)
	}
	want := []string{"Briem Hand", "Edu SA Beginner", "Playwrite GB", "Playwrite US"}
	if !slices.Equal(names, want) {
		t.Errorf("families %q, want %q", names, want)
	}
	if d := DefaultFont(Builtin); d.ID != "italic" {
		t.Errorf("default %q, want italic", d.ID)
	}
}

// A family whose variants are scattered through the catalogue still forms
// one tile, at the position of its first variant.
func TestGroupsKeepsCatalogueOrder(t *testing.T) {
	g := Groups([]Font{{ID: "a", Group: "A"}, {ID: "b", Group: "B"}, {ID: "c", Group: "A"}})
	if len(g) != 2 || g[0].Name != "A" || len(g[0].Fonts) != 2 || g[0].Fonts[1].ID != "c" || g[1].Name != "B" {
		t.Errorf("got %+v", g)
	}
}

func valid() Font {
	return Font{ID: "x", Group: "X", Variant: "X", Family: "X Font", CSSURL: "https://a.example/x.css", FileOrigin: "https://b.example", Default: true}
}

// The family is written verbatim into a generated stylesheet, the id into
// class names and custom properties, and the file into a URL, so anything that
// could break out of a string, a rule or the fonts directory is refused.
func TestValidateRejectsUnsafeFonts(t *testing.T) {
	cases := map[string]func(*Font){
		"family quote":      func(f *Font) { f.Family = `A"; } body { x` },
		"family semicolon":  func(f *Font) { f.Family = "A;B" },
		"family escape":     func(f *Font) { f.Family = `A\22` },
		"family empty":      func(f *Font) { f.Family = "" },
		"family long":       func(f *Font) { f.Family = strings.Repeat("a", 65) },
		"id uppercase":      func(f *Font) { f.ID = "X" },
		"id brace":          func(f *Font) { f.ID = "x{" },
		"id reserved":       func(f *Font) { f.ID = "custom" },
		"no group":          func(f *Font) { f.Group = "" },
		"no variant":        func(f *Font) { f.Variant = "" },
		"http stylesheet":   func(f *Font) { f.CSSURL = "http://a.example/x.css" },
		"relative origin":   func(f *Font) { f.FileOrigin = "b.example" },
		"absurd slant":      func(f *Font) { f.Slant = 45 },
		"file and css":      func(f *Font) { f.File = "fonts/X.ttf" },
		"file traversal":    func(f *Font) { f.CSSURL, f.FileOrigin, f.File = "", "", "fonts/../handler.go" },
		"file not ttf":      func(f *Font) { f.CSSURL, f.FileOrigin, f.File = "", "", "fonts/x.html" },
		"file outside dir":  func(f *Font) { f.CSSURL, f.FileOrigin, f.File = "", "", "styles.ttf" },
		"no default at all": func(f *Font) { f.Default = false },
	}
	for name, mutate := range cases {
		f := valid()
		mutate(&f)
		if err := Validate([]Font{f}); err == nil {
			t.Errorf("%s: accepted %+v", name, f)
		}
	}
	two := valid()
	two.ID = "y"
	if err := Validate([]Font{valid(), two}); err == nil {
		t.Error("two defaults accepted")
	}
	if err := Validate([]Font{valid(), valid()}); err == nil {
		t.Error("duplicate id accepted")
	}
	if err := Validate(nil); err == nil {
		t.Error("empty catalogue accepted")
	}
	local := valid()
	local.CSSURL, local.FileOrigin, local.File = "", "", "fonts/X-Regular.ttf"
	if err := Validate([]Font{local}); err != nil {
		t.Errorf("bundled font rejected: %v", err)
	}
}

func TestCSS(t *testing.T) {
	list := []Font{
		{ID: "a", Family: "Font A", File: "fonts/A.ttf"},
		{ID: "b", Family: "Font B", Italic: true, Default: true},
		{ID: "c", Family: "Font A", File: "fonts/A.ttf"}, // same face: one @font-face
	}
	css, err := CSS(list, func(p string) (string, error) { return "/static/" + p + "?v=abc", nil })
	if err != nil {
		t.Fatal(err)
	}
	s := string(css)
	for _, want := range []string{
		"@font-face {\n  font-family: \"Font A\";\n  src: url(\"/static/fonts/A.ttf?v=abc\") format(\"truetype\");",
		`--font-a: "Font A", cursive;`,
		`--font-b: "Font B", cursive;`,
		`--ref-font: var(--font-b);`,
		`.font-a { font-family: var(--font-a); font-style: normal; }`,
		`.font-b { font-family: var(--font-b); font-style: italic; }`,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in:\n%s", want, s)
		}
	}
	if n := strings.Count(s, "@font-face"); n != 1 {
		t.Errorf("%d @font-face rules, want 1", n)
	}
	// A bundled file that isn't in the asset map must fail startup, not ship a
	// stylesheet pointing at nothing.
	if _, err := CSS(list, func(string) (string, error) { return "", errors.New("unknown asset") }); err == nil {
		t.Error("missing asset accepted")
	}
}

func TestPublicOriginStripsPath(t *testing.T) {
	got, err := PublicOrigin("https://fonts.googleapis.com/css2?family=X")
	if err != nil || got != "https://fonts.googleapis.com" {
		t.Errorf("got %q, %v", got, err)
	}
}
