package policy

import (
	"context"

	"github.com/nbd-wtf/go-nostr"
)

// Discoverable kinds (PLAN.md §3.8): profile metadata (0) and channels (40/41/42). A
// subscription touching these MUST be scoped (authors / ids / channel #e tag) so the
// channel/profile set cannot be enumerated with a "give me everything" query — discovery
// happens only via a known author's profile.
var discoverableKinds = map[int]struct{}{0: {}, 40: {}, 41: {}, 42: {}}

// RequireScopedDiscovery is a khatru RejectFilter hook.
func RequireScopedDiscovery(ctx context.Context, filter nostr.Filter) (reject bool, msg string) {
	if !touchesDiscoverable(filter) {
		return false, ""
	}
	if isScoped(filter) {
		return false, ""
	}
	return true, "blocked: discovery queries must specify authors, ids, or a channel id"
}

func touchesDiscoverable(filter nostr.Filter) bool {
	for _, kind := range filter.Kinds {
		if _, ok := discoverableKinds[kind]; ok {
			return true
		}
	}
	return false
}

// isScoped is true when the filter targets specific authors, specific event ids, or a
// specific channel via an `#e` tag.
func isScoped(filter nostr.Filter) bool {
	if len(filter.Authors) > 0 || len(filter.IDs) > 0 {
		return true
	}
	return len(filter.Tags["e"]) > 0
}

// RequireScopedCount is a khatru RejectCountFilter hook. NIP-45 COUNT bypasses the REQ MaxLimit cap
// and walks the whole matching index, so an unscoped COUNT is both an O(N) full-scan and an exact
// enumeration oracle (community size via kind-0, total notes via kind-1, etc.) that the REQ scoping
// rules explicitly forbid. Reads are unauthenticated, so every COUNT must name at least one author,
// id, or tag; a fully-unscoped count is rejected regardless of kind. Registered ALONGSIDE
// RequireScopedDiscovery + RequireScopedGroupQuery on RejectCountFilter. (finding #39)
func RequireScopedCount(_ context.Context, filter nostr.Filter) (reject bool, msg string) {
	if len(filter.Authors) > 0 || len(filter.IDs) > 0 || len(filter.Tags) > 0 {
		return false, ""
	}
	return true, "blocked: count queries must specify an author, id, or tag"
}
