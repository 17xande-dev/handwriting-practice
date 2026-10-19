// Package handler serves the HTTP side of the app: server-rendered pages, the
// embedded static assets, and the security headers around them.
package handler

import (
	"bytes"
	"embed"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"time"

	"calligraphy/internal/account"
	"calligraphy/internal/auth"
	"calligraphy/internal/fonts"
	"calligraphy/internal/history"
	"calligraphy/internal/middleware"
	"calligraphy/internal/sheets"
)

//go:embed templates
var templateFS embed.FS

// Options is everything New needs.
type Options struct {
	Fonts []fonts.Font
	Log   *slog.Logger

	// Accounts is the users and sessions store.
	Accounts *account.Store
	// History is the synced check and ink records.
	History *history.Store

	// ClientIP returns the visitor's address for rate limiting; nil means
	// the connection's own address.
	ClientIP func(*http.Request) string

	// HSTS adds Strict-Transport-Security; only for an https deployment.
	HSTS bool
}

// Server holds everything a request needs; it is built once at startup.
type Server struct {
	fonts    []fonts.Font
	assets   assets
	pages    map[string]*template.Template
	log      *slog.Logger
	policy   Policy
	accounts *account.Store
	history  *history.Store
	clientIP func(*http.Request) string
	limits   limits
}

// limits are the rate limits on everything that verifies a password. Each
// verify costs ~100ms and 64 MiB, so an unmetered one is both a guessing
// oracle and a memory lever.
type limits struct {
	// loginEmail is tight: five tries, then one a minute, per email.
	loginEmail *middleware.Limiter
	// loginIP is looser, so one address cannot spray many emails.
	loginIP *middleware.Limiter
	// password limits the change-password form per account. It is keyed on
	// the user, not the cookie, which an attacker could simply discard.
	password *middleware.Limiter
}

// page is the data every template receives.
type page struct {
	Title string
	// Data is what the account and admin pages need beyond the layout.
	Data  any
	Fonts []fonts.Font
	// Groups is the catalogue as the picker shows it: family tiles, each with
	// its variant chips. Default is the variant a worksheet opens with.
	Groups  []fonts.Group
	Default string
	// Sections is the worksheet list as the index shows it, under headings.
	Sections []sheets.Section
	Sheet    sheets.Sheet
	// Text is the user's own exercise text, on the custom pages.
	Text string
	// Custom marks a worksheet made from the user's text, which gets an
	// "Edit this text" button posting the text back to the form.
	Custom   bool
	Error    string
	MaxRunes int
}

// New builds the handler. Every failure here (an unparsable template, a page
// missing its content block, a font catalogue that fails validation) is a
// startup failure, never a broken page later.
func New(o Options) (http.Handler, error) {
	s, err := newServer(o)
	if err != nil {
		return nil, err
	}
	return s.Routes(), nil
}

func newServer(o Options) (*Server, error) {
	if err := fonts.Validate(o.Fonts); err != nil {
		return nil, err
	}
	if o.Accounts == nil || o.History == nil {
		return nil, fmt.Errorf("handler: no account or history store")
	}
	a, err := loadAssets()
	if err != nil {
		return nil, err
	}
	// font.css names the bundled font files by their hashed URLs, so it is
	// generated once the other assets are loaded, and then becomes one itself.
	css, err := fonts.CSS(o.Fonts, a.url)
	if err != nil {
		return nil, err
	}
	a.add("font.css", css)
	policy := newPolicy(o.Fonts)
	policy.HSTS = o.HSTS
	s := &Server{
		fonts: o.Fonts, assets: a, log: o.Log, policy: policy,
		accounts: o.Accounts, history: o.History, clientIP: o.ClientIP,
		limits: limits{
			loginEmail: middleware.NewLimiter(5, time.Minute),
			loginIP:    middleware.NewLimiter(10, 10*time.Second),
			password:   middleware.NewLimiter(5, time.Minute),
		},
	}
	if s.clientIP == nil {
		s.clientIP = middleware.ClientIP("")
	}
	if s.pages, err = parsePages(a); err != nil {
		return nil, err
	}
	return s, nil
}

// handleFunc registers one route. Every route goes through one, so a test
// can collect the complete list (see TestEveryRouteIsPublicOrProtected)
// instead of trusting a second, hand-kept list to stay in step.
type handleFunc func(pattern string, f http.Handler)

// Routes returns the whole site behind its security headers.
//
// Every state-changing request passes the stdlib's cross-origin check
// (Sec-Fetch-Site, falling back to Origin against Host), which is the CSRF
// defence for the forms and the API alike. A request from the iPad app
// carries neither header and passes; it authenticates with a bearer token a
// browser would never attach on its own.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	s.routes(func(pattern string, f http.Handler) { mux.Handle(pattern, f) })
	return securityHeaders(s.policy, adminHeaders(http.NewCrossOriginProtection().Handler(mux)))
}

func (s *Server) routes(handle handleFunc) {
	s.register(handle)
	s.registerAPI(handle)
	s.registerAdmin(handle)
}

func (s *Server) register(handle handleFunc) {
	handle("GET /{$}", http.HandlerFunc(s.index))
	handle("GET /sheet/{slug}", http.HandlerFunc(s.sheet))
	handle("GET /progress", http.HandlerFunc(s.progress))
	handle("GET /strokes", http.HandlerFunc(s.strokes))
	handle("GET /fonts", http.HandlerFunc(s.fontsPage))
	handle("GET /practice/new", http.HandlerFunc(s.customForm))
	handle("POST /practice/new", http.HandlerFunc(s.customForm))
	handle("POST /practice", http.HandlerFunc(s.custom))
	handle("GET /practice", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/practice/new", http.StatusSeeOther)
	}))
	handle("GET /static/", http.HandlerFunc(s.assets.serve))
	handle("GET /favicon.ico", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, _ := s.assets.url("favicon.svg")
		http.Redirect(w, r, u, http.StatusMovedPermanently)
	}))
	handle("GET /healthz", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	}))

	handle("GET /account", http.HandlerFunc(s.accountGet))
	handle("POST /account/login", http.HandlerFunc(s.login))
	handle("POST /account/logout", http.HandlerFunc(s.logout))
	handle("POST /account/password", s.requireUser(s.changePassword))
	handle("POST /account/sessions/{id}/revoke", s.requireUser(s.revokeSession))
}

// parsePages parses one template set per page (the layout plus that page),
// because a single flat set lets the last file to define "content" win and
// every page renders as that one.
func parsePages(a assets) (map[string]*template.Template, error) {
	funcs := template.FuncMap{
		"asset": a.url,
		"inc":   func(i int) int { return i + 1 },
		"when":  when,
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

// renderData renders an account or admin page. These carry someone's account
// (emails, sessions, a generated password), so they are never cached.
func (s *Server) renderData(w http.ResponseWriter, status int, file, title string, data any) {
	w.Header().Set("Cache-Control", "no-store")
	s.render(w, status, file, page{Title: title, Data: data})
}

func (s *Server) serverError(w http.ResponseWriter, err error) {
	if errors.Is(err, auth.ErrBusy) {
		busy(w)
		return
	}
	s.log.Error("render", "err", err)
	http.Error(w, "internal server error", http.StatusInternalServerError)
}

// busy answers a request that could not get an argon2 slot: 503 with a
// Retry-After, which is a fault of load, not of the request.
func busy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "5")
	http.Error(w, "the server is busy; try again in a few seconds", http.StatusServiceUnavailable)
}

// Form bodies are capped before they are read: sign-in and the admin forms
// carry a couple of short fields, the password form three of at most 256
// characters (up to three bytes each once percent-escaped).
const (
	maxFormBody     = 4 << 10
	maxPasswordForm = 8 << 10
)

// parseForm reads a POSTed form under a size cap. It answers 413 itself and
// reports false when the body is over the cap or unreadable.
func parseForm(w http.ResponseWriter, r *http.Request, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := r.ParseForm(); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			http.Error(w, "form too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "bad form", http.StatusBadRequest)
		}
		return false
	}
	return true
}

func (s *Server) index(w http.ResponseWriter, r *http.Request) {
	s.render(w, http.StatusOK, "index.html", page{Title: "Worksheets", Sections: sheets.Sections()})
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

// progress is the history page. The history itself lives in the browser
// (IndexedDB) and is drawn by script; the server only serves the frame.
func (s *Server) progress(w http.ResponseWriter, r *http.Request) {
	s.render(w, http.StatusOK, "progress.html", page{Title: "Progress"})
}

// fontsPage is the Fonts page: the library of bundled and Google handwriting fonts, where a person
// stars their favourites for the toolbar. The favourites live in the browser (localStorage, and a
// `prefs` record when signed in); the server renders the catalogue and serves the Google list
// (/static/google-handwriting.json, generated by tools/gen-google-handwriting.ts).
func (s *Server) fontsPage(w http.ResponseWriter, r *http.Request) {
	s.render(w, http.StatusOK, "fonts.html", page{Title: "Fonts"})
}

// strokes is the Stroke models page: the fonts, a glyph grid per font and the editor where a person
// writes their own strokes. The definitions live in the browser (IndexedDB, synced as `strokes`
// records); the server only serves the frame and the built-in models (/static/strokes).
func (s *Server) strokes(w http.ResponseWriter, r *http.Request) {
	s.render(w, http.StatusOK, "strokes.html", page{Title: "Stroke models"})
}
