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

The model is chosen from the strip above the worksheet title: first a font
family, then one of its variants (each chip shows the font's real name,
written in that font). It's not in the sticky toolbar because there are too
many, and it rarely changes mid-line. The models are drawn on a canvas, and
the guides are placed from the chosen font's measured proportions (the
heights of "x" and "l", the depth of "p"), so any font sits correctly on them.
Each variant also sets the paper's slant lines.

The catalogue, in `internal/fonts`, in picker order:

| Family | Variants | Slant | Source |
|---|---|---|---|
| Briem Hand | Briem Hand Unjoined (print), Briem Hand (joined) | 3.5° | Bundled from the Briem-Hand v1.004 release; see `third_party/briem-hand/SOURCE.md`. Gunnlaugur Briem's handwriting model. The joins come from the font's contextual alternates. |
| Edu SA Beginner | Edu SA Beginner (italic), **the default** | 5° | Google Fonts. The Getty-Dubay stand-in: a South Australian school hand derived from italic, with elliptical bowls, branching arches and exit strokes. It measures 6°; 5° is Getty-Dubay's slope. Its f stays on the baseline, whereas Getty-Dubay's descends. |
| Playwrite GB | GB S (semi-joined), GB S Italic, GB J (joined), GB J Italic | 0° / 7° | Google Fonts. Playwrite England. |
| Playwrite US | Playwrite US Modern (upright) | 0° | Google Fonts. |
| Google Fonts | any family, by name | measured | See below. |

All are SIL OFL. The Guides variants (Playwrite's and Briem's), which draw
their own ruling, are left out because the app rules the paper itself. The
bundled Briem faces get their own CSS family names ("Briem Hand Print",
"Briem Hand Joined"), so a "Briem Hand" loaded through the Google Fonts
picker can't collide with them. `make fonts-fetch` re-downloads and verifies
them.

**Any Google font.** The last tile takes a Google Fonts family name and loads
it in the browser (`web/googlefont.ts`). The name is checked against Google's
naming (letters, digits, spaces, hyphens) and only ever becomes a query
parameter on a fixed `fonts.googleapis.com` URL, so a typed name can't send
the page anywhere else. It is never sent to this server. An unknown name is
reported, and doesn't replace the font already loaded. The slant is measured
from the font itself (`measureSlant` in `web/measure.ts`): the ascender stems
of l, h, k, b and d, where each pixel row is a single stroke, fitted to a line
and taken as the median. It's flagged as unmeasurable when the letters
disagree, as with looped scripts; then the slider (−20° to 30°, since some
hands lean back) sets it by eye. The chosen font and slant are remembered on
the device.

`ADDR` (default `:8080`) is the only environment variable.

The Content-Security-Policy is built from the catalogue, plus Google Fonts'
two origins for the picker: `style-src` and `font-src` allow those and
nothing else. `fonts.Validate` runs at startup.

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
| Fonts from outside Google | Self-hosted or other font services | Wanting a font Google doesn't have. The picker is Google-only so the CSP stays at two fixed origins. |
| Stroke-order models | Hand-authored SVG paths per letter | Wanting animated stroke order or direction arrows, which a font can't give |
| Getty-Dubay proportions | Fixed guide ratios instead of the font's measured ones | A model font whose proportions stray from the hand |
| htmx / Web Awesome | Add when a server round-trip or a complex control needs them | Saving or account features. v1 has neither. |
| Dark mode | Ink and guide colours for a dark page | Requests for it. The page imitates paper, so it's light only for now. |
