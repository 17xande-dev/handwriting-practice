// Package config parses every environment variable the server reads into one
// struct, so the rest of the code never calls os.Getenv.
package config

import "os"

// Config is the whole runtime configuration.
type Config struct {
	Addr string
}

// Load reads the environment.
func Load() Config {
	return parse(os.LookupEnv)
}

// parse takes an os.LookupEnv-shaped function so tests can supply their own environment.
func parse(lookupEnv func(string) (string, bool)) Config {
	c := Config{Addr: ":8080"}
	if v, ok := lookupEnv("ADDR"); ok && v != "" {
		c.Addr = v
	}
	return c
}
