package policy

import (
	"context"
	"strings"
	"testing"

	"github.com/nbd-wtf/go-nostr"
)

func TestWeightGateRejectsOversized(t *testing.T) {
	w := NewWeightGate(100, 0)
	if reject, _ := w.RejectEvent(context.Background(), &nostr.Event{Content: "hi"}); reject {
		t.Fatal("a small event should pass the size cap")
	}
	big := &nostr.Event{Content: strings.Repeat("x", 200)}
	if reject, msg := w.RejectEvent(context.Background(), big); !reject {
		t.Fatalf("an oversized event should be rejected, got admit (%s)", msg)
	}
}

func TestWeightGateRejectsTooManyTags(t *testing.T) {
	w := NewWeightGate(0, 3)
	tags := nostr.Tags{}
	for i := 0; i < 5; i++ {
		tags = append(tags, nostr.Tag{"t", "x"})
	}
	if reject, _ := w.RejectEvent(context.Background(), &nostr.Event{Tags: tags}); !reject {
		t.Fatal("an over-tagged event should be rejected")
	}
	// At the limit is fine.
	ok := nostr.Tags{{"t", "a"}, {"t", "b"}, {"t", "c"}}
	if reject, _ := w.RejectEvent(context.Background(), &nostr.Event{Tags: ok}); reject {
		t.Fatal("an event at the tag limit should pass")
	}
}

func TestWeightGateZeroDisables(t *testing.T) {
	w := NewWeightGate(0, 0)
	big := &nostr.Event{Content: strings.Repeat("x", 10000), Tags: nostr.Tags{{"t", "x"}}}
	if reject, _ := w.RejectEvent(context.Background(), big); reject {
		t.Fatal("zero bounds should disable the weight gate")
	}
}
