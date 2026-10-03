package config

import "testing"

func TestAddr(t *testing.T) {
	env := func(m map[string]string) func(string) (string, bool) {
		return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
	}
	if got := parse(env(nil)).Addr; got != ":8080" {
		t.Errorf("default Addr = %q", got)
	}
	if got := parse(env(map[string]string{"ADDR": "0.0.0.0:9000"})).Addr; got != "0.0.0.0:9000" {
		t.Errorf("Addr = %q", got)
	}
}
