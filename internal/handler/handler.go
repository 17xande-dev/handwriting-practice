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

	"calligraphy/internal/config"
	"calligraphy/internal/sheets"
)

//go:embed templates
var templateFS embed.FS

// Server holds everything a request needs; it is built once at startup.
type Server struct {
	cfg    config.Config
	assets assets
	pages  map[string]*template.Template
	log    *slog.Logger
}

// page is the data every template receives.
type page struct {
	Title      string
	FontCSSURL string
	Sheets     []sheets.Sheet
	Sheet      sheets.Sheet
}

// New builds the server. Every failure here (an unparsable template, a page
// missing its content block) is a startup failure, never a broken page later.
func New(cfg config.Config, log *slog.Logger) (http.Handler, error) {
	a, err := loadAssets(map[string][]byte{"font.css": fontCSS(cfg.FontFamily)})
	if err != nil {
		return nil, err
	}
	s := &Server{cfg: cfg, assets: a, log: log}
	if s.pages, err = parsePages(a); err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.index)
	mux.HandleFunc("GET /sheet/{slug}", s.sheet)
	mux.HandleFunc("GET /static/", a.serve)
	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		u, _ := a.url("favicon.svg")
		http.Redirect(w, r, u, http.StatusMovedPermanently)
	})
	return securityHeaders(newPolicy(cfg), mux), nil
}

// fontCSS hands the configured family to the stylesheet as a custom property.
// Generating a stylesheet keeps the family out of an inline style, which the
// CSP refuses. config.Load restricts the name to characters that are safe
// inside a quoted CSS string.
func fontCSS(family string) []byte {
	return fmt.Appendf(nil, ":root { --ref-font: %q; }\n", family)
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
	data.FontCSSURL = s.cfg.FontCSSURL
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
