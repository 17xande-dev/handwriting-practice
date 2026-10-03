package fonts

import (
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

func valid() Font {
	return Font{ID: "x", Label: "X", Family: "X Font", CSSURL: "https://a.example/x.css", FileOrigin: "https://b.example"}
}

// The family is written verbatim into a generated stylesheet, and the id into
// class names and custom properties, so anything that could break out of the
// string or the rule must be refused. User-supplied fonts will pass through here.
func TestValidateRejectsUnsafeFonts(t *testing.T) {
	cases := map[string]func(*Font){
		"family quote":     func(f *Font) { f.Family = `A"; } body { x` },
		"family semicolon": func(f *Font) { f.Family = "A;B" },
		"family escape":    func(f *Font) { f.Family = `A\22` },
		"family empty":     func(f *Font) { f.Family = "" },
		"family long":      func(f *Font) { f.Family = strings.Repeat("a", 65) },
		"id uppercase":     func(f *Font) { f.ID = "X" },
		"id brace":         func(f *Font) { f.ID = "x{" },
		"no label":         func(f *Font) { f.Label = "" },
		"http stylesheet":  func(f *Font) { f.CSSURL = "http://a.example/x.css" },
		"relative origin":  func(f *Font) { f.FileOrigin = "b.example" },
		"absurd slant":     func(f *Font) { f.Slant = 45 },
	}
	for name, mutate := range cases {
		f := valid()
		mutate(&f)
		if err := Validate([]Font{f}); err == nil {
			t.Errorf("%s: accepted %+v", name, f)
		}
	}
	if err := Validate([]Font{valid(), valid()}); err == nil {
		t.Error("duplicate id accepted")
	}
	if err := Validate(nil); err == nil {
		t.Error("empty catalogue accepted")
	}
}

func TestCSS(t *testing.T) {
	css := string(CSS([]Font{{ID: "a", Family: "Font A"}, {ID: "b", Family: "Font B"}}))
	for _, want := range []string{
		`--font-a: "Font A", cursive;`,
		`--font-b: "Font B", cursive;`,
		`--ref-font: var(--font-a);`,
		`.font-b { font-family: var(--font-b); }`,
	} {
		if !strings.Contains(css, want) {
			t.Errorf("missing %q in:\n%s", want, css)
		}
	}
}

func TestPublicOriginStripsPath(t *testing.T) {
	got, err := PublicOrigin("https://fonts.googleapis.com/css2?family=X")
	if err != nil || got != "https://fonts.googleapis.com" {
		t.Errorf("got %q, %v", got, err)
	}
}
