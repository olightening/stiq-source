package policy

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"

	secp256k1 "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/membership"
)

// A generous allow-list so the gate — not the kind allow-list — is what's under test.
var gateKinds = []int{0, 1, 5, 7, 42, 1018, 1068, 1111, 1222, 1244, 1311, 1984, 10000, 10003, 30023, 30078}

// boundMembership builds a Membership whose store already has one bound npub, so we can exercise
// the blindRequired gate on tokenless bound-npub events.
func boundMembership(t *testing.T, boundPubkey string) (*Membership, *rsa.PrivateKey) {
	t.Helper()
	sk := testIssuer(t)
	store := membership.NewMemStore()
	if err := store.Bind("bound-credential-id", boundPubkey); err != nil {
		t.Fatalf("bind: %v", err)
	}
	m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, store, gateKinds, 8, 0)
	return m, sk
}

func tokenless(kind int, pubkey string) *nostr.Event {
	return &nostr.Event{Kind: kind, PubKey: pubkey, Content: "hi", Tags: nostr.Tags{}}
}

// When blind is required, a bound member can no longer publish a blind-eligible content kind
// tokenless — that is exactly the bound-npub bypass (re-linkable, token-free content) we close.
func TestBlindRequiredRejectsTokenlessContentFromBoundNpub(t *testing.T) {
	m, _ := boundMembership(t, "member")
	m.SetBlindRequired(true)
	for _, kind := range []int{1, 7, 1111, 1018, 1068, 1222, 1244, 30023} {
		reject, msg := m.RejectEvent(context.Background(), tokenless(kind, "member"))
		if !reject {
			t.Errorf("kind %d from a bound npub must be rejected when blind is required", kind)
		} else if msg == "" {
			t.Errorf("kind %d: expected a rejection message", kind)
		}
	}
}

// The token path still works: a properly blind post (throwaway key + valid token) is admitted.
func TestBlindRequiredAdmitsProperBlindPost(t *testing.T) {
	m, sk := boundMembership(t, "member")
	m.SetBlindRequired(true)
	if reject, msg := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, sk))); reject {
		t.Fatalf("a proper blind post must be admitted when blind is required: %s", msg)
	}
}

// Ships dark: with the flag off (the default), the legacy bound-npub content path is unchanged.
func TestBlindRequiredShipsDark(t *testing.T) {
	m, _ := boundMembership(t, "member")
	// no SetBlindRequired — defaults false
	if reject, msg := m.RejectEvent(context.Background(), tokenless(1, "member")); reject {
		t.Fatalf("with blind not required, a bound npub's tokenless note must still be admitted: %s", msg)
	}
}

// Non-content kinds a bound npub legitimately publishes (profile, report, lists, channels, live
// chat, mod delete) stay on the bound path even when blind is required — they are NOT spam-vector
// content and, for channels/live-chat, are gated on role by GroupGuard.
func TestBlindRequiredKeepsNonContentKindsTokenless(t *testing.T) {
	m, _ := boundMembership(t, "member")
	m.SetBlindRequired(true)
	for _, kind := range []int{0, 5, 42, 1311, 1984, 10000, 10003} {
		if reject, msg := m.RejectEvent(context.Background(), tokenless(kind, "member")); reject {
			t.Errorf("kind %d must stay admissible for a bound npub even when blind is required: %s", kind, msg)
		}
	}
}

// A stranger (not bound) posting tokenless content is rejected regardless — the blind gate must not
// accidentally admit a non-member.
func TestBlindRequiredStillRejectsNonMember(t *testing.T) {
	m, _ := boundMembership(t, "member")
	m.SetBlindRequired(true)
	if reject, _ := m.RejectEvent(context.Background(), tokenless(1, "stranger")); !reject {
		t.Fatal("a non-member tokenless note must be rejected when blind is required")
	}
}

// The gate is hot-reloadable both ways.
func TestBlindRequiredToggles(t *testing.T) {
	m, _ := boundMembership(t, "member")
	m.SetBlindRequired(true)
	if reject, _ := m.RejectEvent(context.Background(), tokenless(1, "member")); !reject {
		t.Fatal("expected reject while blind required")
	}
	m.SetBlindRequired(false)
	if reject, msg := m.RejectEvent(context.Background(), tokenless(1, "member")); reject {
		t.Fatalf("expected admit after disabling blind requirement: %s", msg)
	}
}

// ---------------------------------------------------------------------------------------------
// P3 holder-bound token (spend-proof) gate.
//
// The shared contract with the client (which does NOT share a file with this package): 32 random
// token bytes BECOME a BIP-340 x-only secp256k1 pubkey Q; the client keeps the secret q. Token 0
// signs the event itself (event.pubkey == Q0), so its holder-proof is free. Every further token
// i>=1 carries a positional stiq_spend tag: a BIP-340 signature over
// spendMessage(event.pubkey) = sha256("stiq-spend-v1" || event.pubkey_bytes).
// ---------------------------------------------------------------------------------------------

// holderKeypair mints a fresh secp256k1 keypair the way a P3 client mints a holder-bound token: q
// is the 32-byte secret scalar (hex) and Q its BIP-340 x-only pubkey (hex, 32 bytes). Reuses
// go-nostr's own key generation/derivation (btcsuite/btcd schnorr under the hood) — the SAME
// BIP-340 implementation RequireValidSignature and checkHolderProof (btcec/v2/schnorr) verify with.
func holderKeypair(t *testing.T) (q, Q string) {
	t.Helper()
	q = nostr.GeneratePrivateKey()
	var err error
	Q, err = nostr.GetPublicKey(q)
	if err != nil {
		t.Fatalf("derive holder pubkey: %v", err)
	}
	return q, Q
}

// mintCredForToken runs the real blind-issuance flow (mirrors mintCred in blindtoken_test.go) over
// a CALLER-CHOSEN token rather than random bytes — needed because a holder-bound token's 32 bytes
// must equal a specific BIP-340 x-only pubkey Q, not arbitrary bytes.
func mintCredForToken(t *testing.T, sk *rsa.PrivateKey, token []byte) membership.Credential {
	t.Helper()
	cred, err := membership.RequestCredential(&sk.PublicKey, token, membership.NewIssuer(sk).BlindSign)
	if err != nil {
		t.Fatalf("RequestCredential: %v", err)
	}
	return cred
}

// holderSpendProof signs the P3 spend-message digest for a token i>=1 with its secret q, mirroring
// the client's blind/holderProof.ts spendProof exactly: a BIP-340 signature over
// sha256(spendDomain || evPub).
func holderSpendProof(t *testing.T, qHex, evPubHex string) []byte {
	t.Helper()
	qBytes, err := hex.DecodeString(qHex)
	if err != nil {
		t.Fatalf("decode q: %v", err)
	}
	evPub, err := hex.DecodeString(evPubHex)
	if err != nil {
		t.Fatalf("decode event pubkey: %v", err)
	}
	digest := spendMessage(evPub)
	sig, err := schnorr.Sign(secp256k1.PrivKeyFromBytes(qBytes), digest[:])
	if err != nil {
		t.Fatalf("schnorr sign: %v", err)
	}
	return sig.Serialize()
}

// holderBoundEvent builds an admissible P3 holder-bound blind post carrying `extraTokens` tokens
// beyond token 0 (event.pubkey == Q0), each with a valid positional stiq_spend proof — the exact
// wire shape blind/blindPost.ts assembleBlindEvent emits. It sets no real signature: Membership-
// level tests exercise handleBlindPost directly (RequireValidSignature is a separate, earlier hook
// in the real chain — see TestHolderProofHookOrderRegression in relayapp for that invariant).
func holderBoundEvent(t *testing.T, sk *rsa.PrivateKey, kind int, extraTokens int) *nostr.Event {
	t.Helper()
	_, Q0 := holderKeypair(t)
	Q0Bytes, err := hex.DecodeString(Q0)
	if err != nil {
		t.Fatalf("decode Q0: %v", err)
	}
	cred0 := mintCredForToken(t, sk, Q0Bytes)
	tags := nostr.Tags{
		{"stiq_token", base64.StdEncoding.EncodeToString(cred0.Token)},
		{"stiq_sig", base64.StdEncoding.EncodeToString(cred0.Signature)},
	}
	for i := 0; i < extraTokens; i++ {
		qi, Qi := holderKeypair(t)
		QiBytes, err := hex.DecodeString(Qi)
		if err != nil {
			t.Fatalf("decode Qi: %v", err)
		}
		credI := mintCredForToken(t, sk, QiBytes)
		proof := holderSpendProof(t, qi, Q0)
		tags = append(tags,
			nostr.Tag{"stiq_token", base64.StdEncoding.EncodeToString(credI.Token)},
			nostr.Tag{"stiq_sig", base64.StdEncoding.EncodeToString(credI.Signature)},
			nostr.Tag{"stiq_spend", base64.StdEncoding.EncodeToString(proof)},
		)
	}
	event := &nostr.Event{Kind: kind, PubKey: Q0, Content: "hi", Tags: tags}
	event.ID = event.GetID()
	return event
}

// A single-token holder-bound post carries NO stiq_spend tag at all — token 0's holder proof IS
// the event's own signature (event.pubkey == Q0) — and must be admitted when holder proof is
// required. This is the "wire-identical to today" shape (crypto §2.3).
func TestHolderProofAdmitsSingleTokenNoSpendTag(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	m.SetHolderProofRequired(true)
	ev := holderBoundEvent(t, sk, 1, 0)
	if reject, msg := m.RejectEvent(context.Background(), ev); reject {
		t.Fatalf("single-token holder-bound post (no stiq_spend) should be admitted: %s", msg)
	}
}

// A multi-token holder-bound post with valid positional stiq_spend proofs is admitted.
func TestHolderProofAdmitsMultiTokenPositionalProofs(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	m.SetHolderProofRequired(true)
	ev := holderBoundEvent(t, sk, 1, 2) // token 0 + 2 more, each with a valid positional proof
	if reject, msg := m.RejectEvent(context.Background(), ev); reject {
		t.Fatalf("multi-token holder-bound post with valid positional proofs should be admitted: %s", msg)
	}
}

// Swapping two tokens' stiq_spend VALUES (so a valid proof lands on the wrong token) must be
// rejected — proving the pairing is truly POSITIONAL, not any-proof-matches-any-token (crypto
// red-team mustFix #2).
func TestHolderProofRejectsWrongPositionProof(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	m.SetHolderProofRequired(true)
	ev := holderBoundEvent(t, sk, 1, 2)

	var spendIdx []int
	for i, tag := range ev.Tags {
		if len(tag) >= 2 && tag[0] == "stiq_spend" {
			spendIdx = append(spendIdx, i)
		}
	}
	if len(spendIdx) != 2 {
		t.Fatalf("expected 2 stiq_spend tags, got %d", len(spendIdx))
	}
	ev.Tags[spendIdx[0]][1], ev.Tags[spendIdx[1]][1] = ev.Tags[spendIdx[1]][1], ev.Tags[spendIdx[0]][1]
	ev.ID = ev.GetID()

	if reject, msg := m.RejectEvent(context.Background(), ev); !reject {
		t.Fatal("a valid proof landing on the wrong positional token must be rejected")
	} else if !strings.Contains(msg, "holder_proof_invalid") {
		t.Errorf("expected holder_proof_invalid, got %q", msg)
	}
}

// A corrupted/garbage stiq_spend proof is rejected.
func TestHolderProofRejectsGarbageProof(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	m.SetHolderProofRequired(true)
	ev := holderBoundEvent(t, sk, 1, 1)
	for i, tag := range ev.Tags {
		if len(tag) >= 2 && tag[0] == "stiq_spend" {
			ev.Tags[i][1] = base64.StdEncoding.EncodeToString(make([]byte, 64)) // all-zero garbage sig
		}
	}
	ev.ID = ev.GetID()
	if reject, msg := m.RejectEvent(context.Background(), ev); !reject {
		t.Fatal("a garbage stiq_spend proof must be rejected")
	} else if !strings.Contains(msg, "holder_proof_invalid") {
		t.Errorf("expected holder_proof_invalid, got %q", msg)
	}
}

// Token 0 must equal event.pubkey once holder proof is required — a legacy bearer-style shape
// (throwaway signer, token 0 unrelated to event.pubkey) is rejected.
func TestHolderProofRejectsToken0MismatchWithEventPubkey(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	m.SetHolderProofRequired(true)
	ev := holderBoundEvent(t, sk, 1, 0)
	_, otherQ := holderKeypair(t)
	ev.PubKey = otherQ // token 0 no longer matches the (new) event.pubkey
	ev.ID = ev.GetID()
	if reject, msg := m.RejectEvent(context.Background(), ev); !reject {
		t.Fatal("token 0 not matching event.pubkey must be rejected once holder proof is required")
	} else if !strings.Contains(msg, "holder_proof_invalid") {
		t.Errorf("expected holder_proof_invalid, got %q", msg)
	}
}

// Ships dark: with holderProofRequired off (the default), a legacy bearer-style blind post (token 0
// unrelated to event.pubkey, no stiq_spend tag at all — exactly today's shape) is admitted
// unchanged. Extra/mismatched holder-proof shape must never break a pre-P3 client.
func TestHolderProofShipsDark(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	// no SetHolderProofRequired — defaults false
	if reject, msg := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, sk))); reject {
		t.Fatalf("with holder proof not required, a legacy bearer-style blind post must still be admitted: %s", msg)
	}
}

// M2 (weight-pricing free-byte channel): stiq_spend tags are weight-exempt, so their COUNT must be
// bounded even in DARK mode where the full holder proof is skipped — otherwise a member with one
// token pads unpriced junk into stiq_spend tags. The bound counts RAW tags by name (spendTagCount),
// so it also catches undecodable-base64 padding that extractSpendProofs drops.
func TestHolderProofBoundsSpendCountEvenWhenDark(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	// no SetHolderProofRequired — DARK (default false), so checkHolderProof does not run.

	// Baseline: a bearer post (1 token, zero stiq_spend) is still admitted in dark mode.
	if reject, msg := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, sk))); reject {
		t.Fatalf("dark-mode bearer post (no stiq_spend) must be admitted: %s", msg)
	}

	// One token + a junk stiq_spend tag ⇒ bound is 0 ⇒ reject, even though the junk is UNDECODABLE
	// base64 (extractSpendProofs would drop it; spendTagCount counts it by name).
	ev := blindEvent(1, mintCred(t, sk))
	ev.Tags = append(ev.Tags, nostr.Tag{"stiq_spend", "!!! not valid base64 padding !!!"})
	ev.ID = ev.GetID()
	if reject, _ := m.RejectEvent(context.Background(), ev); !reject {
		t.Fatal("dark-mode event with a stiq_spend tag beyond tokenCount-1 must be rejected (free-byte channel)")
	}
}

// The gate is hot-reloadable both ways (mirrors TestBlindRequiredToggles).
func TestHolderProofToggles(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)

	m.SetHolderProofRequired(true)
	if reject, _ := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, sk))); !reject {
		t.Fatal("expected reject: legacy bearer token 0 != event.pubkey, while holder proof is required")
	}

	m.UpdateHolderProofRequired(false)
	if reject, msg := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, sk))); reject {
		t.Fatalf("expected admit after disabling holder-proof requirement: %s", msg)
	}
}

// TestHolderProofHookOrderInvariant pins crypto red-team mustFix #3 (P3 synthesis §2.6) at the
// POLICY level: it proves BOTH halves of the claim "the token0==event.pubkey shortcut is sound
// ONLY because RequireValidSignature runs before membership".
//
//  1. RequireValidSignature, run first (as relay.go orders it), rejects a garbage-signature event
//     outright — even though its pubkey equals a captured Q.
//  2. Membership.RejectEvent, run WITHOUT that prior signature gate (i.e. in isolation, as a
//     hypothetically-reordered chain would let happen), ADMITS the very same forged event: it has
//     no way to know the signature is invalid, so token0==event.pubkey satisfies the shortcut.
//
// (2) is exactly the forgery hole the hook order in relay.go closes; this test demonstrates it
// unconditionally, independent of khatru's own transport-level id/signature gate (which also
// enforces this for the real WebSocket EVENT path — see TestHolderProofHookOrderRegression in
// relayapp for that end-to-end check). If a future change ever calls Membership.RejectEvent from
// somewhere that does NOT first run RequireValidSignature, this failure mode is real.
func TestHolderProofHookOrderInvariant(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	m.SetHolderProofRequired(true)

	_, Q := holderKeypair(t) // a real x-only pubkey; deliberately never used to sign anything
	Qbytes, err := hex.DecodeString(Q)
	if err != nil {
		t.Fatalf("decode Q: %v", err)
	}
	cred := mintCredForToken(t, sk, Qbytes) // token 0 == Q: the shortcut would pass if reached

	ev := &nostr.Event{
		Kind:    1,
		PubKey:  Q,
		Content: "forged",
		Tags: nostr.Tags{
			{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
			{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)},
		},
	}
	ev.ID = ev.GetID()
	ev.Sig = strings.Repeat("ab", 64) // garbage signature, never produced by Q's secret

	// (1) The signature gate, run first as relay.go orders it, rejects this event outright.
	if reject, msg := RequireValidSignature(context.Background(), ev); !reject {
		t.Fatalf("a garbage-signature event must be rejected by RequireValidSignature, got admit (msg=%q)", msg)
	}

	// (2) Membership alone (no prior signature check) is fooled by the token0==event.pubkey
	// shortcut and ADMITS this same forged event — proving the ordering in relay.go is load-bearing,
	// not incidental.
	if reject, msg := m.RejectEvent(context.Background(), ev); reject {
		t.Fatalf("expected membership alone (without a prior signature check) to admit the token0-shortcut event, got reject: %q", msg)
	}
}

// A positional creds/proofs list beyond maxTokenPairsPerEvent is rejected BEFORE any schnorr verify
// runs — bounds CPU per event exactly like the existing distinct-token cap (findings #36/#73),
// extended to the holder-proof chain. Reuses one repeated (token,sig) triple so the test stays
// cheap (no fresh RSA/schnorr signing per padding entry); extractCredentials/extractSpendProofs
// count by tag OCCURRENCE, not distinct identity, so padding still inflates the positional count.
func TestHolderProofCapsProofOrTokenCount(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	m.SetHolderProofRequired(true)

	_, Q0 := holderKeypair(t)
	Q0Bytes, err := hex.DecodeString(Q0)
	if err != nil {
		t.Fatalf("decode Q0: %v", err)
	}
	cred0 := mintCredForToken(t, sk, Q0Bytes)
	ev := &nostr.Event{Kind: 1, PubKey: Q0, Content: "hi", Tags: nostr.Tags{
		{"stiq_token", base64.StdEncoding.EncodeToString(cred0.Token)},
		{"stiq_sig", base64.StdEncoding.EncodeToString(cred0.Signature)},
	}}
	garbageProof := base64.StdEncoding.EncodeToString(make([]byte, 64))
	for i := 0; i < maxTokenPairsPerEvent+10; i++ {
		ev.Tags = append(ev.Tags,
			nostr.Tag{"stiq_token", base64.StdEncoding.EncodeToString(cred0.Token)},
			nostr.Tag{"stiq_sig", base64.StdEncoding.EncodeToString(cred0.Signature)},
			nostr.Tag{"stiq_spend", garbageProof},
		)
	}
	ev.ID = ev.GetID()

	if reject, msg := m.RejectEvent(context.Background(), ev); !reject {
		t.Fatal("a positional creds/proofs list beyond maxTokenPairsPerEvent must be rejected")
	} else if !strings.Contains(msg, "holder_proof_invalid") {
		t.Errorf("expected holder_proof_invalid (proof-count cap), got %q", msg)
	}
}

// ---------------------------------------------------------------------------------------------
// P4 double-spend witness (kind 1986) admission.
//
// A witness is a normal member-signed advisory event carrying NO token (contracts.KIND_SPEND_WITNESS
// on the client; it is in config.DefaultAllowedKinds so the relay accepts it). It rides the SAME
// bound-member path as a moderation report: hasToken=false → not a blindContentKind → IsBound → kind
// in the allow-list → admit. Its self-verification is a CLIENT concern (blind/spendWitness.ts
// re-derives the conflict before hiding anything), so the relay grants it no trust and only needs to
// store/serve it — admission from a member, rejection from a non-member, is all that is under test.
//
// GroupGuard (the next hook) never catches 1986 either: it is not IsStateKind / IsManagementKind /
// IsChatKind and is not a kind-7 reaction, so its switch falls to `default: admit`.
const kindSpendWitness = 1986

func TestSpendWitnessAdmittedFromBoundMemberRejectedFromNonMember(t *testing.T) {
	sk := testIssuer(t)
	store := membership.NewMemStore()
	if err := store.Bind("witness-member-cred", "member"); err != nil {
		t.Fatalf("bind: %v", err)
	}
	m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, store, []int{1, kindSpendWitness}, 8, 0)

	// A bound member's tokenless kind-1986 witness is admitted (bound-member path, exactly like a report).
	if reject, msg := m.RejectEvent(context.Background(), tokenless(kindSpendWitness, "member")); reject {
		t.Fatalf("a bound member's double-spend witness (kind %d) must be admitted: %s", kindSpendWitness, msg)
	}
	// A non-member's identical witness is rejected — the anti-abuse signal must stay member-signed, so a
	// stranger cannot flood forged witnesses onto the firehose.
	if reject, msg := m.RejectEvent(context.Background(), tokenless(kindSpendWitness, "stranger")); !reject {
		t.Fatalf("a non-member's double-spend witness must be rejected, got admit (msg=%q)", msg)
	}
}
