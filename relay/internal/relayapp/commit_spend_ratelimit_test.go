package relayapp

// Finding F1, ratelimit surface: a token-bearing ATTRIBUTED space message (channel/DM) that the rate
// limiter rejects must NOT have its token consumed. This lives in relayapp (not policy) because the
// ratelimit package imports policy, so a policy test importing ratelimit would be an import cycle;
// relayapp already depends on both. The test drives the REAL limiter + REAL membership VerifyEvent /
// CommitSpend in the relay's hook order (relay.go), with a first-reject short-circuit, and asserts the
// token survives the ratelimit reject. The companion space/post/organizer/group/admitAttributed cases
// live in internal/policy/commit_spend_test.go.

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"

	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	secp256k1 "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/config"
	"github.com/stiq/relay/internal/membership"
	"github.com/stiq/relay/internal/policy"
	"github.com/stiq/relay/internal/ratelimit"
)

// fixedSource is a ratelimit.Source with a static limits policy (no organizer wiring needed).
type fixedSource struct{ limits policy.Limits }

func (f fixedSource) Limits() policy.Limits   { return f.limits }
func (f fixedSource) IsModerator(string) bool { return false }
func (f fixedSource) IsOrganizer(string) bool { return false }

// spaceChatEvent builds a bound-npub kind-`kind` space message carrying one space-write token with a
// valid all-proofs stiq_spend chain — the wire shape gateSpaceTokens verifies. It mirrors the policy
// package's spaceEvent test helper (test helpers don't cross package boundaries, and relayapp is the
// only package that can also construct the ratelimit hook). The stiq_spend proof signs
// sha256("stiq-spend-v1" || memberPubkeyBytes), the cross-package spend-message contract
// (policy.spendMessage / client blind/holderProof.ts).
func spaceChatEvent(t *testing.T, spaceSK *rsa.PrivateKey, kind int, memberPK string, extraTags ...nostr.Tag) *nostr.Event {
	t.Helper()
	// A holder-bound token: 32 random bytes ARE a BIP-340 x-only pubkey Q; the secret is q.
	q := nostr.GeneratePrivateKey()
	Q, err := nostr.GetPublicKey(q)
	if err != nil {
		t.Fatalf("holder pubkey: %v", err)
	}
	QBytes, err := hex.DecodeString(Q)
	if err != nil {
		t.Fatalf("decode Q: %v", err)
	}
	cred, err := membership.RequestCredential(&spaceSK.PublicKey, QBytes, membership.NewIssuer(spaceSK).BlindSign)
	if err != nil {
		t.Fatalf("mint space cred: %v", err)
	}
	evPub, err := hex.DecodeString(memberPK)
	if err != nil {
		t.Fatalf("decode member pubkey: %v", err)
	}
	digest := sha256.Sum256(append([]byte("stiq-spend-v1"), evPub...))
	qBytes, err := hex.DecodeString(q)
	if err != nil {
		t.Fatalf("decode q: %v", err)
	}
	sig, err := schnorr.Sign(secp256k1.PrivKeyFromBytes(qBytes), digest[:])
	if err != nil {
		t.Fatalf("spend proof sign: %v", err)
	}
	tags := nostr.Tags{}
	tags = append(tags, extraTags...)
	tags = append(tags,
		nostr.Tag{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
		nostr.Tag{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)},
		nostr.Tag{"stiq_spend", base64.StdEncoding.EncodeToString(sig.Serialize())},
	)
	ev := &nostr.Event{Kind: kind, PubKey: memberPK, Content: "hi", Tags: tags}
	ev.ID = ev.GetID()
	return ev
}

// spaceTokenIDs returns the TokenID of every stiq_token the event carries.
func spaceTokenIDs(t *testing.T, ev *nostr.Event) []string {
	t.Helper()
	var ids []string
	for _, tag := range ev.Tags {
		if len(tag) >= 2 && tag[0] == "stiq_token" {
			b, err := base64.StdEncoding.DecodeString(tag[1])
			if err != nil {
				t.Fatalf("decode token: %v", err)
			}
			ids = append(ids, membership.TokenID(b))
		}
	}
	return ids
}

// TestF1SpaceTokenNotSpentWhenRatelimitRejects: a bound member's channel message (kind 1311) carrying
// a valid space token passes the membership VERIFY hook, but the rate limiter — which runs BEFORE the
// commit hook and does NOT exempt attributed space content — rejects it once the per-user channel
// window is full. Because khatru short-circuits on the first reject, CommitSpend never runs, so the
// token is not consumed. (Under the old inline spend it was burned in the membership hook first.)
func TestF1SpaceTokenNotSpentWhenRatelimitRejects(t *testing.T) {
	ctx := context.Background()

	generalSK, _ := issuerKeyPEM(t) // membership issuer
	spaceSK, _ := issuerKeyPEM(t)   // dedicated space-write issuer
	_, memberPK := keypair(t)

	store := membership.NewMemStore()
	if err := store.Bind("cred-id", memberPK); err != nil {
		t.Fatalf("bind member: %v", err)
	}
	m := policy.NewMembership([]*rsa.PublicKey{&generalSK.PublicKey}, store, config.DefaultAllowedKinds, 8, 0)
	m.SetSpaceWriteIssuers([]*rsa.PublicKey{&spaceSK.PublicKey})
	m.SetSpaceTokensRequired(true)

	// Real limiter with a channel window of exactly 1 per day.
	limits := policy.DefaultLimits
	limits.Channel = policy.Window{Daily: 1}
	limiter := ratelimit.New(fixedSource{limits})

	// Saturate the member's channel window with one plain (tokenless) 1311 — the limiter counts by
	// pubkey+category and is oblivious to tokens/membership.
	plain := &nostr.Event{Kind: 1311, PubKey: memberPK, Content: "first"}
	plain.ID = plain.GetID()
	if reject, msg := limiter.RejectEvent(ctx, plain); reject {
		t.Fatalf("the first channel message must be within the cap: %s", msg)
	}

	// The token-bearing channel message: passes verify, then the limiter rejects it (over cap).
	ev := spaceChatEvent(t, spaceSK, 1311, memberPK)
	if reject, msg := m.VerifyEvent(ctx, ev); reject {
		t.Fatalf("a valid space-token channel message must pass the membership verify: %s", msg)
	}
	if reject, _ := limiter.RejectEvent(ctx, ev); !reject {
		t.Fatal("attributed space content is NOT ratelimit-exempt — the over-cap message must be rejected")
	}
	// First-reject short-circuit: the relay never reaches CommitSpend, so nothing is spent.
	for _, id := range spaceTokenIDs(t, ev) {
		if store.IsSpent(id) {
			t.Fatal("F1: a valid space token must NOT be consumed when the ratelimiter rejects")
		}
	}

	// Positive control (fresh token, so it can't interfere): had the chain reached the commit, the
	// token WOULD have been spent — confirming CommitSpend is the only consumer and the assertion
	// above fails for the right reason.
	ev2 := spaceChatEvent(t, spaceSK, 1311, memberPK)
	if reject, msg := m.VerifyEvent(ctx, ev2); reject {
		t.Fatalf("control: verify must pass: %s", msg)
	}
	if reject, msg := m.CommitSpend(ctx, ev2); reject {
		t.Fatalf("control: commit must spend a verified token: %s", msg)
	}
	for _, id := range spaceTokenIDs(t, ev2) {
		if !store.IsSpent(id) {
			t.Fatal("control: CommitSpend must consume the space token")
		}
	}
}
