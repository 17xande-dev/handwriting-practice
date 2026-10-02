# Italic practice

A web app for practising Getty-Dubay italic handwriting on an iPad with an
Apple Pencil. Each worksheet shows model lines on ruled guides (ascender,
x-height, baseline, descender, 5° slant lines) with a practice line beneath
each one to copy onto.

## Running it

```sh
make run                      # http://localhost:8080
make run ADDR=0.0.0.0:8080    # reachable from an iPad on the same network
```

Then open `http://<this machine's LAN IP>:8080` in Safari on the iPad. Pointer
Events need no secure context, so plain HTTP on the LAN is fine.

`make check` is the gate before a commit: gofmt, `deno fmt`/`lint`/`check`,
`go vet`, a stale-bundle check, and every test. `make up` runs it in Docker.

Requires Go 1.27 and Deno 2.4+ (for `deno bundle`). Deno is only needed to
change the TypeScript: the bundle is checked in, so `go build` alone works.

## How it fits together

| Path | |
|---|---|
| `main.go` | Wiring and graceful shutdown |
| `internal/config` | Every environment variable, parsed into one struct |
| `internal/sheets` | The built-in worksheets |
| `internal/handler` | Routes, templates, embedded static files, security headers |
| `web/` | TypeScript source for the drawing surface, bundled to `internal/handler/static/app.js` |

### Pencil input

All of it is in `web/pen.ts`, using Pointer Events:

- Only `pointerType === "pen"` writes, so a resting palm can't make marks.
  The canvas has `touch-action: none`, which stops the Pencil scrolling the
  page mid-stroke; finger drags over a canvas are turned back into scrolling by
  script. A touch that starts during or just after a pen stroke is treated as
  a palm and ignored. "Finger draws" in the toolbar lets touch and mouse write
  too, for testing on a desktop.
- `getCoalescedEvents()` recovers the Pencil's full sample rate (up to 240Hz)
  between frames; `getPredictedEvents()`, where the browser has it, draws a
  short predicted tail to hide a frame of latency.
- Pressure, altitude and azimuth are stored with each point. Pressure drives
  the line width; the angles are kept for later (a nib that follows the pen's
  rotation, stroke analysis).
- Strokes are stored in x-height units relative to the baseline, so changing
  the size or rotating the iPad rescales the ink rather than stranding it.

### Pens

- **Monoline**: round pen, width follows pressure. Basic Getty-Dubay italic is
  written this way, with a pencil or fine pen.
- **Edged nib**: a broad nib at a fixed angle (default 45°), sized in nib
  widths per x-height (default 5). Each segment fills the parallelogram the
  nib edge sweeps, so thick and thin strokes come from the stroke direction as
  with a real chisel-edged pen.

### The reference font

The models are drawn on a canvas with the configured web font. The guides are
placed from the font's own measured proportions (the heights of "x" and "l",
the depth of "p"), so any font sits correctly on them.

The default is **Edu SA Beginner** (SIL OFL, Google Fonts), a South Australian
school hand derived from italic. Of the open-licensed school fonts compared, it
was closest to Getty-Dubay basic italic: elliptical bowls, branching arches,
exit strokes and a gentle slope. The Edu TAS and Playwrite faces were steeper
or rounder. Where it differs: its f stays on the baseline, whereas Getty-Dubay's
descends. The official Getty-Dubay fonts are commercial.

| Variable | Default | |
|---|---|---|
| `ADDR` | `:8080` | Listen address |
| `FONT_FAMILY` | `Edu SA Beginner` | CSS family name. Letters, digits, spaces and hyphens only. |
| `FONT_CSS_URL` | Google Fonts URL for the family | Stylesheet that defines the family; set it empty for a locally installed font |
| `FONT_FILE_ORIGINS` | `https://fonts.gstatic.com` | Comma-separated origins the stylesheet loads font files from |

The Content-Security-Policy is built from these settings: `style-src` and
`font-src` allow exactly the configured origins and nothing else.

## Security

- The CSP has no `unsafe-inline`. Templates carry no `style=` attributes, no
  `on*=` handlers and no inline scripts, and a test checks every served page
  for them. The font family reaches CSS through a generated, content-hashed
  `font.css`, not an inline style.
- `/static` serves only extensions in an explicit allow-list, at
  content-hashed URLs cached as immutable. An unhashed or stale URL must
  revalidate.

## Decisions still open

| Decision | Candidates | What would force it |
|---|---|---|
| Saving practice | IndexedDB on the device; SQLite on the server | Wanting history, or work surviving a reload |
| User-chosen fonts | A per-user font URL | That feature. The CSP then has to admit user-supplied origins, so they need validating against an allow-list, not trusting. |
| Stroke-order models | Hand-authored SVG paths per letter | Wanting animated stroke order or direction arrows, which a font can't give |
| Getty-Dubay proportions | Fixed guide ratios instead of the font's measured ones | A model font whose proportions stray from the hand |
| htmx / Web Awesome | Add when a server round-trip or a complex control needs them | Saving or account features. v1 has neither. |
| Dark mode | Ink and guide colours for a dark page | Requests for it. The page imitates paper, so it's light only for now. |
