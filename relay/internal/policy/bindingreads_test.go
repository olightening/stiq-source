package policy

import (
	"context"
	"testing"

	"github.com/nbd-wtf/go-nostr"
)

// Kind-9011 membership bindings are write-only at the wire: no REQ or COUNT may name the kind.
// (Kind-less filters are handled by the relayapp result-suppression wrapper, not this hook, so a
// filter with no kinds passes here.)
func TestRejectBindingReads(t *testing.T) {
	cases := []struct {
		name   string
		filter nostr.Filter
		reject bool
	}{
		{"explicit 9011", nostr.Filter{Kinds: []int{KindMembershipBinding}}, true},
		{"9011 among others", nostr.Filter{Kinds: []int{1, KindMembershipBinding}}, true},
		{"9011 scoped by author still rejected", nostr.Filter{Kinds: []int{KindMembershipBinding}, Authors: []string{"ab"}}, true},
		{"ordinary content kind", nostr.Filter{Kinds: []int{1}}, false},
		{"adjacent mailbox kinds untouched", nostr.Filter{Kinds: []int{9020, 9023, 9024, 9025}}, false},
		{"kind-less filter passes the hook", nostr.Filter{Authors: []string{"ab"}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reject, msg := RejectBindingReads(context.Background(), tc.filter)
			if reject != tc.reject {
				t.Fatalf("reject = %v (msg %q), want %v", reject, msg, tc.reject)
			}
			if tc.reject && msg == "" {
				t.Fatalf("rejection must carry a reason")
			}
		})
	}
}
