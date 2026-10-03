package handler

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed static
var staticFS embed.FS

// contentTypes is the only gate on what /static serves: an extension missing
// here is refused outright, so a stray .html or .map file can never be
// published by being dropped into the directory.
var contentTypes = map[string]string{
	".css": "text/css; charset=utf-8",
	".js":  "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ttf": "font/ttf",
}

type asset struct {
	body  []byte
	ctype string
	hash  string
}

// assets is every servable file, keyed by name, with a content hash for
// cache-busting URLs.
type assets map[string]asset

func loadAssets() (assets, error) {
	a := assets{}
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		return nil, err
	}
	err = fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		body, err := fs.ReadFile(sub, p)
		if err != nil {
			return err
		}
		a.add(p, body)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return a, nil
}

// add registers a servable file. A name whose extension isn't in
// contentTypes is ignored, so it can never be served.
func (a assets) add(name string, body []byte) {
	ctype, ok := contentTypes[path.Ext(name)]
	if !ok {
		return
	}
	sum := sha256.Sum256(body)
	a[name] = asset{body: body, ctype: ctype, hash: hex.EncodeToString(sum[:])[:12]}
}

// url returns the content-hashed URL for a template's {{asset "name"}}. An
// unknown name fails the render (a 500), which the page tests catch, rather
// than shipping a page with a broken link.
func (a assets) url(name string) (string, error) {
	f, ok := a[name]
	if !ok {
		return "", fmt.Errorf("unknown asset %q", name)
	}
	return "/static/" + name + "?v=" + f.hash, nil
}

func (a assets) serve(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/static/")
	f, ok := a[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", f.ctype)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Only a request carrying the current hash may be cached forever; a bare
	// or stale URL must revalidate, or an old app.js could stick after a deploy.
	if r.URL.Query().Get("v") == f.hash {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(f.body))
}
