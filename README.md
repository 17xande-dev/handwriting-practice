# Italic practice

A web app for practising Getty-Dubay italic handwriting on an iPad with an
Apple Pencil. Each worksheet shows model lines on ruled guides (ascender,
x-height, baseline, descender, 5° slant lines) with a practice line beneath
each one to copy onto.

## Running it

```sh
make run                      # http://localhost:8083
make run ADDR=0.0.0.0:8083    # reachable from an iPad on the same network
```

Then open `http://<this machine's LAN IP>:8083` in Safari on the iPad. Pointer
Events need no secure context, so plain HTTP on the LAN is fine for writing.
Signing in (see "Accounts and sync") needs HTTPS or `http://localhost`, because
the session cookie is `Secure`.

The server needs `DB_PATH`, a SQLite file for accounts and synced history;
`make run` defaults it to `~/.local/share/handwriting/handwriting.db`
(`make run DB_PATH=...` to change it). Create the first admin with
`DB_PATH=... go run . -add-admin you@example.com`.

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
| `internal/handler` | Routes, templates, embedded static files, security headers, the account and admin pages, `/api` |
| `internal/account`, `internal/auth` | Users and sessions in SQLite; argon2id and token hashing |
| `internal/history` | The synced `check` and `ink` records |
| `internal/db` | SQLite (sqlitekit settings and backups), goose migrations on STRICT tables (`-migrate-status` lists them; a database from the old `user_version` runner is adopted once at startup) |
| `internal/middleware` | Request log (rate limiting and client IP come from `github.com/17xande-dev/ratelimit`) |
| `web/` | TypeScript source for the drawing surface, bundled to `internal/handler/static/app.js` |

### Pencil input

All of it is in `web/pen.ts`. Writing uses Pointer Events; scrolling is
Safari's own, gated with Touch Events.

- Everything below the toolbar is one writing area with no text selection,
  no callout and no zooming (`touch-action: pan-y`). There:
  - only `pointerType === "pen"` writes, and only on a practice line;
  - the **Pencil never scrolls**: its `touchstart` is cancelled when Safari
    reports `touchType` "stylus";
  - **two fingers scroll** natively, with Safari's own momentum;
  - **one finger, or a palm, doesn't scroll**: its moves are cancelled while
    it is the only touch down. Contact size can't tell a palm from a finger
    (Safari reports fingertips 63–125px wide on an iPad Air), so the finger
    count is the palm rejection. While the Pencil is on the glass, iPadOS
    stops delivering finger touches at all;
  - "Finger draws" in the toolbar lets one finger or a mouse write, for
    testing on a desktop.
- Scrolling from script was tried and dropped. On the iPad, Safari reports a
  touch's `clientY` and `screenY` shifted by however far script has scrolled
  the page, so moving the page by the fingers' travel fed back into itself.
  Measured on the device, the page swung thousands of pixels each frame,
  then, with screen coordinates, still reversed direction on most frames.
- **Undo and redo** cover the whole sheet: every stroke and every Clear is an
  edit, undone in order whichever line it was on (`web/history.ts`). There
  are toolbar buttons, a quick **two-finger tap** to undo and **three-finger
  tap** to redo, and ⌘/Ctrl+Z, ⇧⌘/Ctrl+Z and Ctrl+Y on a keyboard. A tap
  counts only if the fingers land within 120 ms of each other, move under
  12 px and lift within 350 ms, with no Pencil in between (`TapTracker`), so
  scrolling and resting palms don't undo anything.
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

### Worksheets

The 17 built-in worksheets (`internal/sheets`) follow what the respected
italic courses have in common, in three sections:

- **Letters.** Movement comes first: Briem's course starts with zigzags and
  turns them into letters by adding "recognition points" ("uuu" becomes
  "uiui" with two dots), so the first sheet is zigzags and patterns. Then
  the lowercase families: straight lines, branching arches, Briem's
  b-family (the triangular bowl inverted: b, p), the a-family (the bowl,
  carried on into u and y), ovals (with Briem's e in two movements),
  diagonals, and f with t, which share the crossbar join.
- **Joins**, one kind at a time, as Reynolds, Eager and Getty-Dubay teach
  them: diagonal joins into n and m, then into round letters, then
  horizontal joins out of o, f, t, v and w, then the letters that don't
  join, then Reynolds' "nanbncn…" chains, which join every letter both ways.
- **Beyond lowercase.** Numerals and punctuation (both on Briem's model
  strip), capitals (Roman inscriptional proportions, after Reynolds and
  Eager), spacing drills (after Eager's "Words for Spacing"), and sentences
  with capitals and punctuation.

Every built-in line fits within 28 characters, so it never shrinks on an
iPad. A sheet lays every line out at the size its longest line fits, so a
sheet never mixes sizes. Sources:
[briem.net handwriting](https://www.briem.net/handwriting) and its desk
strip; Reynolds, [*Italic Calligraphy & Handwriting*](https://archive.org/details/lloyd-reynolds-italic-calligraphy-and-handwriting-exercises-and-text-taplinger-1969-1);
Eager, [*The Italic Way to Beautiful Handwriting*](https://archive.org/details/italicwaytobeaut00eage);
Sassoon & Briem, [*Better Handwriting*](https://archive.org/details/betterhandwritin00sass);
the Portland [Italic Handwriting Series scope and sequence](https://archive.org/details/ERIC_ED291761)
for Getty-Dubay. Not covered yet: timed writing for speed (see the open
decisions below).

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

Environment variables (`internal/config` is the complete list): `ADDR` (default `:8083`
with `make run`; the container uses `:8080`, published on 8083 by `compose.local.yaml`),
`DB_PATH`, `HSTS` and `CLIENT_IP_HEADER`, described under "Accounts and sync".

The Content-Security-Policy is built from the catalogue, plus Google Fonts'
two origins for the picker: `style-src` and `font-src` allow those and
nothing else. `fonts.Validate` runs at startup.

### Check my writing

Each practice line has a **Check** button, and **Check my writing** at the
bottom checks every line with writing on it and adds a sheet summary.
Everything is worked out in the browser (`web/evaluate.ts`, with the pure
parts in `web/evalcore.ts`); nothing is sent anywhere or saved.

A checked line shows:
- the model, faint blue, placed under the writing where it was actually
  written;
- the writing coloured green where it's on the model, amber near it, red off it;
- bold red marks on parts of a letter that weren't written at all;
- a score per letter ("missing" if a letter wasn't written), a score for the
  line, and up to three notes on slant, x-height, letter width and baseline.

Writing again, Undo, Clear or a change of model clears the check, since it no
longer describes the line.

**How it works.** The line is analysed at a fixed scale of 40 pixels per
x-height, whatever its size on screen, and sheared upright by the model's
slant.
1. The model text is rendered with the line's font on the shared baseline.
   Letter boundaries come from the widths of successive prefixes, which keeps
   kerning and contextual joins.
2. The user writes on the same guides, so the two already agree vertically.
   Horizontally, dynamic time warping matches the columns of the model's
   centreline (its skeleton) to the columns of the user's strokes. Each
   column is described by the ink in the ascender, x-height and descender
   zones. This absorbs where the line starts and how widely it is spaced,
   while keeping letters in order.
3. Per letter, the user's line is compared with the model's **centreline**
   (its skeleton), not its filled ink: against a heavy model like Briem, any
   thin line inside the stroke would otherwise score perfectly however uneven
   it was. *Precision* credits each point of the user's line by its distance
   from the centreline, and *coverage* credits each point of the centreline
   by its distance from the user's line. Credit is full within 0.04 x-height
   and falls linearly to none at 0.2, so a wobbly line scores proportionately
   lower. The letter score is the average of the two. The alignment places
   each letter but stretches it only linearly inside, so a misshapen letter
   isn't warped back into shape.
4. Slant is measured from the user's straight downstrokes and compared with
   the model's own, measured the same way. Size, width and baseline are
   compared on letters that sit in the x-height band. The line score is the
   letters' average, less a capped deduction (at most 30%) for those
   proportions.

**Limits.** It compares shapes, not how they were made: stroke order,
direction and pen lifts aren't judged, and a model font's letters are a
stand-in for a teacher's. Tested in Chrome by writing each line from the
model's own centreline (100%), and from altered copies:
- shifted right: still 100%;
- wobbling about the centreline by a typical 0.06 / 0.10 / 0.15 x-height:
  77% / 63% / 52% on Briem Hand Unjoined, 86% / 78% / 62% on Edu SA
  (before centreline scoring, the same lines scored 99–100% on Briem);
- 30% too tall, or leaning 8° more: lower, with an x-height or slant note;
- a letter left out: marked missing.

Open the worksheet with `#debug` to get these helpers in the console.

**Parity fixtures.** `make fixtures` drives headless Chromium over the
DevTools Protocol (`tools/export-fixtures.ts`) and writes
`testdata/parity/<font>-<sheet>-<row>.json`: the model raster
(`renderModelRaster`, run-length encoded) and the scores `checkWithModel`
gives synthetic writings (`web/fixture.ts`). Other implementations of the
scoring replay them; `web/fixture_test.ts` guards against drift. It needs the
network for the Google fonts.

### Progress

Every check is kept on the device, and **Progress** (in the header) shows it.
Each saved line records when it was checked, the worksheet and line, the
model font, the pen, the score, each letter's score and the slant/size
measurements. A line is recorded once per version of the writing: pressing
Check again without writing anything isn't another attempt.

The page has:
- a time range (30 days, 90 days, all time) above everything it filters;
- headline tiles: the average over the last 14 days with its change on the
  fortnight before, lines checked, days practised and the current streak;
- **Score over time**: the daily average as a line, each checked line as a
  faint dot, on a real date axis, with the trend in words ("improving by
  about 5 points a week", from a straight-line fit of the daily averages);
- **Exercises**: lines checked per worksheet, and a table of days practised,
  average, best, first-day-to-latest change and the last date;
- **Letters**: the average score per letter, with the three weakest (of
  letters written at least three times) in blue.

Every chart has a table view, so no value depends on a tooltip or on colour.
The chart colours (one blue, one context grey) were checked with the dataviz
palette validator. The grey is below 3:1 contrast on white, which is why the
tables are always there.

**Storage.** The history is in the browser's IndexedDB
(`web/progress-store.ts`), which stays the source of truth; nothing is sent
anywhere unless you sign in (see "Accounts and sync"). Safari can clear a site's storage after a period without use, so the page
offers **Save a backup** (a JSON file) and **Restore a backup**. A restore
merges, skips lines already present, and validates every entry, since the
file comes from outside. Adding the app to the Home Screen also keeps its
storage.

**Charts** use Chart.js 4.5.1 (MIT), imported per chart type and bundled
into its own `progress.js`, loaded only on the progress page: 178 KB
minified, 62 KB gzipped. Web Awesome was considered, but it has no chart
components.

### Accounts and sync

Accounts keep the history in step between browsers and the iPad app. There is
no sign-up: an admin creates each account at `/admin/users` (a password is
generated and shown once), and the first admin comes from the command line:

```sh
docker compose exec server /calligraphy -add-admin you@example.com
docker compose exec server /calligraphy -reset-password you@example.com
```

(Those are for the local compose stack; for production see "Production: Kamal
on the Docker host" below.)

Both print a generated password once. Everything else about people (reset,
disable, make admin, sign out everywhere, delete) is on `/admin/users`;
signed-in people change their own password and see and sign out their
devices at `/account`.

- **Sessions** are a table holding only the sha256 of an opaque token: the
  `hp_session` cookie in a browser, a bearer token from `POST /api/token` for
  the iPad. Passwords are argon2id (12 characters minimum, nothing else). Every
  endpoint that verifies a password is rate-limited (five tries per email, keyed
  on a hash of it, then one a minute; plus a per-IP ceiling of ten in a burst,
  where an IPv6 client counts by its /64), and a failed sign-in costs the same
  whatever the cause. At most three argon2 computations run at once in the
  process; a fourth waits up to two seconds and then gets `503` with
  `Retry-After`, so a burst cannot exhaust memory. Form bodies are capped
  (4 KB; 8 KB for the password form), emails over 254 bytes or not a bare
  address are refused before they reach the limiter, and failed sign-ins and
  limit hits are logged with a hash prefix of the email and the client IP,
  never a password or token. Signing in over a live session ends that old one.
  Signing out, or signing in as someone else, clears the browser's local sync
  state, and every sync request names the account it expects (`409` on a
  mismatch), so a shared browser cannot push one person's history into
  another's account.
- **Cookie.** `Secure`, `HttpOnly`, `SameSite=Lax`. Browsers accept a `Secure`
  cookie from `https://` and from `http://localhost`, so local development
  works; a plain-HTTP LAN address cannot sign in on the web (the app can).
- **State changes** pass `http.CrossOriginProtection`, the CSRF defence for the
  forms and the API alike. The strict CSP is unchanged: no inline styles or
  scripts, and a test checks the account and admin pages for them.
- **Sync** is `POST /api/sync` with a cursor, tombstones and two record kinds,
  `check` (one checked line) and `ink` (the quantized strokes of an attempt;
  the web does not write these yet, but stores and syncs them). The contract,
  record shapes and the record-id rule are in [`docs/sync-api.md`](docs/sync-api.md);
  the iPad app's brief is [`docs/ipad-sync-handoff.md`](docs/ipad-sync-handoff.md).
  The web client (`web/sync.ts`) syncs on page load, when the tab becomes
  visible or the network returns, a few seconds after a check, and from the
  Sync card on Progress. The first time it sees a signed-in browser it offers to
  upload the checks already on the device. Signed out, nothing changes. Requests
  are capped (about 4 MB of JSON and 500 records pushed, at most 1000 records
  and 1000 deletions accepted; a pull page holds at most 1000 changes and 4 MB
  of data), and the client halves a batch the server refuses as too large.

**Deploying.** `compose.yaml` runs the one container with a named `data` volume
at `/data` (`DB_PATH=/data/handwriting.db`; a daily `VACUUM INTO` backup lands
in `/data/backups`, the last seven kept) and a 512 MB memory limit. Two
environment variables depend on the proxy: `HSTS=1` once the site is served
over https (never before: it pins the browser), and `CLIENT_IP_HEADER` so the
per-IP sign-in limit sees visitors, not the proxy. Prefer a single-value header
the proxy overwrites, such as `CF-Connecting-IP` (Cloudflare) or `X-Real-IP`.
`X-Forwarded-For` also works, but only its rightmost entry (the one your own
proxy appended) is trusted, because the client controls everything before it.
Only set the variable when every request arrives through that proxy, or anyone
can pick their own rate-limit bucket. Left empty it uses the connection's
address. The distroless image has no shell, so the healthcheck is the binary
probing itself (`/calligraphy -healthcheck`). It is one instance on one SQLite
file: a second instance is the point at which this needs Postgres. **Backups**
are `/data/backups/handwriting-YYYYMMDD.db` (UTC date), one per day, taken at
startup and then daily by `sqlitekit.Backups`, the newest seven kept. Each is a
`VACUUM INTO` copy: a complete, consistent database, made while the app
writes. They sit on the same data volume, so they cover a bad migration or a
mistaken delete but **do not survive losing the disk**; the off-box copy of
`/data/backups` is a decision still open. The SQLite driver is
pure Go (`modernc.org/sqlite`), so the build needs no cgo and the Dockerfile
builds a static binary with no C toolchain; because the TypeScript bundles are
checked in and `make check` fails when they are stale, it has no Deno stage.
The database runs in WAL mode, so while the app is up it is three files
(`handwriting.db`, `-wal`, `-shm`): never copy just the `.db` of a running app
(`cp`, `docker cp`, a volume tar can miss committed data or capture a torn
state). Use the daily backups, or stop the app first and copy all three files.
A fourth file, `handwriting.db.migrate-lock`, sits beside the database: it serialises
migrations between processes that open it at the same time (it is released when a process
exits). It is created on first open and never deleted, so leave it alone while the app
runs. Run migrating commands as the image user (e.g. through `kamal app exec`), never as
root: every open takes `handwriting.db.migrate-lock` read-write, so a root-created (0600)
lock file stops the app starting on its next restart, and makes the status command and the
cmd tools fail with permission denied.

### Production: Kamal on the Docker host

Production is deployed with [Kamal](https://kamal-deploy.org) (`config/deploy.yml`).
The host (`home-docker`) runs kamal-proxy with nothing published, behind one
shared Cloudflare tunnel; that host-side setup lives in `~/dev/17xande.dev/infra`.
The tunnel's public hostname `handwriting.17xande.dev` has service
`http://kamal-proxy:80`, and kamal-proxy routes by host to the app (port 8080,
health check `/healthz`). Cloudflare terminates TLS, so Kamal runs with
`proxy.ssl: false`. Nothing else can reach the app, which is what makes trusting
`CF-Connecting-IP` safe. The app runs with a 512 MB limit and the existing
`handwriting_data` volume at `/data`.

```sh
make deploy                        # check gate, then kamal deploy (build, push to ghcr.io, swap in)
kamal rollback <version>           # back to an earlier image; `kamal app version` / `kamal app containers` list them
make logs-prod                     # kamal app logs -f
```

`make deploy` refuses uncommitted tracked changes, since Kamal builds from
`HEAD`. Registry login is `gh auth token` (see `.kamal/secrets`). The app has no
secrets of its own.

Operating production (run from this repo; `kamal` as above). Only the
`kamal app logs` form is exercised by `make logs-prod`; the rest are reasoned
from Kamal's and the image's behaviour and **untested**:

```sh
# First admin, or a lockout reset. --reuse execs in the running container.
# Without it Kamal starts a fresh container, and the image's ENTRYPOINT
# (/calligraphy) would be prefixed to the command, starting a second server.
kamal app exec -i --reuse "/calligraphy -add-admin you@example.com"
kamal app exec -i --reuse "/calligraphy -reset-password you@example.com"

# Logs
kamal app logs -f            # or: kamal app logs --since 1h

# Backups: the daily VACUUM INTO copies are in /data/backups (last seven kept).
# They are complete, consistent databases, safe to copy. Do NOT copy the live
# /data/handwriting.db while the app runs: it is WAL (three files while
# running), so a plain copy can miss committed data. For a fresh copy of a
# running app wait for the next daily backup, or stop the app first (see
# Restore). The image has no shell, tar or sqlite3, so read the volume from a
# throwaway container on the host (ssh ubuntu@home-docker):
docker run --rm -v handwriting_data:/data -v "$PWD":/out busybox cp /data/backups/<file>.db /out/
docker run --rm -v handwriting_data:/data busybox ls -l /data/backups

# Restore: stop the app, put the copy in place, start it again. The files must
# end up owned by uid 65532 (the nonroot user the app runs as). `kamal` lines
# run from this repo on your laptop; the `docker run` line runs ON home-docker
# (ssh ubuntu@home-docker), where the volume lives. It overwrites the live
# database, so stop the app and copy the CURRENT one out first (the pre-restore
# copy, with its -wal/-shm files).
kamal app stop
docker run --rm -v handwriting_data:/data -v "$PWD":/out busybox \
  sh -c 'cp /data/handwriting.db* /out/'   # ON home-docker: the pre-restore copy
docker run --rm -v handwriting_data:/data -v "$PWD":/in busybox \
  sh -c 'cp /in/<file>.db /data/handwriting.db && rm -f /data/handwriting.db-wal /data/handwriting.db-shm && chown 65532:65532 /data/handwriting.db'
kamal app boot
```

Cloudflare settings for the hostname:

- The tunnel's public hostname points at `http://kamal-proxy:80`. Do not set
  an `httpHostHeader` override: the cross-origin check compares `Origin` with
  the request's `Host`, so rewriting `Host` breaks every sign-in and sync POST.
- Turn off Email Obfuscation and Rocket Loader for this hostname (a
  Configuration Rule, or Speed and Scrape Shield). Both rewrite served pages
  and scripts, which the strict CSP (`script-src 'self'`) then refuses, and
  the account pages contain email addresses.
- Optional, as a second layer in front of the app's own limits: a Cloudflare
  rate-limiting rule on `POST /account/login` and `POST /api/token` (for
  example 10 requests per minute per IP, then block for a minute).

## Stroke order and direction

Besides shape, a check judges whether each letter's strokes were made in the model's order and
direction (the iPad app's M10; its strokes contract is authoritative, `web/stroke-order.ts` the port,
pinned by the golden vectors in `testdata/strokes`). The result is the **Order & direction** bar in
Details, `scores.order` and `metrics2.order` in the check record, up to two notes, and flags on the
letter chips. Built-in models for Edu SA Beginner and Briem Hand Unjoined are served from
`/static/strokes/` (derived from OFL fonts; see `strokes/NOTICE`); a font without one is judged for
shape only. **Show strokes** draws numbered start dots and arrows on the model and a Play button
(tap a letter for one letter); **Trace first** shows the strokes still to write.

The **Stroke models** page (`/strokes`) lists each font's coverage and lets you write your own
strokes per character: drawn with the pen or mouse, snapped to the glyph's centreline, undo, reverse,
reorder, save, export and import. Definitions are kept in IndexedDB as `strokes` records, in the
iPad's JSON shape, so they sync both ways and are used first, then the built-in model. Not ported:
suggestions from similar fonts (see the TODO in `web/strokes.ts`).

The matching follows the approach of [Hanzi Writer](https://github.com/chanind/hanzi-writer)
(MIT licence, Copyright David Chanin). No code was copied from it.

## Security

- The CSP has no `unsafe-inline`. Templates carry no `style=` attributes, no
  `on*=` handlers and no inline scripts, and a test checks every served page
  for them. The font families reach CSS through a generated, content-hashed
  `font.css`, not inline styles.
- Accounts, sessions, rate limits and the cross-origin check are described under
  "Accounts and sync".
- `/static` serves only extensions in an explicit allow-list, at
  content-hashed URLs cached as immutable. An unhashed or stale URL must
  revalidate.

## Decisions still open

| Decision | Candidates | What would force it |
|---|---|---|
| Sharing a custom exercise | A server-stored exercise behind an unguessable id, perhaps with an owner | Wanting to send an exercise to someone. Putting the text in the URL was rejected (see "Your own text"). |
| Timed writing | A one-minute mode recording letters per minute in Progress, after Getty-Dubay's *Write Now* | Wanting to build speed once the forms are settled |
| Judging stroke order and direction | Comparing against hand-authored stroke paths per letter | Wanting feedback on how letters are made, not just their shape |
| Off-box backups of the SQLite file | Copy `/data/backups` elsewhere (rsync, restic, the Proxmox backup of the volume) | Wanting history to survive losing the Docker host. Accounts and sync are done (see "Accounts and sync"). |
| A second server instance | Postgres instead of the SQLite file | Running two instances or rolling deploys with overlap |
| Fonts from outside Google | Self-hosted or other font services | Wanting a font Google doesn't have. The picker is Google-only so the CSP stays at two fixed origins. |
| Stroke-order models | Hand-authored SVG paths per letter | Wanting animated stroke order or direction arrows, which a font can't give |
| Getty-Dubay proportions | Fixed guide ratios instead of the font's measured ones | A model font whose proportions stray from the hand |
| htmx / Web Awesome | Add when a server round-trip or a complex control needs them | Still not needed: the account and admin pages are plain post-redirect-get forms. |
| Dark mode | Ink and guide colours for a dark page | Requests for it. The page imitates paper, so it's light only for now. |

## Licence

The app's code is under the MIT licence (`LICENSE`). The bundled Briem Hand
fonts are under the SIL Open Font License 1.1 (`third_party/briem-hand/OFL.txt`);
the fonts loaded from Google Fonts are under their own licences, also OFL.
The GitHub mark in the header is from [Octicons](https://github.com/primer/octicons)
(MIT), and the charts use [Chart.js](https://www.chartjs.org/) (MIT).
