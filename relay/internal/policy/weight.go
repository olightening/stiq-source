package policy

import (
	"context"
	"fmt"

	"github.com/nbd-wtf/go-nostr"
)

// WeightGate enforces content-neutral size limits: a maximum serialized event size and a
// maximum tag count. These bound relay storage and parser cost regardless of who authored the
// event — no identity is consulted — so they apply uniformly to blind posts, bound-member
// events, and organizer config. It is the "spam/weight" half of the blind door (PLAN.md §3.4):
// pre-content admission that needs no npub, and thus the ONLY thing the relay checks that could
// ever depend on the event body. It runs early (right after the signature check) so an oversized
// event is shed before the more expensive RSA token verification.
type WeightGate struct {
	maxBytes int // maximum approximate serialized event size; 0 disables the check
	maxTags  int // maximum number of tags; 0 disables the check
}

// NewWeightGate builds a weight gate. Zero for either bound disables that particular check.
func NewWeightGate(maxBytes, maxTags int) *WeightGate {
	return &WeightGate{maxBytes: maxBytes, maxTags: maxTags}
}

// RejectEvent rejects an event that exceeds the configured tag-count or size caps.
func (w *WeightGate) RejectEvent(_ context.Context, event *nostr.Event) (reject bool, msg string) {
	if w.maxTags > 0 && len(event.Tags) > w.maxTags {
		return true, reason(codeTooManyTags, fmt.Sprintf("blocked: too many tags (%d, max %d)", len(event.Tags), w.maxTags))
	}
	if w.maxBytes > 0 {
		if size := eventSize(event); size > w.maxBytes {
			return true, reason(codeEventTooLarge, fmt.Sprintf("blocked: event too large (%d bytes, max %d)", size, w.maxBytes))
		}
	}
	return false, ""
}

// eventSize approximates the stored size of an event: its content plus every tag string (with a
// byte per element for the delimiter). This bounds the dominant contributors to on-disk size
// without a full JSON re-serialization on every admission.
func eventSize(event *nostr.Event) int {
	n := len(event.Content)
	for _, tag := range event.Tags {
		for _, s := range tag {
			n += len(s) + 1
		}
	}
	return n
}

// chargeableSize is eventSize MINUS the per-post anti-spam token tags (stiq_token / stiq_sig /
// stiq_spend). It is the base for weight-priced token cost (TokenCost). Excluding the token tags
// avoids the circularity trap: if the tokens counted toward the price, attaching more of them would
// raise the price, which would need more tokens — a fixpoint client and relay could disagree on.
// With them excluded, both sides compute the identical number from content + non-token tags, and
// the tokens ride for free on their own weight. stiq_spend (the P3 holder-bound spend proof) is
// anti-spam machinery exactly like stiq_token/stiq_sig — including it here would create the same
// circularity for multi-token holder-bound posts (crypto red-team mustFix #1: without this, a
// weight-priced multi-token post is rejected codeTokenInsufficient because the relay charges for
// proof bytes the client didn't budget for). stiq_attr IS counted — it is real stored ciphertext.
// The whole event (tokens included) is still separately bounded by maxBytes in RejectEvent, so
// token-tag bloat can never defeat the storage cap. NOTE: len() here is BYTES (Go strings are
// UTF-8), so a client must price by UTF-8 byte length, not UTF-16 code units, to agree (see the
// parity test).
func chargeableSize(event *nostr.Event) int {
	n := len(event.Content)
	for _, tag := range event.Tags {
		if len(tag) >= 1 && (tag[0] == tagToken || tag[0] == tagSig || tag[0] == tagSpend) {
			continue
		}
		for _, s := range tag {
			n += len(s) + 1
		}
	}
	return n
}

// TokenCost is how many per-post anti-spam tokens an event must carry: one token per bytesPerToken
// of chargeable weight, floored at one so no event is ever free (the anti-spam floor). This is the
// unifying primitive — posts, pictures, and audio all ride inline in event.Content, so a bigger
// event (media) costs proportionally more tokens with ZERO content-type awareness on the relay.
//
// bytesPerToken <= 0 DISABLES weight-pricing: every event costs exactly one token, byte-identical to
// the pre-weight-pricing behaviour. That is the default, so the feature ships dark and a community
// opts in only when its clients are known-upgraded (an old client attaches a single token, which a
// bytesPerToken>0 relay would reject for a large event — so flipping this on is a deliberate,
// clients-first migration step, not a silent change).
func TokenCost(event *nostr.Event, bytesPerToken int) int {
	if bytesPerToken <= 0 {
		return 1
	}
	cost := (chargeableSize(event) + bytesPerToken - 1) / bytesPerToken // ceil division
	if cost < 1 {
		return 1
	}
	return cost
}
