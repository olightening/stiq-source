package config

import "testing"

func TestLoopbackOnlyAccepts(t *testing.T) {
	for _, addr := range []string{
		"127.0.0.1:3334",
		"127.0.0.1:0",
		"localhost:3334",
		"[::1]:3334",
	} {
		if err := LoopbackOnly(addr); err != nil {
			t.Errorf("LoopbackOnly(%q) = %v, want nil", addr, err)
		}
	}
}

func TestLoopbackOnlyRejectsPublicBind(t *testing.T) {
	for _, addr := range []string{
		"0.0.0.0:3334",       // all interfaces
		"192.168.1.10:3334",  // LAN
		"203.0.113.5:3334",   // public
		"[::]:3334",          // all interfaces (v6)
	} {
		if err := LoopbackOnly(addr); err == nil {
			t.Errorf("LoopbackOnly(%q) = nil, want error (would expose relay to clearnet)", addr)
		}
	}
}

func TestLoopbackOnlyRejectsMalformed(t *testing.T) {
	for _, addr := range []string{"", "127.0.0.1", "not-an-address"} {
		if err := LoopbackOnly(addr); err == nil {
			t.Errorf("LoopbackOnly(%q) = nil, want error", addr)
		}
	}
}
