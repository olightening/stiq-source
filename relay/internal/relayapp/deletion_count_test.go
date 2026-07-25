package relayapp

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nbd-wtf/go-nostr"
)

// TestSelfDeletionAllowedCrossAuthorRejected: the OverwriteDeletionOutcome hook enforces NIP-09
// self-deletion semantics. A member may delete their OWN events (the path AppRuntime.deleteChannel
// relies on for owner channel deletion — M1), but a kind-5 must never delete ANOTHER author's event
// (the finding #37 moderation-bypass concern). The kind-5 tombstone itself is never stored (kind 5 is
// off the allow-list), so we assert the deletion EFFECT on the target, not the kind-5's OK status.
func TestSelfDeletionAllowedCrossAuthorRejected(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayPersistent(t, issuerPEM)

	aliceSK, alicePK := bindMember(t, ws, issuerSK)
	bobSK, _ := bindMember(t, ws, issuerSK)

	// Alice publishes two of her own events (bound-npub path): a profile and a NIP-53 channel.
	profile := signedTags(t, aliceSK, 0, nostr.Tags{})
	if ok, msg := publish(t, ws, profile); !ok {
		t.Fatalf("profile publish should succeed: %q", msg)
	}
	channel := signedTags(t, aliceSK, 30311, nostr.Tags{{"d", "chan-1"}, {"title", "Room"}})
	if ok, msg := publish(t, ws, channel); !ok {
		t.Fatalf("channel publish should succeed: %q", msg)
	}

	// Bob CANNOT delete Alice's profile: the cross-author kind-5 is refused and the target survives.
	bobDel := signedTags(t, bobSK, 5, nostr.Tags{{"e", profile.ID}})
	publish(t, ws, bobDel) // the kind-5 is never stored regardless; assert the target's survival
	if ids := collect(t, ws, map[string]any{"kinds": []int{0}, "authors": []string{alicePK}}); !contains(ids, profile.ID) {
		t.Fatal("cross-author deletion must NOT delete the target (finding #37 moderation-bypass)")
	}

	// Alice CAN delete her own profile via a plain 'e'-tag kind-5 (NIP-09 self-deletion).
	selfDel := signedTags(t, aliceSK, 5, nostr.Tags{{"e", profile.ID}})
	publish(t, ws, selfDel)
	if ids := collect(t, ws, map[string]any{"kinds": []int{0}, "authors": []string{alicePK}}); contains(ids, profile.ID) {
		t.Fatal("self-deletion of one's own event should remove it")
	}

	// Alice CAN delete her own channel via the addressable-coordinate path AppRuntime.deleteChannel
	// emits: a kind-5 with an 'a' tag for the 30311 coordinate plus a 'k' tag. (M1 regression)
	coord := "30311:" + alicePK + ":chan-1"
	chanDel := signedTags(t, aliceSK, 5, nostr.Tags{{"a", coord}, {"k", "30311"}})
	publish(t, ws, chanDel)
	if ids := collect(t, ws, map[string]any{"kinds": []int{30311}, "authors": []string{alicePK}}); contains(ids, channel.ID) {
		t.Fatal("channel owner must be able to delete their own 30311 (M1 regression)")
	}
}

// countRejected sends a NIP-45 COUNT and reports whether the relay rejected it (a NOTICE arrives
// before any COUNT frame when a RejectCountFilter fires).
func countRejected(t *testing.T, wsURL string, filter map[string]any) bool {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()

	payload, err := json.Marshal([]any{"COUNT", "c", filter})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var frame []json.RawMessage
		if err := json.Unmarshal(data, &frame); err != nil || len(frame) < 1 {
			continue
		}
		var typ string
		_ = json.Unmarshal(frame[0], &typ)
		switch typ {
		case "NOTICE", "CLOSED":
			return true
		case "COUNT":
			return false
		}
	}
}

// TestCountScopingEnforced: NIP-45 COUNT is subject to the same anti-enumeration scoping as REQ, so
// an unscoped count (member-count / total-notes enumeration oracle + full-index scan) is rejected
// while a scoped count is allowed. (finding #39)
func TestCountScopingEnforced(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayPersistent(t, issuerPEM)

	if !countRejected(t, ws, map[string]any{"kinds": []int{0}}) {
		t.Fatal("unscoped COUNT of kind-0 (member count) must be rejected")
	}
	if !countRejected(t, ws, map[string]any{"kinds": []int{1}}) {
		t.Fatal("unscoped COUNT of kind-1 (total notes) must be rejected")
	}
	validAuthor := strings.Repeat("a1", 32) // valid 64-hex pubkey shape (no events, count 0)
	if countRejected(t, ws, map[string]any{"kinds": []int{1}, "authors": []string{validAuthor}}) {
		t.Fatal("an author-scoped COUNT must be allowed")
	}
}
