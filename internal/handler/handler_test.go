package handler

import (
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"calligraphy/internal/fonts"
	"calligraphy/internal/sheets"
)

func newTestServer(t *testing.T, list []fonts.Font) http.Handler {
	t.Helper()
	h, err := New(list, slog.New(slog.NewTextHandler(io.Discard, nil)))
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
	p := []string{"/", "/sheet/no-such-sheet", "/practice/new"}
	for _, s := range sheets.All() {
		p = append(p, "/sheet/"+s.Slug)
	}
	return p
}

func TestRoutes(t *testing.T) {
	h := newTestServer(t, fonts.Builtin)
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
	h := newTestServer(t, fonts.Builtin)
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
	h := newTestServer(t, fonts.Builtin)
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

// A catalogue with no remote fonts must not link a stylesheet, and the CSP
// must allow Google Fonts (for the picker) and nothing else remote.
func TestLocalCatalogueAllowsOnlyGoogle(t *testing.T) {
	h := newTestServer(t, []fonts.Font{{ID: "local", Label: "Local", Family: "Local Font"}})
	res, body := get(t, h, "/sheet/arches")
	if strings.Contains(body, "googleapis") {
		t.Error("page links a remote font stylesheet")
	}
	csp := res.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, "style-src 'self' https://fonts.googleapis.com;") ||
		!strings.Contains(csp, "font-src 'self' https://fonts.gstatic.com;") {
		t.Errorf("CSP font origins wrong:\n%s", csp)
	}
}

// Every catalogue font must be offered on a worksheet, carrying the slant the
// script draws the paper with, and have its stylesheet linked.
func TestSheetOffersEveryModelFont(t *testing.T) {
	h := newTestServer(t, fonts.Builtin)
	_, body := get(t, h, "/sheet/arches")
	for i, f := range fonts.Builtin {
		want := `value="` + f.ID + `" data-slant="` + strconv.FormatFloat(f.Slant, 'f', -1, 64) + `"`
		if !strings.Contains(body, want) {
			t.Errorf("no picker for %s (want %s)", f.ID, want)
		}
		if checked := strings.Contains(body, want+" checked"); checked != (i == 0) {
			t.Errorf("%s: checked = %v; only the first font should be the default", f.ID, checked)
		}
		if f.Italic && !strings.Contains(body, want+` data-style="italic"`) {
			t.Errorf("%s: italic font not marked italic for the script", f.ID)
		}
		if !strings.Contains(html.UnescapeString(body), `href="`+f.CSSURL+`"`) {
			t.Errorf("stylesheet for %s not linked", f.ID)
		}
	}
}

// The "any Google font" picker is offered on every worksheet, and its inputs
// belong to the toolbar form so they're read and remembered with the rest.
func TestSheetOffersAnyGoogleFont(t *testing.T) {
	h := newTestServer(t, fonts.Builtin)
	_, body := get(t, h, "/sheet/arches")
	for _, want := range []string{
		`form="toolbar" name="model" value="custom"`,
		`form="toolbar" name="customFont"`,
		`form="toolbar" name="customSlant"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %s", want)
		}
	}
}

// A catalogue that fails validation must stop the server starting, not
// produce a stylesheet with an unescaped family name in it.
func TestInvalidCatalogueFailsStartup(t *testing.T) {
	_, err := New([]fonts.Font{{ID: "x", Label: "X", Family: `x"; }`}}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil {
		t.Fatal("New accepted an unsafe font family")
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
	h := newTestServer(t, fonts.Builtin)
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
	h := newTestServer(t, fonts.Builtin)
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
	h := newTestServer(t, fonts.Builtin)
	for _, u := range []string{"/static/app.js", "/static/app.js?v=stale"} {
		res, _ := get(t, h, u)
		if res.StatusCode != 200 || strings.Contains(res.Header.Get("Cache-Control"), "immutable") {
			t.Errorf("%s: status %d, Cache-Control %q", u, res.StatusCode, res.Header.Get("Cache-Control"))
		}
	}
}

func TestUnlistedExtensionIsNotServed(t *testing.T) {
	h := newTestServer(t, fonts.Builtin)
	for _, u := range []string{"/static/", "/static/../handler.go", "/static/nope.css"} {
		if res, _ := get(t, h, u); res.StatusCode == 200 {
			t.Errorf("%s served", u)
		}
	}
}

func TestFontStylesheetCarriesFamilies(t *testing.T) {
	h := newTestServer(t, fonts.Builtin)
	_, body := get(t, h, "/")
	m := regexp.MustCompile(`href="(/static/font\.css\?v=[0-9a-f]+)"`).FindStringSubmatch(body)
	if m == nil {
		t.Fatal("page does not link font.css")
	}
	_, css := get(t, h, m[1])
	for _, f := range fonts.Builtin {
		if !strings.Contains(css, "--font-"+f.ID+`: "`+f.Family+`"`) {
			t.Errorf("font.css lacks %s:\n%s", f.ID, css)
		}
	}
}

func post(t *testing.T, h http.Handler, target, text string) (*http.Response, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(url.Values{"text": {text}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	return res, string(body)
}

func TestCustomWorksheet(t *testing.T) {
	h := newTestServer(t, fonts.Builtin)
	text := "minimum\nthe quick brown fox jumps over the lazy dog"
	res, body := post(t, h, "/practice", text)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	for _, line := range []string{"minimum", "the quick brown fox jumps", "over the lazy dog"} {
		if !strings.Contains(body, `<p class="model">`+line+`</p>`) {
			t.Errorf("missing model line %q", line)
		}
	}
	// The custom worksheet passes the inline-markup rules like every other page.
	for name, re := range map[string]*regexp.Regexp{"style": inlineStyle, "handler": inlineHandler, "script": inlineScript} {
		if m := re.FindString(body); m != "" {
			t.Errorf("custom worksheet has inline %s: %s", name, m)
		}
	}
	// "Edit this text" posts the original text back to the form intact.
	m := regexp.MustCompile(`<input type="hidden" name="text" value="([^"]*)">`).FindStringSubmatch(body)
	if m == nil {
		t.Fatal("no edit form")
	}
	_, form := post(t, h, "/practice/new", html.UnescapeString(m[1]))
	if !strings.Contains(form, ">"+text+"</textarea>") {
		t.Error("edit form not prefilled with the original text")
	}
}

// The user's text must never travel in a URL: it would land in history, logs
// and Referer headers, and a crafted link could put words in front of them.
func TestCustomTextNeverInURL(t *testing.T) {
	h := newTestServer(t, fonts.Builtin)
	for _, u := range []string{"/practice", "/practice?text=hello"} {
		res, body := get(t, h, u)
		if res.StatusCode != http.StatusSeeOther || res.Header.Get("Location") != "/practice/new" {
			t.Errorf("GET %s: status %d, Location %q", u, res.StatusCode, res.Header.Get("Location"))
		}
		if strings.Contains(body, "hello") {
			t.Errorf("GET %s rendered text from the URL", u)
		}
	}
	if _, body := get(t, h, "/practice/new?text=hello"); strings.Contains(body, "hello") {
		t.Error("GET /practice/new prefilled the form from the URL")
	}
	_, form := get(t, h, "/practice/new")
	if !strings.Contains(form, `method="post" action="/practice"`) {
		t.Error("the text form does not POST")
	}
	res, body := post(t, h, "/practice", "an in un")
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("custom worksheet Cache-Control %q", res.Header.Get("Cache-Control"))
	}
	if strings.Contains(body, "?text=") {
		t.Error("custom worksheet links the text in a URL")
	}
}

func TestCustomWorksheetWithoutTextShowsForm(t *testing.T) {
	h := newTestServer(t, fonts.Builtin)
	for _, text := range []string{"", "  \n\t "} {
		res, body := post(t, h, "/practice", text)
		if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(body, `role="alert"`) {
			t.Errorf("%q: status %d, no error shown", text, res.StatusCode)
		}
	}
}

func TestCustomRefusesOversizedBody(t *testing.T) {
	h := newTestServer(t, fonts.Builtin)
	res, _ := post(t, h, "/practice", strings.Repeat("a", maxCustomBody))
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("status %d", res.StatusCode)
	}
}

// The text is the user's own, so it must render as text in both the
// worksheet and the form.
func TestCustomTextIsEscaped(t *testing.T) {
	h := newTestServer(t, fonts.Builtin)
	evil := `<script>alert(1)</script><img src=x onerror=alert(2)>"><b>`
	for _, u := range []string{"/practice", "/practice/new"} {
		_, body := post(t, h, u, evil)
		if strings.Contains(body, "<script>alert") || strings.Contains(body, "<img src=x") || strings.Contains(body, `"><b>`) {
			t.Errorf("POST %s: unescaped user text in page", u)
		}
	}
}
