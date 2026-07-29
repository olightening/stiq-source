package config

import (
	"os"
	"path/filepath"
	"testing"
)

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

// An explicit allowed_kinds fully REPLACES DefaultAllowedKinds — deliberate, but it means every kind
// the app gains needs a manual edit on every deployment that ever wrote one, and forgetting shows up
// as a feature that silently does nothing on that relay alone. The 07-15 audit recorded it as a gap,
// it was re-tripped and re-documented the same day it was re-audited, and it is still structurally
// unchanged. It stays unchanged (merging would silently re-admit a kind an operator removed on
// purpose) — but startup now names what is missing, so the list can never be silently narrowed.
func TestMissingDefaultKinds(t *testing.T) {
	t.Run("defaulted config reports nothing", func(t *testing.T) {
		c := Config{AllowedKinds: DefaultAllowedKinds} // AllowedKindsExplicit false = Load substituted
		if got := MissingDefaultKinds(c); got != nil {
			t.Errorf("MissingDefaultKinds = %v, want nil (nothing was overridden)", got)
		}
	})

	t.Run("explicit list covering every default reports nothing", func(t *testing.T) {
		c := Config{AllowedKinds: append([]int{999_999}, DefaultAllowedKinds...), AllowedKindsExplicit: true}
		if got := MissingDefaultKinds(c); got != nil {
			t.Errorf("MissingDefaultKinds = %v, want nil (a superset omits nothing)", got)
		}
	})

	t.Run("explicit list names exactly what it omits, in default order", func(t *testing.T) {
		// The realistic shape: a config written before 1984/30078 existed. Both are load-bearing —
		// without 1984 no report or moderator action can be published at all, and without 30078 the
		// organizer cannot publish the moderator roster, so moderation silently does not exist.
		var kinds []int
		for _, k := range DefaultAllowedKinds {
			if k != 1984 && k != 30078 {
				kinds = append(kinds, k)
			}
		}
		got := MissingDefaultKinds(Config{AllowedKinds: kinds, AllowedKindsExplicit: true})
		want := []int{1984, 30078}
		if len(got) != len(want) {
			t.Fatalf("MissingDefaultKinds = %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("MissingDefaultKinds = %v, want %v (default order)", got, want)
			}
		}
	})

	t.Run("an empty explicit list reports every default", func(t *testing.T) {
		got := MissingDefaultKinds(Config{AllowedKinds: []int{}, AllowedKindsExplicit: true})
		if len(got) != len(DefaultAllowedKinds) {
			t.Errorf("MissingDefaultKinds returned %d kinds, want all %d", len(got), len(DefaultAllowedKinds))
		}
	})
}

// Load derives AllowedKindsExplicit, which is what makes the warning above possible: after Load,
// AllowedKinds is populated either way, so the substitution is otherwise indistinguishable.
func TestLoadRecordsWhetherAllowedKindsWasExplicit(t *testing.T) {
	write := func(t *testing.T, body string) string {
		t.Helper()
		p := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}

	c, err := Load(write(t, `{"listen":"127.0.0.1:3334"}`))
	if err != nil {
		t.Fatal(err)
	}
	if c.AllowedKindsExplicit {
		t.Error("AllowedKindsExplicit = true for a config that never mentions allowed_kinds")
	}
	if len(c.AllowedKinds) != len(DefaultAllowedKinds) {
		t.Error("an absent allowed_kinds should be substituted with DefaultAllowedKinds")
	}

	c, err = Load(write(t, `{"listen":"127.0.0.1:3334","allowed_kinds":[1,7]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !c.AllowedKindsExplicit {
		t.Error("AllowedKindsExplicit = false for a config that sets allowed_kinds")
	}
	if len(c.AllowedKinds) != 2 {
		t.Errorf("AllowedKinds = %v, want the explicit list verbatim (replace, not merge)", c.AllowedKinds)
	}
}
