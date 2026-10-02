.PHONY: run bundle build test vet fmt check up down

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
