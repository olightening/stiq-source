package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestWebsocketCompressionTriState covers why the field is a *bool: an absent key and an explicit
// false must be distinguishable, or the operator's kill switch is indistinguishable from silence.
func TestWebsocketCompressionTriState(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"absent key takes the shipped default", `{}`, DefaultWebsocketCompression},
		{"explicit true", `{"websocket_compression":true}`, true},
		{"explicit false is the kill switch", `{"websocket_compression":false}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var c Config
			if err := json.Unmarshal([]byte(tc.raw), &c); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if got := c.WebsocketCompressionEnabled(); got != tc.want {
				t.Fatalf("WebsocketCompressionEnabled()=%v, want %v", got, tc.want)
			}
		})
	}
}

// TestWebsocketCompressionSurvivesLoad guards the field against the merge-style rewrites the
// installer performs on config.json: an operator who turned compression off must not have it turned
// back on by a key they never touched.
func TestWebsocketCompressionSurvivesLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	body := `{"listen":"127.0.0.1:3334","issuer_public_keys":["x"],"websocket_compression":false}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.WebsocketCompressionEnabled() {
		t.Fatal("websocket_compression:false did not survive Load")
	}
}

// TestEffectiveWeightCaps pins the substitution the NIP-11 document depends on. Load performs it for
// a config read off disk; a Config built directly (tests, embedders) must report the same enforced
// numbers, or the advertised caps differ from the enforced ones depending on how the relay was built.
func TestEffectiveWeightCaps(t *testing.T) {
	var zero Config
	if got := zero.EffectiveMaxEventBytes(); got != DefaultMaxEventBytes {
		t.Errorf("EffectiveMaxEventBytes() on an unset config = %d, want %d", got, DefaultMaxEventBytes)
	}
	if got := zero.EffectiveMaxTagsPerEvent(); got != DefaultMaxTagsPerEvent {
		t.Errorf("EffectiveMaxTagsPerEvent() on an unset config = %d, want %d", got, DefaultMaxTagsPerEvent)
	}
	set := Config{MaxEventBytes: 524288, MaxTagsPerEvent: 40}
	if got := set.EffectiveMaxEventBytes(); got != 524288 {
		t.Errorf("EffectiveMaxEventBytes() = %d, want 524288", got)
	}
	if got := set.EffectiveMaxTagsPerEvent(); got != 40 {
		t.Errorf("EffectiveMaxTagsPerEvent() = %d, want 40", got)
	}

	// Load's own substitution must agree with the helpers, since both feed the same NIP-11 fields.
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"issuer_public_keys":["x"]}`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.MaxEventBytes != loaded.EffectiveMaxEventBytes() {
		t.Errorf("Load substituted %d but EffectiveMaxEventBytes() reports %d",
			loaded.MaxEventBytes, loaded.EffectiveMaxEventBytes())
	}
	if loaded.MaxTagsPerEvent != loaded.EffectiveMaxTagsPerEvent() {
		t.Errorf("Load substituted %d but EffectiveMaxTagsPerEvent() reports %d",
			loaded.MaxTagsPerEvent, loaded.EffectiveMaxTagsPerEvent())
	}
}
