package policy

import (
	"context"
	"testing"

	"github.com/nbd-wtf/go-nostr"
)

// TestRequireScopedCount: NIP-45 COUNT must be scoped; a fully-unscoped count (an enumeration
// oracle + full-index scan) is rejected regardless of kind, while an author/id/tag-scoped count
// passes (finding #39).
func TestRequireScopedCount(t *testing.T) {
	reject := func(f nostr.Filter) bool {
		r, _ := RequireScopedCount(context.Background(), f)
		return r
	}
	// Unscoped counts (member count via kind-0, total notes via kind-1) must be rejected.
	if !reject(nostr.Filter{Kinds: []int{0}}) {
		t.Fatal("unscoped COUNT of kind-0 (member count) must be rejected")
	}
	if !reject(nostr.Filter{Kinds: []int{1}}) {
		t.Fatal("unscoped COUNT of kind-1 (total notes) must be rejected")
	}
	// Scoped counts (a real use: tallying reactions/comments on a specific post) must pass.
	if reject(nostr.Filter{Kinds: []int{7}, Tags: nostr.TagMap{"e": []string{"postid"}}}) {
		t.Fatal("a #e-scoped COUNT must be allowed")
	}
	if reject(nostr.Filter{Kinds: []int{1}, Authors: []string{"npub"}}) {
		t.Fatal("an author-scoped COUNT must be allowed")
	}
	if reject(nostr.Filter{IDs: []string{"eventid"}}) {
		t.Fatal("an id-scoped COUNT must be allowed")
	}
}
