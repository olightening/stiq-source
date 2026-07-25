package membership

import (
	"errors"
	"path/filepath"
	"testing"
)

// TestBadgerBindRecoverableAfterSaveFailure: an ordinary save() failure AFTER the durable spend must
// NOT permanently burn the binding credential. Because Bind binds the spent-record to the owning
// pubkey (spendForEvent), the SAME device can complete the bind on retry, while a DIFFERENT device
// presenting the same credential is still rejected — double-spend protection is unchanged. (finding R2)
func TestBadgerBindRecoverableAfterSaveFailure(t *testing.T) {
	dir := t.TempDir()
	jsonPath := filepath.Join(dir, "membership.json")
	spentDir := filepath.Join(dir, "spent")
	s, err := LoadMemStoreWithBadgerSpent(jsonPath, spentDir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	defer s.Close()

	// Force the JSON save() to fail by pointing the path into a non-existent directory: the badger
	// spend still lands durably, but writeFileAtomic can't create its temp file, so save() errors —
	// exactly the "spent but bound-state not persisted" window the fix must make recoverable.
	s.path = filepath.Join(dir, "does-not-exist", "membership.json")
	if err := s.Bind("credtok", "npubA"); err == nil {
		t.Fatal("expected the forced save() failure to surface an error")
	}

	// The credential must NOT be burned: the SAME device completes the bind once persistence works.
	s.path = jsonPath
	if err := s.Bind("credtok", "npubA"); err != nil {
		t.Fatalf("same-device retry must recover the binding, got %v", err)
	}
	if !s.IsBound("npubA") {
		t.Fatal("npubA must be bound after recovery")
	}

	// A DIFFERENT device presenting the same credential is still rejected (double-spend protection).
	if err := s.Bind("credtok", "npubB"); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("a different device reusing the credential must get ErrTokenSpent, got %v", err)
	}
	if s.IsBound("npubB") {
		t.Fatal("npubB must not be bound")
	}
}
