package policy

import (
	"context"

	"github.com/nbd-wtf/go-nostr"
)

// RejectBindingReads is a khatru RejectFilter AND RejectCountFilter hook: kind-9011 membership
// bindings are WRITE-ONLY at the wire. No conforming client ever subscribes to them (the member
// roll ships via the organizer's encrypted stiq:member-roll doc, built from the relay's own
// membership file — never from these events), and serving them would hand any connection an
// enumeration of the bound-npub set (§3.8's discovery guards never covered 9011) or, scoped by
// author, an is-this-npub-a-member oracle. Reject even scoped reads: there is no legitimate reader.
//
// A kind-LESS filter passes this hook (it names nothing); the relayapp result-suppression wrapper
// (suppressBindingReads) drops any binding an unkinded query would otherwise sweep up, so the two
// layers together make the kind unreadable without breaking ordinary author reads.
func RejectBindingReads(_ context.Context, filter nostr.Filter) (reject bool, msg string) {
	for _, k := range filter.Kinds {
		if k == KindMembershipBinding {
			return true, "blocked: membership bindings are not readable"
		}
	}
	return false, ""
}
