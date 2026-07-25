package relayapp

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/config"
	"github.com/stiq/relay/internal/policy"
)

// newTestRelayWithOrganizer builds a relay trusting orgPK as the organizer, so the organizer can
// publish kind-30078 stiq: config over the websocket and the relay enforces it end-to-end.
func newTestRelayWithOrganizer(t *testing.T, issuerPEM, orgPK string) string {
	t.Helper()
	cfg := config.Config{
		Listen:           "127.0.0.1:0",
		IssuerPublicKeys: []string{issuerPEM},
		AllowedKinds:     config.DefaultAllowedKinds,
		OrganizerPubkeys: []string{orgPK},
	}
	relay, closeStore, _, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	srv := httptest.NewServer(relay)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// TestPostRulesEnforcedEndToEnd drives the full chain over a websocket: the organizer publishes
// stiq:post-rules (note ≤ 20 chars), then a bound member's over-length note is rejected by the
// relay while a within-limit note is accepted. Proves the organizer trust gate + live apply +
// checkPostRules are wired into RejectEvent.
func TestPostRulesEnforcedEndToEnd(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	orgSK, orgPK := keypair(t)
	ws := newTestRelayWithOrganizer(t, issuerPEM, orgPK)

	// Organizer publishes the post-rules doc (note max 20 characters).
	rules := signedFull(t, orgSK, policy.KindAppData, `{"note":{"mn":0,"mx":20,"lr":false},"article":{"mn":0,"mx":0,"lr":false}}`,
		nostr.Tags{{"d", "stiq:post-rules"}})
	if ok, msg := publish(t, ws, rules); !ok {
		t.Fatalf("organizer post-rules publish should succeed: %q", msg)
	}

	memberSK, _ := bindMember(t, ws, issuerSK)

	// Within the limit → accepted.
	if ok, msg := publish(t, ws, signed(t, memberSK, 1, strings.Repeat("a", 20))); !ok {
		t.Fatalf("note at max length should be accepted: %q", msg)
	}
	// Over the limit → rejected by the relay.
	ok, msg := publish(t, ws, signed(t, memberSK, 1, strings.Repeat("a", 21)))
	if ok {
		t.Fatal("over-max note must be rejected by the relay")
	}
	if !strings.Contains(msg, "at most 20") {
		t.Fatalf("expected an over-length message, got %q", msg)
	}
}

// TestChannelCreateOrgOnlyEndToEnd proves the stiq:gov channel-create rule is enforced over the
// websocket: with cc="org", a bound member's 9007 is rejected while the organizer's is accepted.
func TestChannelCreateOrgOnlyEndToEnd(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	orgSK, orgPK := keypair(t)
	ws := newTestRelayWithOrganizer(t, issuerPEM, orgPK)

	gov := signedFull(t, orgSK, policy.KindAppData, `{"cc":"org"}`, nostr.Tags{{"d", "stiq:gov"}})
	if ok, msg := publish(t, ws, gov); !ok {
		t.Fatalf("organizer gov publish should succeed: %q", msg)
	}

	memberSK, _ := bindMember(t, ws, issuerSK)

	// Member channel-create rejected.
	if ok, msg := publish(t, ws, signedTags(t, memberSK, 9007, nostr.Tags{{"h", "g-member"}, {"name", "Nope"}, {"open"}})); ok {
		t.Fatal("member 9007 must be rejected when cc=org")
	} else if !strings.Contains(msg, "only the organizer") {
		t.Fatalf("expected an organizer-only message, got %q", msg)
	}

	// Organizer channel-create accepted (organizer is membership-exempt + passes the gov gate).
	if ok, msg := publish(t, ws, signedTags(t, orgSK, 9007, nostr.Tags{{"h", "g-org"}, {"name", "Yes"}, {"open"}})); !ok {
		t.Fatalf("organizer 9007 must be accepted when cc=org: %q", msg)
	}
}
