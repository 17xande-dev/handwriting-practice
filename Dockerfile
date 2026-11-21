# The TypeScript bundles (internal/handler/static/app.js and progress.js) are
# checked in, and `make check` fails when they are stale against web/, so the
# image needs no Deno stage: it compiles what is in the tree. Templates, CSS,
# the bundles and the fonts are all go:embed'ed, so the runtime image is one
# binary with no shell.
#
# The SQLite driver (modernc.org/sqlite) is pure Go, so the build needs no C
# toolchain and the binary is static, which is what lets the runtime stay
# distroless/static (no libc). The tags use Go's own DNS and user lookups
# instead of libc's.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
      -tags osusergo,netgo \
      -ldflags='-s -w' \
      -o /out/calligraphy .
# The data volume's mount point, owned by distroless's nonroot user. Docker
# copies an image directory's ownership into a fresh named volume, so this is
# what makes the volume writable without running as root.
RUN mkdir -p /out/data

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/calligraphy /calligraphy
COPY --from=build --chown=65532:65532 /out/data /data
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/calligraphy"]
