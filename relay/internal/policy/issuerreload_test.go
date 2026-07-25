package policy

// T1.1 (finding F5): the relay's SIGHUP hot-reload previously covered ONLY the space-write issuer
// key set (UpdateSpaceWriteIssuers) — binding/posting/picture-write/audio-write were "construction-
// only" despite capabilities.go advertising all of them from the SAME live config. These tests are
// the Membership-level behavioral proof, mirroring spacetokens_test.go's
// TestSpaceWriteIssuersHotReloadEnablesEnforcement, that each domain's new Update*Issuers setter
// actually swaps ENFORCEMENT onto the freshly-loaded key — not just that the method exists — for
// every one of the four sets T1.1 adds: a token/credential signed under the OLD key must stop
// working, and one signed under the NEW key must start working, immediately after the call, with no
// restart. The relayapp-level companion (capabilities_test.go's
// TestCapabilitiesAdvertisedMatchesEnforcedAcrossDomains) separately proves the ADVERTISED NIP-11
// fingerprint tracks the same reload end-to-end through Reloader.Apply.

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"testing"

	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/membership"
)

// bindingEventAs builds a kind-9011 membership-binding event for a CALLER-CHOSEN pubkey carrying
// cred. Unlike blindEvent (blindtoken_test.go), which hardcodes PubKey="throwaway", this lets each
// reload phase bind a FRESH (never-bound) identity so a pass/fail here is never confused with
// handleBinding's idempotent already-bound fast path (store.IsBound short-circuit).
func bindingEventAs(pubkey string, cred membership.Credential) *nostr.Event {
	event := &nostr.Event{
		Kind:    KindMembershipBinding,
		PubKey:  pubkey,
		Content: "",
		Tags: nostr.Tags{
			{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
			{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)},
		},
	}
	event.ID = event.GetID()
	return event
}

// TestBindingIssuersHotReloadRotatesEnforcement (T1.1): SIGHUP hot-reload of the binding-issuer key
// set (UpdateBindingIssuers) must bring a ROTATED key into enforcement immediately, with no restart.
func TestBindingIssuersHotReloadRotatesEnforcement(t *testing.T) {
	generalIssuer := testIssuer(t)
	oldIssuer := testIssuer(t)
	newIssuer := testIssuer(t)
	m := NewMembership([]*rsa.PublicKey{&generalIssuer.PublicKey}, membership.NewMemStore(),
		[]int{KindMembershipBinding}, 8, 0)
	m.SetBindingIssuers([]*rsa.PublicKey{&oldIssuer.PublicKey})

	// Before the reload: the OLD issuer's credential still binds a fresh identity...
	if reject, msg := m.RejectEvent(context.Background(), bindingEventAs("member-old", mintCred(t, oldIssuer))); reject {
		t.Fatalf("old binding issuer must still bind before the reload: %s", msg)
	}
	// ...but a credential from the NEW (not-yet-loaded) issuer does not. Kept unspent (rejected
	// before store.Bind), so it can be retried after the reload below.
	newCredBefore := mintCred(t, newIssuer)
	if reject, _ := m.RejectEvent(context.Background(), bindingEventAs("member-new", newCredBefore)); !reject {
		t.Fatal("new issuer's credential must not bind before its key is hot-reloaded")
	}

	// SIGHUP: rotate the enforced binding-issuer key set onto the new issuer.
	m.UpdateBindingIssuers([]*rsa.PublicKey{&newIssuer.PublicKey})

	// After the reload: retrying the EXACT same (never-spent) new-issuer credential against the
	// SAME fresh identity now binds.
	if reject, msg := m.RejectEvent(context.Background(), bindingEventAs("member-new", newCredBefore)); reject {
		t.Fatalf("new binding issuer's credential must bind once hot-reloaded: %s", msg)
	}
	// And the OLD issuer no longer satisfies a binding for a fresh identity.
	if reject, _ := m.RejectEvent(context.Background(), bindingEventAs("member-old-2", mintCred(t, oldIssuer))); !reject {
		t.Fatal("old binding issuer must stop binding once the key set is hot-reloaded away from it")
	}
}

// TestPostingIssuersHotReloadRotatesEnforcement (T1.1) mirrors the binding test above for the
// per-post blind-token issuer (UpdatePostingIssuers).
func TestPostingIssuersHotReloadRotatesEnforcement(t *testing.T) {
	generalIssuer := testIssuer(t)
	oldIssuer := testIssuer(t)
	newIssuer := testIssuer(t)
	m := NewMembership([]*rsa.PublicKey{&generalIssuer.PublicKey}, membership.NewMemStore(), []int{1}, 8, 0)
	m.SetPostingIssuers([]*rsa.PublicKey{&oldIssuer.PublicKey})

	if reject, msg := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, oldIssuer))); reject {
		t.Fatalf("old posting issuer must still post before the reload: %s", msg)
	}
	if reject, _ := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, newIssuer))); !reject {
		t.Fatal("new posting issuer's token must not post before its key is hot-reloaded")
	}

	m.UpdatePostingIssuers([]*rsa.PublicKey{&newIssuer.PublicKey})

	if reject, msg := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, newIssuer))); reject {
		t.Fatalf("new posting issuer's token must post once hot-reloaded: %s", msg)
	}
	if reject, _ := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, oldIssuer))); !reject {
		t.Fatal("old posting issuer must stop posting once the key set is hot-reloaded away from it")
	}
}

// TestPictureWriteIssuersHotReloadRotatesEnforcement (T1.1) mirrors the posting test above for the
// picture media-write domain (UpdatePictureWriteIssuers).
func TestPictureWriteIssuersHotReloadRotatesEnforcement(t *testing.T) {
	postIssuer := testIssuer(t)
	oldIssuer := testIssuer(t)
	newIssuer := testIssuer(t)
	m := NewMembership([]*rsa.PublicKey{&postIssuer.PublicKey}, membership.NewMemStore(), []int{30351}, 8, 0)
	m.SetPictureWriteIssuers([]*rsa.PublicKey{&oldIssuer.PublicKey})

	if reject, msg := m.RejectEvent(context.Background(), blindEventDom(30351, mintCred(t, oldIssuer), "picture")); reject {
		t.Fatalf("old picture-write issuer must still verify before the reload: %s", msg)
	}
	if reject, _ := m.RejectEvent(context.Background(), blindEventDom(30351, mintCred(t, newIssuer), "picture")); !reject {
		t.Fatal("new picture-write issuer's token must not verify before its key is hot-reloaded")
	}

	m.UpdatePictureWriteIssuers([]*rsa.PublicKey{&newIssuer.PublicKey})

	if reject, msg := m.RejectEvent(context.Background(), blindEventDom(30351, mintCred(t, newIssuer), "picture")); reject {
		t.Fatalf("new picture-write issuer's token must verify once hot-reloaded: %s", msg)
	}
	if reject, _ := m.RejectEvent(context.Background(), blindEventDom(30351, mintCred(t, oldIssuer), "picture")); !reject {
		t.Fatal("old picture-write issuer must stop verifying once the key set is hot-reloaded away from it")
	}
}

// TestAudioWriteIssuersHotReloadRotatesEnforcement (T1.1) mirrors the picture-domain test above for
// audio (UpdateAudioWriteIssuers).
func TestAudioWriteIssuersHotReloadRotatesEnforcement(t *testing.T) {
	postIssuer := testIssuer(t)
	oldIssuer := testIssuer(t)
	newIssuer := testIssuer(t)
	m := NewMembership([]*rsa.PublicKey{&postIssuer.PublicKey}, membership.NewMemStore(), []int{1222}, 8, 0)
	m.SetAudioWriteIssuers([]*rsa.PublicKey{&oldIssuer.PublicKey})

	if reject, msg := m.RejectEvent(context.Background(), blindEventDom(1222, mintCred(t, oldIssuer), "audio")); reject {
		t.Fatalf("old audio-write issuer must still verify before the reload: %s", msg)
	}
	if reject, _ := m.RejectEvent(context.Background(), blindEventDom(1222, mintCred(t, newIssuer), "audio")); !reject {
		t.Fatal("new audio-write issuer's token must not verify before its key is hot-reloaded")
	}

	m.UpdateAudioWriteIssuers([]*rsa.PublicKey{&newIssuer.PublicKey})

	if reject, msg := m.RejectEvent(context.Background(), blindEventDom(1222, mintCred(t, newIssuer), "audio")); reject {
		t.Fatalf("new audio-write issuer's token must verify once hot-reloaded: %s", msg)
	}
	if reject, _ := m.RejectEvent(context.Background(), blindEventDom(1222, mintCred(t, oldIssuer), "audio")); !reject {
		t.Fatal("old audio-write issuer must stop verifying once the key set is hot-reloaded away from it")
	}
}
