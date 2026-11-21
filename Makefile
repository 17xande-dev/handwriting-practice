.PHONY: deploy logs-prod run bundle build test vet fmt check vulncheck vulncheck-install up down fonts-fetch fixtures glyphs

ADDR ?= :8083
DB_PATH ?= $(HOME)/.local/share/handwriting/handwriting.db

## run: bundle the TypeScript and run the server on the host (ADDR=0.0.0.0:8083 to reach it from an iPad; DB_PATH names the SQLite file)
run: bundle
	@mkdir -p $(dir $(DB_PATH))
	ADDR=$(ADDR) DB_PATH=$(DB_PATH) go run .

## bundle: compile web/*.ts into internal/handler/static/*.js (checked in, so go build alone works)
bundle:
	deno task -q bundle

## build: a binary in ./bin (pure Go: modernc SQLite needs no cgo)
build: bundle
	go build -trimpath -ldflags="-s -w" -o bin/calligraphy .

## test: every Go and TypeScript test
test:
	go test -count=1 ./...
	deno task -q test

## fixtures: regenerate testdata/parity (model raster + web scores) with headless Chromium; needs the network for Google fonts
fixtures: bundle
	deno run -A tools/export-fixtures.ts

## glyphs: regenerate testdata/glyphs (single-character model rasters of a-z, 0-9 for the stroke-model pipeline); needs the network
glyphs: bundle
	deno run -A tools/export-glyphs.ts

vet:
	go vet ./...

fmt:
	gofmt -w .
	deno fmt -q

# govulncheck is pinned here rather than in go.mod: it is a build-time tool and
# would drag its dependencies into go.mod. v1.1.x crashes on Go 1.27.
GOVULNCHECK_VERSION ?= v1.9.0

## vulncheck-install: install the pinned govulncheck
vulncheck-install:
	go install golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION)

## vulncheck: fail if a reachable known vulnerability affects the build
vulncheck:
	govulncheck ./...

## check: the gate before every commit. Fails if app.js is stale against web/.
check:
	@test -z "$$(gofmt -l .)" || { gofmt -l .; echo "gofmt needed"; exit 1; }
	deno fmt -q --check
	deno lint -q
	deno task -q check
	go vet ./...
	deno task -q test
	@tmp=$$(mktemp -d) && cp internal/handler/static/*.js $$tmp/ && deno task -q bundle >/dev/null 2>&1; \
	  s=0; for f in $$tmp/*.js; do cmp -s $$f internal/handler/static/$$(basename $$f) || s=1; done; rm -rf $$tmp; \
	  [ $$s -eq 0 ] || { echo "a bundle was stale against web/; rebundled it, commit the result"; exit 1; }
	go test -count=1 -race ./...
	@command -v govulncheck >/dev/null || { echo "govulncheck is missing: make vulncheck-install"; exit 1; }
	govulncheck ./...

# The gem's bin dir is not on PATH everywhere; override with `make deploy KAMAL=/path/to/kamal`.
KAMAL ?= kamal

## deploy: run the check gate, then `kamal deploy` (build, push to ghcr.io, swap in on home-docker)
deploy: check
	@# Kamal builds from HEAD, not the working tree, so refuse edits the checks just ran against.
	@git diff --quiet HEAD -- || { echo "deploy: tracked files have uncommitted changes; commit first so the tag names what runs" >&2; exit 1; }
	$(KAMAL) deploy

## logs-prod: follow the production app's logs
logs-prod:
	$(KAMAL) app logs -f

## up: build and run the local compose stack
up:
	docker compose up -d --build

## down: stop the local compose stack
down:
	docker compose down

BRIEM_ZIP_URL = https://github.com/SorkinType/Briem-Hand/releases/download/v1.004/Briem-Hand-v1.004.zip
BRIEM_ZIP_SHA = e0cf3591c5f9f5bf4ee20d177ec6d6948b9026b3fc7a87c0d68ee6d880b4bc90

## fonts-fetch: re-download the vendored Briem fonts from their pinned release and verify them
fonts-fetch:
	@tmp=$$(mktemp -d) && trap 'rm -rf $$tmp' EXIT && \
	  curl -fsSL -o $$tmp/briem.zip $(BRIEM_ZIP_URL) && \
	  echo "$(BRIEM_ZIP_SHA)  $$tmp/briem.zip" | sha256sum -c --quiet && \
	  unzip -q -j -o $$tmp/briem.zip \
	    Briem-Hand-v1.004/fonts/ttf/BriemHand-Regular.ttf \
	    Briem-Hand-v1.004/fonts/ttf/BriemHandUnjoined-Regular.ttf -d internal/handler/static/fonts && \
	  unzip -q -j -o $$tmp/briem.zip Briem-Hand-v1.004/OFL.txt -d third_party/briem-hand && \
	  cd internal/handler/static/fonts && \
	  echo "bcdfb43ec76937853dc046cb31743658698251036f6cff254351292230ce194c  BriemHand-Regular.ttf" | sha256sum -c --quiet && \
	  echo "664fce9b4abaf6c9c448d3e5ade3ce058ea5ded8d1809e554a0f64a076d87b3f  BriemHandUnjoined-Regular.ttf" | sha256sum -c --quiet && \
	  echo "Briem fonts verified"
