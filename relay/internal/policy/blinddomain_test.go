package policy

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/membership"
)

// blindEventDom builds a blind post that CLAIMS a media domain via a stiq_dom tag (asks #3/#4).
func blindEventDom(kind int, cred membership.Credential, dom string) *nostr.Event {
	event := &nostr.Event{
		Kind:    kind,
		PubKey:  "throwaway",
		Content: "hi",
		Tags: nostr.Tags{
			{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
			{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)},
			{"stiq_dom", dom},
		},
	}
	event.ID = event.GetID()
	return event
}

// TestMediaWriteDomainRouting: with a DISTINCT picture-write key set configured, a post claiming
// stiq_dom=picture must carry a token signed under THAT key — a general posting token on a picture
// claim is rejected, and a real picture-write token is admitted.
func TestMediaWriteDomainRouting(t *testing.T) {
	postSk := testIssuer(t)  // general posting/enroll issuer
	picSk := testIssuer(t)   // distinct picture-write issuer
	m := NewMembership([]*rsa.PublicKey{&postSk.PublicKey}, membership.NewMemStore(), []int{1, 30351}, 8, 0)
	m.SetPictureWriteIssuers([]*rsa.PublicKey{&picSk.PublicKey})

	// A picture-domain post carrying a picture-write token → admitted.
	if reject, msg := m.RejectEvent(context.Background(), blindEventDom(30351, mintCred(t, picSk), "picture")); reject {
		t.Fatalf("a picture-write token on a stiq_dom=picture post must be admitted: %s", msg)
	}

	// A picture-domain post carrying a GENERAL posting token → rejected (wrong domain key).
	reject, msg := m.RejectEvent(context.Background(), blindEventDom(30351, mintCred(t, postSk), "picture"))
	if !reject {
		t.Fatal("a general posting token must NOT satisfy a stiq_dom=picture post once picture-write keys are set")
	}
	if !strings.Contains(msg, "invalid blind-post token") {
		t.Fatalf("wrong-domain token rejected for the wrong reason: %s", msg)
	}

	// A post with NO domain claim still verifies against the general posting keys → admitted.
	if reject, msg := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, postSk))); reject {
		t.Fatalf("an unclaimed post must still verify against the general posting keys: %s", msg)
	}
}

// TestMediaWriteDomainFallbackByteIdentical: with NO media write keys configured (today's default),
// the stiq_dom tag is inert — a post claiming picture/audio verifies against the general posting keys
// exactly as before, so the tag never changes admission.
func TestMediaWriteDomainFallbackByteIdentical(t *testing.T) {
	sk := testIssuer(t)
	m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, membership.NewMemStore(), []int{1, 30351}, 8, 0)

	for _, dom := range []string{"picture", "audio", "bogus", ""} {
		if reject, msg := m.RejectEvent(context.Background(), blindEventDom(30351, mintCred(t, sk), dom)); reject {
			t.Fatalf("with no media keys, a stiq_dom=%q post must be admitted on the general keys: %s", dom, msg)
		}
	}
}

// TestAudioWriteDomainRouting mirrors the picture case for the audio domain.
func TestAudioWriteDomainRouting(t *testing.T) {
	postSk := testIssuer(t)
	audSk := testIssuer(t)
	m := NewMembership([]*rsa.PublicKey{&postSk.PublicKey}, membership.NewMemStore(), []int{1, 1222}, 8, 0)
	m.SetAudioWriteIssuers([]*rsa.PublicKey{&audSk.PublicKey})

	if reject, msg := m.RejectEvent(context.Background(), blindEventDom(1222, mintCred(t, audSk), "audio")); reject {
		t.Fatalf("an audio-write token on a stiq_dom=audio post must be admitted: %s", msg)
	}
	if reject, _ := m.RejectEvent(context.Background(), blindEventDom(1222, mintCred(t, postSk), "audio")); !reject {
		t.Fatal("a general posting token must NOT satisfy a stiq_dom=audio post once audio-write keys are set")
	}
}
