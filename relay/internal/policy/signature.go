// Package policy implements the relay's event-admission rules (khatru RejectEvent hooks),
// applied BEFORE storage. The relay is a "dumb" broker: it verifies signatures and
// membership, then stores text (PLAN.md §3.1).
package policy

import (
	"context"

	"github.com/nbd-wtf/go-nostr"
)

// RequireValidSignature rejects events with a missing or forged signature. Defense in
// depth, and a prerequisite for membership binding: it proves the event's pubkey really
// controls the signing key before that pubkey is bound to a credential.
func RequireValidSignature(ctx context.Context, event *nostr.Event) (reject bool, msg string) {
	ok, err := event.CheckSignature()
	if err != nil || !ok {
		return true, "invalid: signature verification failed"
	}
	return false, ""
}
