package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestHealthcheckURL(t *testing.T) {
	for addr, want := range map[string]string{
		":8080":          "http://127.0.0.1:8080/healthz",
		"0.0.0.0:9000":   "http://127.0.0.1:9000/healthz",
		"[::]:8080":      "http://127.0.0.1:8080/healthz",
		"127.0.0.1:8081": "http://127.0.0.1:8081/healthz",
		"[::1]:8080":     "http://[::1]:8080/healthz",
	} {
		got, err := healthcheckURL(addr)
		if err != nil || got != want {
			t.Errorf("healthcheckURL(%q) = %q, %v; want %q", addr, got, err, want)
		}
	}
	if _, err := healthcheckURL("8080"); err == nil {
		t.Error("an address without a port should be refused")
	}
}

func TestProbe(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("ok\n"))
	}))
	defer ok.Close()
	if err := probe(ok.Listener.Addr().String(), time.Second); err != nil {
		t.Errorf("healthy server: %v", err)
	}

	sick := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer sick.Close()
	if err := probe(sick.Listener.Addr().String(), time.Second); err == nil {
		t.Error("a 503 should fail the healthcheck")
	}

	// Nothing listening: grab a free port, then release it.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	if err := probe(addr, time.Second); err == nil {
		t.Error("no server should fail the healthcheck")
	}
}

// The runtime image has no shell or wget, so a compose healthcheck that
// shells out can never pass — and Traefik then drops the container's route
// silently. This pins the healthcheck to the binary's own probe.
func TestComposeHealthcheckUsesBinary(t *testing.T) {
	compose, err := os.ReadFile("compose.yaml")
	if err != nil {
		t.Fatal(err)
	}
	dockerfile, err := os.ReadFile("Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(dockerfile), "distroless") {
		t.Skip("runtime image is no longer distroless; revisit this test")
	}
	// Only the healthcheck's test: line matters; comments may mention tools.
	var testLine string
	for line := range strings.SplitSeq(string(compose), "\n") {
		if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "test:") {
			testLine = trimmed
		}
	}
	if testLine == "" {
		t.Fatal("compose.yaml has no healthcheck test: line")
	}
	if !strings.Contains(testLine, `"/calligraphy", "-healthcheck"`) {
		t.Errorf("healthcheck must run the binary's own probe, got %s", testLine)
	}
	for _, tool := range []string{"wget", "curl", "CMD-SHELL"} {
		if strings.Contains(testLine, tool) {
			t.Errorf("healthcheck uses %s, which the distroless image does not have", tool)
		}
	}
}
