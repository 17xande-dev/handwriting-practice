package handler

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"calligraphy/internal/config"
	"calligraphy/internal/sheets"
)

func testConfig() config.Config {
	return config.Config{
		Addr:            ":0",
		FontFamily:      config.DefaultFontFamily,
		FontCSSURL:      config.DefaultFontCSSURL,
		FontFileOrigins: []string{config.DefaultFontFileOrigins},
	}
}

func newTestServer(t *testing.T, c config.Config) http.Handler {
	t.Helper()
	h, err := New(c, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func get(t *testing.T, h http.Handler, target string) (*http.Response, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	return res, string(body)
}

// servedPages is every HTML page the app serves, so the page-wide rules below
// cover a worksheet added tomorrow without anyone remembering to list it.
func servedPages() []string {
	p := []string{"/", "/sheet/no-such-sheet"}
	for _, s := range sheets.All() {
		p = append(p, "/sheet/"+s.Slug)
	}
	return p
}

func TestRoutes(t *testing.T) {
	h := newTestServer(t, testConfig())
	cases := []struct {
		path   string
		status int
		want   string
	}{
		{"/", 200, "/sheet/warm-up"},
		{"/sheet/arches", 200, "Branching arches"},
		{"/sheet/no-such-sheet", 404, "Not found"},
		{"/nope", 404, ""},
	}
	for _, c := range cases {
		res, body := get(t, h, c.path)
		if res.StatusCode != c.status {
			t.Errorf("%s: status %d, want %d", c.path, res.StatusCode, c.status)
		}
		if !strings.Contains(body, c.want) {
			t.Errorf("%s: body missing %q", c.path, c.want)
		}
	}
}

// Every model line needs its own practice canvas and buttons; a template slip
// that rendered only the first line would otherwise pass unnoticed.
func TestSheetRendersEveryLine(t *testing.T) {
	h := newTestServer(t, testConfig())
	s, _ := sheets.Get("arches")
	_, body := get(t, h, "/sheet/arches")
	if n := strings.Count(body, `class="row"`); n != len(s.Lines) {
		t.Errorf("rendered %d rows, want %d", n, len(s.Lines))
	}
	for _, line := range s.Lines {
		if !strings.Contains(body, `<p class="model">`+line+`</p>`) {
			t.Errorf("missing model line %q", line)
		}
	}
}

func TestCSPAllowsConfiguredFontOrigins(t *testing.T) {
	h := newTestServer(t, testConfig())
	res, _ := get(t, h, "/")
	csp := res.Header.Get("Content-Security-Policy")
	for _, want := range []string{
		"default-src 'self'",
		"script-src 'self';",
		"style-src 'self' https://fonts.googleapis.com;",
		"font-src 'self' https://fonts.gstatic.com;",
		"object-src 'none'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
	} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP missing %q:\n%s", want, csp)
		}
	}
	if strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "unsafe-eval") {
		t.Errorf("CSP must not allow inline or eval:\n%s", csp)
	}
}

// With no remote stylesheet the page must not link one, and the CSP must not
// keep allowing a host nothing uses.
func TestLocalFontNeedsNoRemoteOrigins(t *testing.T) {
	c := testConfig()
	c.FontCSSURL = ""
	c.FontFileOrigins = nil
	h := newTestServer(t, c)
	res, body := get(t, h, "/")
	if strings.Contains(body, "googleapis") {
		t.Error("page still links the remote font stylesheet")
	}
	csp := res.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, "style-src 'self';") || !strings.Contains(csp, "font-src 'self';") {
		t.Errorf("CSP still allows remote font origins:\n%s", csp)
	}
}

var (
	inlineStyle   = regexp.MustCompile(`(?i)<[^>]+\sstyle\s*=`)
	inlineHandler = regexp.MustCompile(`(?i)<[^>]+\son[a-z]+\s*=`)
	inlineScript  = regexp.MustCompile(`(?i)<script(?:\s[^>]*)?>[^<]+</script>`)
	styleElement  = regexp.MustCompile(`(?i)<style[\s>]`)
)

// The CSP refuses inline styles and handlers, so one in a template would
// render, pass every handler test and silently do nothing in a browser.
func TestNoInlineStylesOrHandlers(t *testing.T) {
	h := newTestServer(t, testConfig())
	pages := servedPages()
	if len(pages) < 5 {
		t.Fatalf("only %d pages checked; the sheet list is not loading", len(pages))
	}
	for _, p := range pages {
		_, body := get(t, h, p)
		for name, re := range map[string]*regexp.Regexp{
			"style attribute": inlineStyle,
			"event handler":   inlineHandler,
			"inline script":   inlineScript,
			"style element":   styleElement,
		} {
			if m := re.FindString(body); m != "" {
				t.Errorf("%s: %s: %s", p, name, m)
			}
		}
	}
}

// Every asset a page references must resolve, with the type the browser
// needs: a module script served as text/plain is refused outright.
func TestReferencedAssetsAreServed(t *testing.T) {
	h := newTestServer(t, testConfig())
	_, body := get(t, h, "/sheet/warm-up")
	refs := regexp.MustCompile(`(?:href|src)="(/static/[^"]+)"`).FindAllStringSubmatch(body, -1)
	if len(refs) < 4 {
		t.Fatalf("found %d asset references, want at least 4", len(refs))
	}
	for _, r := range refs {
		url := strings.ReplaceAll(r[1], "&amp;", "&")
		res, _ := get(t, h, url)
		if res.StatusCode != 200 {
			t.Errorf("%s: status %d", url, res.StatusCode)
		}
		if !strings.Contains(res.Header.Get("Cache-Control"), "immutable") {
			t.Errorf("%s: hashed URL not cached immutably", url)
		}
		if strings.HasSuffix(strings.Split(url, "?")[0], ".js") && !strings.HasPrefix(res.Header.Get("Content-Type"), "text/javascript") {
			t.Errorf("%s: Content-Type %q", url, res.Header.Get("Content-Type"))
		}
	}
}

// A stale or bare URL must revalidate, or a deploy could leave an old app.js
// pinned in a browser cache for a year.
func TestUnhashedAssetIsNotImmutable(t *testing.T) {
	h := newTestServer(t, testConfig())
	for _, u := range []string{"/static/app.js", "/static/app.js?v=stale"} {
		res, _ := get(t, h, u)
		if res.StatusCode != 200 || strings.Contains(res.Header.Get("Cache-Control"), "immutable") {
			t.Errorf("%s: status %d, Cache-Control %q", u, res.StatusCode, res.Header.Get("Cache-Control"))
		}
	}
}

func TestUnlistedExtensionIsNotServed(t *testing.T) {
	h := newTestServer(t, testConfig())
	for _, u := range []string{"/static/", "/static/../handler.go", "/static/nope.css"} {
		if res, _ := get(t, h, u); res.StatusCode == 200 {
			t.Errorf("%s served", u)
		}
	}
}

func TestFontStylesheetCarriesFamily(t *testing.T) {
	c := testConfig()
	c.FontFamily = "Some Font"
	h := newTestServer(t, c)
	_, body := get(t, h, "/")
	m := regexp.MustCompile(`href="(/static/font\.css\?v=[0-9a-f]+)"`).FindStringSubmatch(body)
	if m == nil {
		t.Fatal("page does not link font.css")
	}
	_, css := get(t, h, m[1])
	if !strings.Contains(css, `--ref-font: "Some Font";`) {
		t.Errorf("font.css = %q", css)
	}
}
