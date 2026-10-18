package main

import (
	"fmt"
	"net"
	"net/http"
	"time"
)

// The runtime image is distroless: no shell, no wget, no curl. A container
// healthcheck therefore cannot shell out to probe the server, so the binary
// probes itself (`calligraphy -healthcheck`). A reverse proxy that routes only
// to healthy containers (Traefik's Docker provider does) would otherwise find
// a healthcheck that can never run and leave the site with no route at all.

// healthcheckURL turns a listen address into the URL to probe. An address
// with no host (":8080", the default) listens on every interface, so the
// probe goes to loopback.
func healthcheckURL(addr string) (string, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", fmt.Errorf("healthcheck: bad listen address %q: %w", addr, err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/healthz", nil
}

// probe reports whether the server at addr answers /healthz with 200.
func probe(addr string, timeout time.Duration) error {
	url, err := healthcheckURL(addr)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("healthcheck: %w", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck: %s returned %d", url, resp.StatusCode)
	}
	return nil
}
