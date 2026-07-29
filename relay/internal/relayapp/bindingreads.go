package relayapp

import (
	"context"

	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/policy"
)

// suppressBindingReads wraps a QueryEvents backend so a CLIENT-facing read never surfaces a
// kind-9011 membership binding, closing the kind-less-filter path around policy.RejectBindingReads
// (an unkinded, author-scoped REQ passes every filter hook yet would otherwise sweep the author's
// stored binding into the response). Internal calls pass through unchanged: khatru's deletion
// target lookups (a member self-deleting their own binding event still works — that removes only
// the stored event, never the membership store's bound state), NIP-40 expiration sweeps, and the
// startup config replay all need the raw view. Registered OUTSIDE the deletion-query guard so the
// internal-call passthrough delegates straight to it.
func suppressBindingReads(query queryFunc) queryFunc {
	return func(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
		if khatru.IsInternalCall(ctx) {
			return query(ctx, filter)
		}
		in, err := query(ctx, filter)
		if err != nil {
			return nil, err
		}
		out := make(chan *nostr.Event)
		go func() {
			defer close(out)
			for ev := range in {
				if ev != nil && ev.Kind == policy.KindMembershipBinding {
					continue
				}
				select {
				case out <- ev:
				case <-ctx.Done():
					// Drain the source so the backend's producer goroutine can finish and release
					// its resources even when the consumer went away mid-stream.
					for range in {
					}
					return
				}
			}
		}()
		return out, nil
	}
}
