package relayapp

import (
	"encoding/base64"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/config"
	"github.com/stiq/relay/internal/membership"
	"github.com/stiq/relay/internal/policy"
)

// blindPostEvent builds a content event as a blind poster would: signed by a FRESH throwaway
// key (never bound) and carrying a per-post token. This is what the client's BlindSigner emits.
func blindPostEvent(t *testing.T, throwawaySK string, cred membership.Credential, content string) *nostr.Event {
	t.Helper()
	ev := &nostr.Event{
		Kind:      1,
		CreatedAt: nostr.Now(),
		Tags: nostr.Tags{
			{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
			{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)},
			{"stiq_attr", "opaque-ciphertext-the-relay-never-reads"},
		},
		Content: content,
	}
	if err := ev.Sign(throwawaySK); err != nil {
		t.Fatalf("Sign blind post: %v", err)
	}
	return ev
}

// newTestRelayWithWeight starts a relay with explicit content-neutral weight caps.
func newTestRelayWithWeight(t *testing.T, issuerPEM string, maxBytes, maxTags int) string {
	t.Helper()
	cfg := config.Config{
		Listen:           "127.0.0.1:0",
		IssuerPublicKeys: []string{issuerPEM},
		AllowedKinds:     config.DefaultAllowedKinds,
		MaxEventBytes:    maxBytes,
		MaxTagsPerEvent:  maxTags,
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

// TestRelayAcceptsBlindPost: a throwaway-signed content event with a valid token is admitted
// end-to-end (signature → weight → token gate → storage) with NO membership binding — the relay
// never learns the author.
func TestRelayAcceptsBlindPost(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)

	throwaway, _ := keypair(t) // fresh key, never bound
	accepted, msg := publish(t, ws, blindPostEvent(t, throwaway, makeCredential(t, issuerSK), "hello, blind"))
	if !accepted {
		t.Fatalf("a valid blind post should be accepted: %q", msg)
	}

	// Each post spends its own token — a second blind post with a fresh token is fine.
	throwaway2, _ := keypair(t)
	if ok, m := publish(t, ws, blindPostEvent(t, throwaway2, makeCredential(t, issuerSK), "again")); !ok {
		t.Fatalf("a second blind post with a fresh token should be accepted: %q", m)
	}
}

// TestRelayRejectsDoubleSpentBlindToken: the same token cannot be spent on two posts, even under
// different throwaway keys (the anti-spam guarantee).
func TestRelayRejectsDoubleSpentBlindToken(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)
	cred := makeCredential(t, issuerSK)

	a, _ := keypair(t)
	if ok, m := publish(t, ws, blindPostEvent(t, a, cred, "first")); !ok {
		t.Fatalf("first spend should succeed: %q", m)
	}
	b, _ := keypair(t)
	accepted, msg := publish(t, ws, blindPostEvent(t, b, cred, "replay"))
	if accepted {
		t.Fatal("a double-spent token must be rejected")
	}
	if !strings.Contains(msg, "already spent") {
		t.Fatalf("expected an already-spent message, got %q", msg)
	}
}

// TestRelayBadgerSpentSetSurvivesRestart: with a DataDir + MembershipFile (the production layout),
// the per-post spent-token set lives in its own badger DB. A token spent before a relay restart must
// still be rejected after it — proving the badger spent-set persists and the New()/closeFn wiring is
// correct end-to-end (not just the in-memory membership store the other integration tests use).
func TestRelayBadgerSpentSetSurvivesRestart(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	dir := t.TempDir()
	cfg := config.Config{
		Listen:           "127.0.0.1:0",
		IssuerPublicKeys: []string{issuerPEM},
		AllowedKinds:     config.DefaultAllowedKinds,
		DataDir:          dir,
		MembershipFile:   filepath.Join(dir, "membership.json"),
	}
	cred := makeCredential(t, issuerSK)

	// Boot 1: spend the token, then shut the relay down cleanly (closes the badger spent DB).
	relay1, close1, _, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	srv1 := httptest.NewServer(relay1)
	tw1, _ := keypair(t)
	if ok, m := publish(t, "ws"+strings.TrimPrefix(srv1.URL, "http"), blindPostEvent(t, tw1, cred, "first")); !ok {
		t.Fatalf("first spend should succeed: %q", m)
	}
	srv1.Close()
	close1()

	// Boot 2: same DataDir + MembershipFile — the spent token must still be rejected.
	relay2, close2, _, err := New(cfg)
	if err != nil {
		t.Fatalf("rebuild relay: %v", err)
	}
	defer close2()
	srv2 := httptest.NewServer(relay2)
	defer srv2.Close()
	tw2, _ := keypair(t)
	accepted, msg := publish(t, "ws"+strings.TrimPrefix(srv2.URL, "http"), blindPostEvent(t, tw2, cred, "replay after restart"))
	if accepted {
		t.Fatal("a token spent before the restart must still be rejected after it (badger persistence)")
	}
	if !strings.Contains(msg, "already spent") {
		t.Fatalf("expected an already-spent message after restart, got %q", msg)
	}
}

// TestRelayRejectsBlindPostFromUntrustedIssuer: a token signed by an issuer the relay doesn't
// trust is refused — a host running on only the published public key can't be tricked.
func TestRelayRejectsBlindPostFromUntrustedIssuer(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t) // relay trusts this issuer
	otherSK, _ := issuerKeyPEM(t)   // but not this one
	ws := newTestRelay(t, issuerPEM)

	tw, _ := keypair(t)
	accepted, msg := publish(t, ws, blindPostEvent(t, tw, makeCredential(t, otherSK), "forged"))
	if accepted {
		t.Fatal("a blind post with an untrusted token must be rejected")
	}
	if !strings.Contains(msg, "invalid blind-post token") {
		t.Fatalf("expected an invalid-token message, got %q", msg)
	}
}

// TestRelayRejectsOversizedEvent: the content-neutral weight gate refuses an event over the byte
// cap (before the token is even checked). Needs no identity — it's a property of the blob.
func TestRelayRejectsOversizedEvent(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayWithWeight(t, issuerPEM, 200, 0)

	tw, _ := keypair(t)
	accepted, msg := publish(t, ws, signed(t, tw, 1, strings.Repeat("x", 500)))
	if accepted {
		t.Fatal("an oversized event must be rejected by the weight gate")
	}
	if !strings.Contains(msg, "too large") {
		t.Fatalf("expected a too-large message, got %q", msg)
	}
}

// TestRelayAcceptsDrawMailboxWithPoW: the epoch-token-draw mailbox kinds (9024/9025) are
// admitted via PoW, like the enrollment mailbox — so a member can draw a wallet over Tor without
// the relay learning who they are.
func TestRelayAcceptsDrawMailboxWithPoW(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayWithPoW(t, issuerPEM, 8)

	for _, kind := range []int{policy.KindDrawRequest, policy.KindDrawResponse} {
		accepted, msg := publish(t, ws, minedPoWEvent(t, kind, 8))
		if !accepted {
			t.Fatalf("draw mailbox kind %d with PoW should be accepted: %q", kind, msg)
		}
	}
}

// TestRelayRejectsTooManyTags: the weight gate refuses an event exceeding the tag-count cap.
func TestRelayRejectsTooManyTags(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayWithWeight(t, issuerPEM, 0, 3)

	tw, _ := keypair(t)
	tags := nostr.Tags{}
	for i := 0; i < 5; i++ {
		tags = append(tags, nostr.Tag{"t", "x"})
	}
	accepted, msg := publish(t, ws, signedTags(t, tw, 1, tags))
	if accepted {
		t.Fatal("an over-tagged event must be rejected by the weight gate")
	}
	if !strings.Contains(msg, "too many tags") {
		t.Fatalf("expected a too-many-tags message, got %q", msg)
	}
}
