# The TypeScript bundle is checked in, so the image needs only Go. Templates,
# CSS and app.js are go:embed'ed: the runtime image is one binary, no shell.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/calligraphy .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/calligraphy /calligraphy
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/calligraphy"]
