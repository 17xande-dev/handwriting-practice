package config

import (
	"slices"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) {
		v, ok := m[k]
		return v, ok
	}
}

func TestDefaults(t *testing.T) {
	c, err := parse(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":8080" || c.FontFamily != DefaultFontFamily || c.FontCSSURL != DefaultFontCSSURL {
		t.Errorf("unexpected defaults: %+v", c)
	}
	if !slices.Equal(c.FontFileOrigins, []string{"https://fonts.gstatic.com"}) {
		t.Errorf("FontFileOrigins = %v", c.FontFileOrigins)
	}
}

// The family name is written verbatim into a generated stylesheet, so anything
// that could close the string or the rule must be refused at startup.
func TestFontFamilyRejectsCSSMetacharacters(t *testing.T) {
	for _, bad := range []string{`A"; } body { x`, "A;B", "A{", "A\\22", "", " Leading", strings.Repeat("a", 65)} {
		if _, err := parse(env(map[string]string{"FONT_FAMILY": bad})); err == nil {
			t.Errorf("FONT_FAMILY %q accepted", bad)
		}
	}
}

func TestEmptyFontCSSURLDisablesRemoteStylesheet(t *testing.T) {
	c, err := parse(env(map[string]string{"FONT_CSS_URL": ""}))
	if err != nil {
		t.Fatal(err)
	}
	if c.FontCSSURL != "" {
		t.Errorf("FontCSSURL = %q, want empty", c.FontCSSURL)
	}
}

// A plain-http font origin would make the page mixed content once it is served
// over TLS, and a path would be a CSP exact-match trap.
func TestFontOriginsAreNormalised(t *testing.T) {
	c, err := parse(env(map[string]string{"FONT_FILE_ORIGINS": "https://a.example/fonts/, https://b.example"}))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(c.FontFileOrigins, []string{"https://a.example", "https://b.example"}) {
		t.Errorf("FontFileOrigins = %v", c.FontFileOrigins)
	}
	if _, err := parse(env(map[string]string{"FONT_FILE_ORIGINS": "http://a.example"})); err == nil {
		t.Error("http origin accepted")
	}
	if _, err := parse(env(map[string]string{"FONT_CSS_URL": "fonts.example/x.css"})); err == nil {
		t.Error("relative FONT_CSS_URL accepted")
	}
}
