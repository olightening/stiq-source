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

// blindEventN builds a content event carrying N per-post token pairs (a weight-priced post), as a
// client would. Signature verification is a separate hook, so a placeholder pubkey is fine here.
func blindEventN(kind int, content string, creds ...membership.Credential) *nostr.Event {
	tags := nostr.Tags{}
	for _, c := range creds {
		tags = append(tags,
			nostr.Tag{"stiq_token", base64.StdEncoding.EncodeToString(c.Token)},
			nostr.Tag{"stiq_sig", base64.StdEncoding.EncodeToString(c.Signature)},
		)
	}
	event := &nostr.Event{Kind: kind, PubKey: "throwaway", Content: content, Tags: tags}
	event.ID = event.GetID()
	return event
}

// TestChargeableParity pins the exact UTF-8 byte counts SHARED with the client parity test
// (client/src/blind/tokenCost.test.ts FIXTURES). Both implementations MUST agree on these numbers,
// or a bytesPerToken>0 relay rejects honest non-ASCII posts (Arabic/emoji) as under-paid. len() here
// is Go bytes (UTF-8); the client must measure UTF-8 byte length, NOT JS String.length (UTF-16).
func TestChargeableParity(t *testing.T) {
	cases := []struct {
		content string
		tags    nostr.Tags
		want    int
	}{
		{"hi", nil, 2},
		{"café", nil, 5},                   // é = 2 bytes
		{"😀", nil, 4},                      // emoji = 4 bytes
		{"مرحبا", nil, 10},                 // 5 Arabic letters × 2 bytes
		{"", nostr.Tags{{"t", "news"}}, 7}, // (1+1)+(4+1)
		{"x", nostr.Tags{{"stiq_token", "AAAA"}, {"stiq_sig", "BBBB"}, {"t", "hi"}}, 6}, // token tags excluded
		{"مرحبا😀", nostr.Tags{{"stiq_attr", "zz"}}, 27},                                 // (10+4)+((9+1)+(2+1))
		// P3: stiq_spend (the holder-bound spend proof) must be excluded exactly like stiq_token/
		// stiq_sig — crypto red-team mustFix #1 (the circularity trap for multi-token posts).
		{"x", nostr.Tags{{"stiq_token", "AAAA"}, {"stiq_sig", "BBBB"}, {"stiq_spend", "CCCC"}, {"t", "hi"}}, 6},
	}
	for i, c := range cases {
		if got := chargeableSize(&nostr.Event{Content: c.content, Tags: c.tags}); got != c.want {
			t.Errorf("case %d (%q): chargeableSize=%d want %d", i, c.content, got, c.want)
		}
	}
}

func TestTokenCostFormula(t *testing.T) {
	long := &nostr.Event{Content: strings.Repeat("a", 25)}
	// Disabled (<=0) → always exactly one token, regardless of size (dark / back-compat).
	if got := TokenCost(long, 0); got != 1 {
		t.Fatalf("bytesPerToken=0 must cost 1, got %d", got)
	}
	if got := TokenCost(long, -5); got != 1 {
		t.Fatalf("negative bytesPerToken must cost 1, got %d", got)
	}
	// Floor of one for an empty/tiny event.
	if got := TokenCost(&nostr.Event{Content: ""}, 100); got != 1 {
		t.Fatalf("empty event floors at 1 token, got %d", got)
	}
	// Ceil division: 25 bytes / 10 = 3 tokens.
	if got := TokenCost(long, 10); got != 3 {
		t.Fatalf("ceil(25/10)=3, got %d", got)
	}
	// The stiq_token / stiq_sig tags must NOT inflate the price (the circularity trap): adding a
	// huge token tag leaves the cost unchanged.
	big := base64.StdEncoding.EncodeToString(make([]byte, 500))
	withTokens := &nostr.Event{Content: strings.Repeat("a", 25), Tags: nostr.Tags{
		{"stiq_token", big}, {"stiq_sig", big},
	}}
	if got := TokenCost(withTokens, 10); got != 3 {
		t.Fatalf("token tags must not price themselves, got %d", got)
	}
	// P3: a huge stiq_spend (holder-bound spend proof) tag must likewise not inflate the price —
	// without this a weight-priced multi-token holder-bound post is rejected codeTokenInsufficient
	// because the relay would charge for proof bytes the client never budgeted for.
	withSpend := &nostr.Event{Content: strings.Repeat("a", 25), Tags: nostr.Tags{
		{"stiq_token", big}, {"stiq_sig", big}, {"stiq_spend", big},
	}}
	if got := TokenCost(withSpend, 10); got != 3 {
		t.Fatalf("stiq_spend must not price itself, got %d", got)
	}
	// A NON-token tag DOES count: content "" + tag ["t","aaa…24"] = 2 + 25 = 27 bytes → ceil(27/10)=3.
	withTag := &nostr.Event{Content: "", Tags: nostr.Tags{{"t", strings.Repeat("a", 24)}}}
	if got := TokenCost(withTag, 10); got != 3 {
		t.Fatalf("non-token tags count toward weight, got %d", got)
	}
}

func TestWeightPricedAdmitsExactDistinctTokens(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	m.SetBytesPerToken(1) // 1 byte/token → an N-byte event needs N tokens
	ev := blindEventN(1, "abc", mintCred(t, sk), mintCred(t, sk), mintCred(t, sk))
	if reject, msg := m.RejectEvent(context.Background(), ev); reject {
		t.Fatalf("3 distinct valid tokens for a 3-byte event should be admitted: %s", msg)
	}
}

// THE BLOCKER: a client attaches ONE valid token repeated N times to fake a cost of N. The relay
// must dedupe by token id and reject, or "pay by size" collapses to "pay one token for any size".
func TestWeightPricedRejectsSameTokenRepeated(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	m.SetBytesPerToken(1)
	c := mintCred(t, sk)
	if reject, _ := m.RejectEvent(context.Background(), blindEventN(1, "abc", c, c, c)); !reject {
		t.Fatal("repeating one token to satisfy a cost of 3 must be rejected")
	}
}

func TestWeightPricedRejectsUnderpaid(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	m.SetBytesPerToken(1)
	// need 3, present 2 distinct valid tokens → reject.
	if reject, _ := m.RejectEvent(context.Background(), blindEventN(1, "abc", mintCred(t, sk), mintCred(t, sk))); !reject {
		t.Fatal("an event carrying fewer tokens than its weight requires must be rejected")
	}
}

// Every presented pair is verified — a forged pair ANYWHERE (here from a different issuer) rejects
// the whole event, so an attacker can't pad the required count with junk tokens.
func TestWeightPricedVerifiesEveryPair(t *testing.T) {
	sk := testIssuer(t)
	other := testIssuer(t)
	m := newTokenMembership(sk)
	m.SetBytesPerToken(1)
	ev := blindEventN(1, "abc", mintCred(t, sk), mintCred(t, sk), mintCred(t, other))
	if reject, _ := m.RejectEvent(context.Background(), ev); !reject {
		t.Fatal("a forged/wrong-issuer token among valid ones must reject the whole event")
	}
}

// With weight-pricing disabled (default), a single token admits an event of ANY size — byte-for-byte
// the legacy behaviour, so the feature ships dark and old clients keep working.
func TestWeightPricingDisabledIsBackCompat(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk) // bytesPerToken defaults to 0
	ev := blindEventN(1, strings.Repeat("x", 10_000), mintCred(t, sk))
	if reject, msg := m.RejectEvent(context.Background(), ev); reject {
		t.Fatalf("disabled weight-pricing must admit any-size event on one token: %s", msg)
	}
}

// All-or-nothing: an event whose token set contains one already-spent token is rejected AND leaves
// its other (valid, unspent) tokens UNSPENT — so a rejected multi-token event never half-pays.
func TestWeightPricedSpendIsAllOrNothing(t *testing.T) {
	sk := testIssuer(t)
	store := membership.NewMemStore()
	m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, store, []int{1}, 8, 0)
	m.SetBytesPerToken(1)
	a, b := mintCred(t, sk), mintCred(t, sk)
	if err := store.Spend(membership.TokenID(b.Token)); err != nil {
		t.Fatalf("pre-spend b: %v", err)
	}
	// 2-byte event needs 2 tokens; present [a(unspent), b(spent)] → reject.
	if reject, _ := m.RejectEvent(context.Background(), blindEventN(1, "ab", a, b)); !reject {
		t.Fatal("event reusing an already-spent token must be rejected")
	}
	if store.IsSpent(membership.TokenID(a.Token)) {
		t.Fatal("all-or-nothing: token a must NOT be consumed when the batch is rejected")
	}
}
