.PHONY: run bundle build test vet fmt check up down fonts-fetch

ADDR ?= :8080

## run: bundle the TypeScript and run the server on the host (ADDR=0.0.0.0:8080 to reach it from an iPad)
run: bundle
	ADDR=$(ADDR) go run .

## bundle: compile web/*.ts into internal/handler/static/app.js (checked in, so go build alone works)
bundle:
	deno task -q bundle

## build: a static binary in ./bin
build: bundle
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/calligraphy .

## test: every Go and TypeScript test
test:
	go test -count=1 ./...
	deno task -q test

vet:
	go vet ./...

fmt:
	gofmt -w .
	deno fmt -q

## check: the gate before every commit. Fails if app.js is stale against web/.
check:
	@test -z "$$(gofmt -l .)" || { gofmt -l .; echo "gofmt needed"; exit 1; }
	deno fmt -q --check
	deno lint -q
	deno task -q check
	go vet ./...
	deno task -q test
	@tmp=$$(mktemp) && cp internal/handler/static/app.js $$tmp && deno task -q bundle >/dev/null 2>&1; \
	  cmp -s internal/handler/static/app.js $$tmp; s=$$?; rm -f $$tmp; \
	  [ $$s -eq 0 ] || { echo "app.js was stale against web/; rebundled it, commit the result"; exit 1; }
	go test -count=1 ./...

up:
	docker compose up -d --build

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
