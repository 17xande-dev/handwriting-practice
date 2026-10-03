// Package handler serves the HTTP side of the app: server-rendered pages, the
// embedded static assets, and the security headers around them.
package handler

import (
	"bytes"
	"embed"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
	"path"

	"calligraphy/internal/fonts"
	"calligraphy/internal/sheets"
)

//go:embed templates
var templateFS embed.FS

// Server holds everything a request needs; it is built once at startup.
type Server struct {
	fonts  []fonts.Font
	assets assets
	pages  map[string]*template.Template
	log    *slog.Logger
}

// page is the data every template receives.
type page struct {
	Title string
	Fonts []fonts.Font
	// Groups is the catalogue as the picker shows it: family tiles, each with
	// its variant chips. Default is the variant a worksheet opens with.
	Groups  []fonts.Group
	Default string
	Sheets  []sheets.Sheet
	Sheet   sheets.Sheet
	// Text is the user's own exercise text, on the custom pages.
	Text string
	// Custom marks a worksheet made from the user's text, which gets an
	// "Edit this text" button posting the text back to the form.
	Custom   bool
	Error    string
	MaxRunes int
}

// New builds the server. Every failure here (an unparsable template, a page
// missing its content block) is a startup failure, never a broken page later.
func New(fontList []fonts.Font, log *slog.Logger) (http.Handler, error) {
	if err := fonts.Validate(fontList); err != nil {
		return nil, err
	}
	a, err := loadAssets()
	if err != nil {
		return nil, err
	}
	// font.css names the bundled font files by their hashed URLs, so it is
	// generated once the other assets are loaded, and then becomes one itself.
	css, err := fonts.CSS(fontList, a.url)
	if err != nil {
		return nil, err
	}
	a.add("font.css", css)
	s := &Server{fonts: fontList, assets: a, log: log}
	if s.pages, err = parsePages(a); err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.index)
	mux.HandleFunc("GET /sheet/{slug}", s.sheet)
	mux.HandleFunc("GET /practice/new", s.customForm)
	mux.HandleFunc("POST /practice/new", s.customForm)
	mux.HandleFunc("POST /practice", s.custom)
	mux.HandleFunc("GET /practice", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/practice/new", http.StatusSeeOther)
	})
	mux.HandleFunc("GET /static/", a.serve)
	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		u, _ := a.url("favicon.svg")
		http.Redirect(w, r, u, http.StatusMovedPermanently)
	})
	return securityHeaders(newPolicy(fontList), mux), nil
}

// parsePages parses one template set per page (the layout plus that page),
// because a single flat set lets the last file to define "content" win and
// every page renders as that one.
func parsePages(a assets) (map[string]*template.Template, error) {
	funcs := template.FuncMap{
		"asset": a.url,
		"inc":   func(i int) int { return i + 1 },
	}
	names, err := fs.Glob(templateFS, "templates/pages/*.html")
	if err != nil {
		return nil, err
	}
	pages := map[string]*template.Template{}
	for _, n := range names {
		t, err := template.New("layout.html").Funcs(funcs).ParseFS(templateFS, "templates/layout.html", n)
		if err != nil {
			return nil, err
		}
		if t.Lookup("content") == nil {
			return nil, fmt.Errorf("%s defines no content block", n)
		}
		pages[path.Base(n)] = t
	}
	return pages, nil
}

// render buffers the whole page so a template error yields a clean 500 rather
// than half a page under a 200.
func (s *Server) render(w http.ResponseWriter, status int, name string, data page) {
	t, ok := s.pages[name]
	if !ok {
		s.log.Error("unknown page", "page", name)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	data.Fonts = s.fonts
	data.Groups = fonts.Groups(s.fonts)
	data.Default = fonts.DefaultFont(s.fonts).ID
	var buf bytes.Buffer
	if err := t.ExecuteTemplate(&buf, "layout.html", data); err != nil {
		s.log.Error("render", "page", name, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = buf.WriteTo(w)
}

func (s *Server) index(w http.ResponseWriter, r *http.Request) {
	s.render(w, http.StatusOK, "index.html", page{Title: "Worksheets", Sheets: sheets.All()})
}

func (s *Server) sheet(w http.ResponseWriter, r *http.Request) {
	sh, ok := sheets.Get(r.PathValue("slug"))
	if !ok {
		s.render(w, http.StatusNotFound, "notfound.html", page{Title: "Not found"})
		return
	}
	s.render(w, http.StatusOK, "sheet.html", page{Title: sh.Title, Sheet: sh})
}

// The user's own text only ever travels in a POST body: never in a URL, where
// it would land in browser history, server and proxy logs and Referer
// headers, and could be crafted by someone else and sent as a link. Nothing is
// stored on the server, and the pages carrying it are not cached.

// maxCustomBody bounds the form body: the text limit in runes, at up to four
// bytes each once encoded, with room for the field name and percent-escaping.
const maxCustomBody = sheets.MaxCustomRunes*4*3 + 64

// customText reads the text field from a POSTed form, refusing oversized bodies.
func customText(w http.ResponseWriter, r *http.Request) (string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxCustomBody)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "text too long", http.StatusRequestEntityTooLarge)
		return "", false
	}
	return r.PostForm.Get("text"), true
}

// customForm is where the user types or pastes their own text. A GET shows
// an empty form (script refills it from this device's storage); a POST comes
// from "Edit this text" on a custom worksheet and refills it from the body.
func (s *Server) customForm(w http.ResponseWriter, r *http.Request) {
	var text string
	if r.Method == http.MethodPost {
		var ok bool
		if text, ok = customText(w, r); !ok {
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	s.render(w, http.StatusOK, "custom.html", page{
		Title:    "Your own text",
		Text:     text,
		MaxRunes: sheets.MaxCustomRunes,
	})
}

// custom renders the user's text as a worksheet.
func (s *Server) custom(w http.ResponseWriter, r *http.Request) {
	text, ok := customText(w, r)
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	sh, err := sheets.Custom(text)
	if err != nil {
		s.render(w, http.StatusUnprocessableEntity, "custom.html", page{
			Title:    "Your own text",
			Text:     text,
			Error:    "There's no text to practise yet. Type or paste some first.",
			MaxRunes: sheets.MaxCustomRunes,
		})
		return
	}
	s.render(w, http.StatusOK, "sheet.html", page{
		Title:  sh.Title,
		Sheet:  sh,
		Text:   text,
		Custom: true,
	})
}
