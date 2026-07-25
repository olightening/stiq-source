package policy

// Tokens-everywhere: the space-write token gate (gateSpaceTokens / checkAllSpendProofs). Space
// content stays bound-npub-signed (roles + attribution) but must ALSO spend blind space-write
// tokens once the operator flips space_tokens_required — with an ALL-PROOFS stiq_spend chain
// (every token carries a proof; no token equals event.pubkey, unlike the blind path).

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"

	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/membership"
)

// spaceGateMembership builds a Membership with one bound npub and an allow-list that includes the
// NIP-29 group kinds (gateKinds doesn't carry them), so the space-token gate — not the kind
// allow-list — is what's under test.
func spaceGateMembership(t *testing.T, boundPubkey string) (*Membership, *rsa.PrivateKey) {
	t.Helper()
	sk := testIssuer(t)
	store := membership.NewMemStore()
	if err := store.Bind("bound-credential-id", boundPubkey); err != nil {
		t.Fatalf("bind: %v", err)
	}
	kinds := append(append([]int{}, gateKinds...), 9, 11, 12)
	m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, store, kinds, 8, 0)
	return m, sk
}

// spaceMembership additionally supplies a DEDICATED space-write issuer key (distinct from the
// general issuer), enforcement optionally on.
func spaceMembership(t *testing.T, boundPubkey string, required bool) (*Membership, *rsa.PrivateKey, *rsa.PrivateKey) {
	t.Helper()
	m, generalSk := spaceGateMembership(t, boundPubkey)
	spaceSk := testIssuer(t)
	m.SetSpaceWriteIssuers([]*rsa.PublicKey{&spaceSk.PublicKey})
	m.SetSpaceTokensRequired(required)
	return m, generalSk, spaceSk
}

// memberPubkey returns a real (well-formed, 32-byte-hex) npub for the bound member — the space
// proof chain decodes event.pubkey, so tests can't use a prose placeholder like "member".
func memberPubkey(t *testing.T) string {
	t.Helper()
	_, pub := holderKeypair(t)
	return pub
}

// spaceEvent builds a bound-npub space event carrying `n` space-write tokens, each with a valid
// positional stiq_spend proof bound to the event's own pubkey — the exact all-proofs wire shape
// the client emits for channel/group content (and, with an ephemeral pubkey, DM wraps).
func spaceEvent(t *testing.T, spaceSk *rsa.PrivateKey, kind int, pubkey string, n int, extraTags ...nostr.Tag) *nostr.Event {
	t.Helper()
	tags := nostr.Tags{}
	tags = append(tags, extraTags...)
	proofs := nostr.Tags{}
	for i := 0; i < n; i++ {
		qi, Qi := holderKeypair(t)
		QiBytes, err := hex.DecodeString(Qi)
		if err != nil {
			t.Fatalf("decode Qi: %v", err)
		}
		cred := mintCredForToken(t, spaceSk, QiBytes)
		tags = append(tags,
			nostr.Tag{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
			nostr.Tag{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)},
		)
		proofs = append(proofs, nostr.Tag{"stiq_spend", base64.StdEncoding.EncodeToString(holderSpendProof(t, qi, pubkey))})
	}
	tags = append(tags, proofs...)
	event := &nostr.Event{Kind: kind, PubKey: pubkey, Content: "hi", Tags: tags}
	event.ID = event.GetID()
	return event
}

// minePoW gives an event a committed nonce tag and grinds its id to `bits` leading zero bits —
// enough for the tiny difficulties these tests configure.
func mineSpacePoW(t *testing.T, event *nostr.Event, bits int) {
	t.Helper()
	for i := 0; ; i++ {
		event.Tags = append(nostr.Tags{}, event.Tags...)
		event.Tags = append(event.Tags, nostr.Tag{"nonce", strconv.Itoa(i), strconv.Itoa(bits)})
		event.ID = event.GetID()
		if membership.LeadingZeroBits(event.ID) >= bits {
			return
		}
		event.Tags = event.Tags[:len(event.Tags)-1]
	}
}

// Ships dark: with the flag off (default), tokenless space content from a bound member admits
// exactly as before — for every space kind.
func TestSpaceTokensShipDark(t *testing.T) {
	pk := memberPubkey(t)
	m, _, _ := spaceMembership(t, pk, false)
	for _, kind := range []int{42, 1311, 9, 11, 12} {
		if reject, msg := m.RejectEvent(context.Background(), tokenless(kind, pk)); reject {
			t.Errorf("kind %d tokenless must stay admissible while space tokens are dark: %s", kind, msg)
		}
	}
}

// Enforcement on: tokenless member space content is rejected with the stable code…
func TestSpaceTokensRequiredRejectsTokenless(t *testing.T) {
	pk := memberPubkey(t)
	m, _, _ := spaceMembership(t, pk, true)
	for _, kind := range []int{42, 1311, 9, 11, 12} {
		reject, msg := m.RejectEvent(context.Background(), tokenless(kind, pk))
		if !reject {
			t.Errorf("kind %d tokenless must be rejected when space tokens are required", kind)
		} else if !strings.Contains(msg, codeSpaceTokenRequired) {
			t.Errorf("kind %d: expected [%s] code, got: %s", kind, codeSpaceTokenRequired, msg)
		}
	}
}

// …while the control plane (joins, leaves, adds/removes, metadata, key delivery, settings docs,
// profiles, reports, lists) is NEVER token-taxed — a joiner has no wallet yet.
func TestSpaceTokensNeverTaxControlPlane(t *testing.T) {
	pk := memberPubkey(t)
	m, _, _ := spaceMembership(t, pk, true)
	// gateKinds allow-list covers 0/1984/10000/10003/30078; extend with the group management kinds.
	for _, kind := range []int{0, 1984, 10000, 10003, 30078} {
		if reject, msg := m.RejectEvent(context.Background(), tokenless(kind, pk)); reject {
			t.Errorf("control-plane kind %d must stay tokenless-admissible under enforcement: %s", kind, msg)
		}
	}
}

// The full happy path: a bound member's group message carrying valid space tokens with the
// all-proofs chain admits, spends the tokens, and a REPLAY of any token in a DIFFERENT event is
// refused (double-spend), while re-publishing the SAME event is idempotent.
func TestSpaceTokenAdmitsAndSpends(t *testing.T) {
	pk := memberPubkey(t)
	m, _, spaceSk := spaceMembership(t, pk, true)
	ev := spaceEvent(t, spaceSk, 9, pk, 1)
	if reject, msg := m.RejectEvent(context.Background(), ev); reject {
		t.Fatalf("valid space-token group message must admit: %s", msg)
	}
	// Same signed event again: idempotent (OK-frame-lost retry).
	if reject, msg := m.RejectEvent(context.Background(), ev); reject {
		t.Fatalf("re-publishing the same event must be idempotent: %s", msg)
	}
	// A different event reusing the same token: double-spend.
	reused := &nostr.Event{Kind: 9, PubKey: pk, Content: "again", Tags: ev.Tags}
	reused.ID = reused.GetID()
	if reject, msg := m.RejectEvent(context.Background(), reused); !reject || !strings.Contains(msg, codeTokenSpent) {
		t.Fatalf("token reuse in a different event must be rejected as spent, got reject=%v msg=%s", reject, msg)
	}
}

// Multi-token weight pricing: with bytes_per_token on, an oversized space message must pay its full
// cost, and an underpaid one is refused.
func TestSpaceTokenWeightPricing(t *testing.T) {
	pk := memberPubkey(t)
	m, _, spaceSk := spaceMembership(t, pk, true)
	m.SetBytesPerToken(4) // "hi" = 2 bytes → 1 token; longer content costs more
	one := spaceEvent(t, spaceSk, 9, pk, 1)
	one.Content = strings.Repeat("x", 9) // 9 bytes / 4 → need 3
	one.ID = one.GetID()
	// Proofs were built over the original event pubkey (unchanged), so the chain still verifies;
	// only the token COUNT is short.
	if reject, msg := m.RejectEvent(context.Background(), one); !reject || !strings.Contains(msg, codeTokenInsufficient) {
		t.Fatalf("underpaid space message must be token_insufficient, got reject=%v msg=%s", reject, msg)
	}
	three := spaceEvent(t, spaceSk, 9, pk, 3)
	three.Content = strings.Repeat("x", 9)
	three.ID = three.GetID()
	if reject, msg := m.RejectEvent(context.Background(), three); reject {
		t.Fatalf("fully-paid weighted space message must admit: %s", msg)
	}
}

// The blind-path shape (token 0 == event.pubkey, N-1 proofs) must NOT pass the space chain: every
// space token needs a proof, and the count equation rejects the blind shape outright.
func TestSpaceTokenRejectsBlindShape(t *testing.T) {
	pk := memberPubkey(t)
	m, _, spaceSk := spaceMembership(t, pk, true)
	ev := spaceEvent(t, spaceSk, 9, pk, 2)
	// Drop ONE stiq_spend tag → N-1 proofs (the blind path's count) → must be refused.
	trimmed := nostr.Tags{}
	dropped := false
	for i := len(ev.Tags) - 1; i >= 0; i-- {
		if !dropped && ev.Tags[i][0] == "stiq_spend" {
			dropped = true
			continue
		}
		trimmed = append(nostr.Tags{ev.Tags[i]}, trimmed...)
	}
	ev.Tags = trimmed
	ev.ID = ev.GetID()
	if reject, msg := m.RejectEvent(context.Background(), ev); !reject || !strings.Contains(msg, codeHolderProofInvalid) {
		t.Fatalf("N-1-proof (blind) shape must fail the space chain, got reject=%v msg=%s", reject, msg)
	}
}

// A proof bound to a DIFFERENT pubkey (stolen tokens re-attached to another author's event) fails.
func TestSpaceTokenRejectsForeignProof(t *testing.T) {
	pk := memberPubkey(t)
	other := memberPubkey(t)
	m, _, spaceSk := spaceMembership(t, pk, true)
	ev := spaceEvent(t, spaceSk, 9, other, 1) // proofs bound to `other`…
	ev.PubKey = pk                            // …but the event claims `pk`
	ev.ID = ev.GetID()
	if reject, msg := m.RejectEvent(context.Background(), ev); !reject || !strings.Contains(msg, codeHolderProofInvalid) {
		t.Fatalf("proof bound to a different pubkey must be rejected, got reject=%v msg=%s", reject, msg)
	}
}

// Tokens signed by the WRONG issuer domain (the general/posting key, not the space-write key) are
// refused — space tokens are their own domain with no fallback.
func TestSpaceTokenRejectsWrongDomainKey(t *testing.T) {
	pk := memberPubkey(t)
	m, generalSk, _ := spaceMembership(t, pk, true)
	ev := spaceEvent(t, generalSk, 9, pk, 1) // minted under the general issuer key
	if reject, msg := m.RejectEvent(context.Background(), ev); !reject || !strings.Contains(msg, codeTokenInvalid) {
		t.Fatalf("posting-domain tokens must not satisfy the space gate, got reject=%v msg=%s", reject, msg)
	}
}

// Both halves are needed: the flag WITHOUT keys must not enforce (it could never be satisfied and
// would brick every space).
func TestSpaceTokensFlagWithoutKeysDoesNotEnforce(t *testing.T) {
	pk := memberPubkey(t)
	m, _ := spaceGateMembership(t, pk)
	m.SetSpaceTokensRequired(true) // no SetSpaceWriteIssuers
	if reject, msg := m.RejectEvent(context.Background(), tokenless(9, pk)); reject {
		t.Fatalf("flag without keys must stay dark: %s", msg)
	}
}

// SIGHUP hot-reload of the space-write issuer keys (Reloader.Apply → UpdateSpaceWriteIssuers) must
// bring enforcement live WITHOUT a full restart, so the enforced gate can never lag the advertised
// space_tokens_required capability (read from the fresh config). Before the reload the flag is on but
// no keys are in memory, so a tokenless space write stays dark (admitted — the flag-without-keys
// case above); after the reload it is rejected exactly as a fully-provisioned relay would.
func TestSpaceWriteIssuersHotReloadEnablesEnforcement(t *testing.T) {
	pk := memberPubkey(t)
	m, _ := spaceGateMembership(t, pk)
	m.SetSpaceTokensRequired(true) // flag flipped via SIGHUP; keys not yet loaded into the process
	if reject, msg := m.RejectEvent(context.Background(), tokenless(9, pk)); reject {
		t.Fatalf("flag without keys must stay dark before the hot-reload: %s", msg)
	}
	// The SIGHUP now (re)loads the space-write issuer keys into the running process.
	spaceSk := testIssuer(t)
	m.UpdateSpaceWriteIssuers([]*rsa.PublicKey{&spaceSk.PublicKey})
	if reject, _ := m.RejectEvent(context.Background(), tokenless(9, pk)); !reject {
		t.Fatal("a tokenless space write must be rejected once the issuer keys are hot-reloaded")
	}
}

// Token-tagged space kinds with NO space keys configured stay rejected (as the blind-path kind
// gate rejected them before this feature) — junk tokens can never ride along for the rate-limiter
// exemption.
func TestSpaceTokensRejectTokensWhenUnconfigured(t *testing.T) {
	pk := memberPubkey(t)
	m, generalSk := spaceGateMembership(t, pk)
	ev := spaceEvent(t, generalSk, 1311, pk, 1)
	if reject, _ := m.RejectEvent(context.Background(), ev); !reject {
		t.Fatal("token-tagged space kinds must stay rejected while space keys are unconfigured")
	}
}

// h-tagged kind 7 (group reaction): while dark it keeps the LEGACY routing (blindRequired applies),
// so a group member can't h-tag feed votes to dodge the token budget; once enforced it pays space
// tokens like any group content.
func TestSpaceTokensKind7DualNature(t *testing.T) {
	pk := memberPubkey(t)
	hTag := nostr.Tag{"h", "group-1"}

	// Dark + blindRequired: tokenless h-tagged 7 is still rejected (legacy blind-content rule).
	dark, _, _ := spaceMembership(t, pk, false)
	dark.SetBlindRequired(true)
	ev7 := tokenless(7, pk)
	ev7.Tags = nostr.Tags{hTag}
	if reject, _ := dark.RejectEvent(context.Background(), ev7); !reject {
		t.Fatal("dark mode: h-tagged kind 7 must keep the legacy blindRequired rejection")
	}

	// Enforced: an h-tagged reaction with space tokens admits; tokenless is rejected.
	m, _, spaceSk := spaceMembership(t, pk, true)
	tokenless7 := tokenless(7, pk)
	tokenless7.Tags = nostr.Tags{hTag}
	if reject, msg := m.RejectEvent(context.Background(), tokenless7); !reject || !strings.Contains(msg, codeSpaceTokenRequired) {
		t.Fatalf("enforced: tokenless h-tagged kind 7 must need a space token, got reject=%v msg=%s", reject, msg)
	}
	paid := spaceEvent(t, spaceSk, 7, pk, 1, hTag)
	if reject, msg := m.RejectEvent(context.Background(), paid); reject {
		t.Fatalf("enforced: space-token h-tagged reaction must admit: %s", msg)
	}
	// An UNTAGGED kind 7 stays on the blind path even when enforcement is on (feed votes).
	feedVote := tokenless(7, pk)
	if reject, msg := m.RejectEvent(context.Background(), feedVote); reject {
		t.Fatalf("untagged kind 7 must stay on the legacy path (blindRequired off here): %s", msg)
	}
}

// DM gift wraps: dark ⇒ PoW-only exactly as before; enforced ⇒ the wrap must ALSO carry space
// tokens (proofs bound to the wrap's own ephemeral pubkey) and still pass PoW.
func TestSpaceTokensGiftWrap(t *testing.T) {
	// Ephemeral wrap key, like the client's mineGiftWrap.
	_, wrapPk := holderKeypair(t)

	// Dark: a PoW-mined tokenless wrap admits (byte-identical to today).
	dark, _, _ := spaceMembership(t, wrapPk, false)
	plain := tokenless(1059, wrapPk)
	mineSpacePoW(t, plain, 8)
	if reject, msg := dark.RejectEvent(context.Background(), plain); reject {
		t.Fatalf("dark mode: PoW-mined wrap must admit: %s", msg)
	}

	// Enforced: tokenless wrap is refused…
	m, _, spaceSk := spaceMembership(t, wrapPk, true)
	bare := tokenless(1059, wrapPk)
	mineSpacePoW(t, bare, 8)
	if reject, msg := m.RejectEvent(context.Background(), bare); !reject || !strings.Contains(msg, codeSpaceTokenRequired) {
		t.Fatalf("enforced: tokenless wrap must need a space token, got reject=%v msg=%s", reject, msg)
	}
	// …and a token-carrying wrap admits (tokens verified + spent, then PoW).
	paid := spaceEvent(t, spaceSk, 1059, wrapPk, 1)
	mineSpacePoW(t, paid, 8)
	if reject, msg := m.RejectEvent(context.Background(), paid); reject {
		t.Fatalf("enforced: space-token wrap must admit: %s", msg)
	}
}

// A non-member (unbound pubkey) cannot buy their way into a space with valid tokens — the
// bound-npub admission still runs after the token gate (tokens are additive, never a bypass).
func TestSpaceTokensNoMembershipBypass(t *testing.T) {
	pk := memberPubkey(t)
	stranger := memberPubkey(t)
	m, _, spaceSk := spaceMembership(t, pk, true)
	ev := spaceEvent(t, spaceSk, 9, stranger, 1)
	if reject, msg := m.RejectEvent(context.Background(), ev); !reject || !strings.Contains(msg, codeNotAMember) {
		t.Fatalf("valid tokens must not bypass membership, got reject=%v msg=%s", reject, msg)
	}
}
