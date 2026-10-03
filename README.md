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

- Everything below the toolbar is one writing area that the app handles
  itself. It has `touch-action: none` and no text selection, so a hand resting
  on the glass can't scroll, zoom or select anything. There:
  - only `pointerType === "pen"` writes, and only on a practice line;
  - **two fingers scroll**, with momentum;
  - **one finger does nothing**, so a resting palm is harmless. Contact size
    can't tell a palm from a finger: Safari reports fingertips 63–125px wide
    on an iPad Air, as measured on the device;
  - touches landing within 500ms of the Pencil are ignored as a palm;
  - "Finger draws" in the toolbar lets one finger or a mouse write, for
    testing on a desktop.
- `getCoalescedEvents()` recovers the Pencil's full sample rate (up to 240Hz)
  between frames; `getPredictedEvents()`, where the browser has it, draws a
  short predicted tail to hide a frame of latency.
- Pressure, altitude and azimuth are stored with each point. Pressure drives
  the line width; the angles are kept for later (a nib that follows the pen's
  rotation, stroke analysis).
- Strokes are stored in x-height units relative to the baseline, so changing
  the size or rotating the iPad rescales the ink rather than stranding it.

### Pens

The toolbar shows each pen as a picture, with a live preview that writes a
short "nu" in the current pen, weight and slant. Weight, nib width, nib angle
and size are all sliders.

- **Monoline**: round pen, width follows pressure. Basic Getty-Dubay italic is
  written this way, with a pencil or fine pen.
- **Edged nib**: a broad nib at a fixed angle (default 45°), sized in nib
  widths per x-height (default 5). Each segment fills the parallelogram the
  nib edge sweeps, so thick and thin strokes come from the stroke direction as
  with a real chisel-edged pen.

### Model fonts

Worksheets can show their models in either font from the catalogue in
`internal/fonts`. The models are drawn on a canvas, and the guides are placed
from the chosen font's measured proportions (the heights of "x" and "l", the
depth of "p"), so any font sits correctly on them. Each font also sets the
paper's slant lines:

| Model | Font | Slant | Why |
|---|---|---|---|
| Italic (default) | Edu SA Beginner | 5° | A South Australian school hand derived from italic. Of the open-licensed school fonts compared, it was closest to Getty-Dubay basic italic: elliptical bowls, branching arches, exit strokes and a gentle slope. Its f stays on the baseline, whereas Getty-Dubay's descends. |
| Upright | Playwrite US Modern | 0° | An upright school hand from the same Playwrite family. Edu QLD and Playwrite NZ still slope, and Andika is a print face rather than handwriting. |

Both fonts are SIL OFL and served by Google Fonts; the official Getty-Dubay
fonts are commercial. `ADDR` (default `:8080`) is the only environment
variable.

The Content-Security-Policy is built from the catalogue: `style-src` and
`font-src` allow exactly the origins the fonts use, and nothing else.
`fonts.Validate` runs at startup and is the gate user-supplied fonts will
have to pass.

### Your own text

"Your own text" on the index takes typed or pasted text and turns each line
into a model, wrapping long lines at 28 characters and dropping control and
invisible characters (`sheets.Custom`). The text only ever travels in a POST
body, never in a URL: a URL would put it in browser history, server and proxy
logs and Referer headers, and would let someone else craft a link that puts
words in front of you. Nothing is stored on the server, the pages carrying
the text are sent `Cache-Control: no-store`, and "Edit this text" posts it
back to the form. The device remembers the last text in local storage, so
the form isn't empty next time. There is no sharing, by design.

## Security

- The CSP has no `unsafe-inline`. Templates carry no `style=` attributes, no
  `on*=` handlers and no inline scripts, and a test checks every served page
  for them. The font families reach CSS through a generated, content-hashed
  `font.css`, not inline styles.
- `/static` serves only extensions in an explicit allow-list, at
  content-hashed URLs cached as immutable. An unhashed or stale URL must
  revalidate.

## Decisions still open

| Decision | Candidates | What would force it |
|---|---|---|
| Sharing a custom exercise | A server-stored exercise behind an unguessable id, perhaps with an owner | Wanting to send an exercise to someone. Putting the text in the URL was rejected (see "Your own text"). |
| Saving practice | IndexedDB on the device; SQLite on the server | Wanting history, or work surviving a reload |
| User-chosen fonts | A per-user entry in the catalogue | That feature. The CSP is built per catalogue, so user-supplied origins need checking against an allow-list (for example, Google Fonts only), not trusting. |
| Stroke-order models | Hand-authored SVG paths per letter | Wanting animated stroke order or direction arrows, which a font can't give |
| Getty-Dubay proportions | Fixed guide ratios instead of the font's measured ones | A model font whose proportions stray from the hand |
| htmx / Web Awesome | Add when a server round-trip or a complex control needs them | Saving or account features. v1 has neither. |
| Dark mode | Ink and guide colours for a dark page | Requests for it. The page imitates paper, so it's light only for now. |
