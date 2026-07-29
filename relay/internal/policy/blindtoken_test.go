package policy

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/membership"
)

func testIssuer(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	sk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen issuer key: %v", err)
	}
	return sk
}

// mintCred runs the real blind flow to produce a credential the relay will accept.
func mintCred(t *testing.T, sk *rsa.PrivateKey) membership.Credential {
	t.Helper()
	tok := make([]byte, 32)
	if _, err := rand.Read(tok); err != nil {
		t.Fatalf("rand token: %v", err)
	}
	cred, err := membership.RequestCredential(&sk.PublicKey, tok, membership.NewIssuer(sk).BlindSign)
	if err != nil {
		t.Fatalf("RequestCredential: %v", err)
	}
	return cred
}

// blindEvent builds a content event that carries a per-post token, as a client would. The
// throwaway signature is verified by a separate hook (RequireValidSignature), not the token gate
// under test, so an unsigned event with a placeholder pubkey is sufficient here.
func blindEvent(kind int, cred membership.Credential) *nostr.Event {
	event := &nostr.Event{
		Kind:    kind,
		PubKey:  "throwaway",
		Content: "hi",
		Tags: nostr.Tags{
			{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
			{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)},
		},
	}
	event.ID = event.GetID()
	return event
}

func newTokenMembership(sk *rsa.PrivateKey) *Membership {
	return NewMembership([]*rsa.PublicKey{&sk.PublicKey}, membership.NewMemStore(), []int{1, 1111}, 8, 0)
}

// TestBlindTokenPathConfinedToBlindContentKinds: a client must not be able to attach a token to an
// ATTRIBUTABLE allow-listed kind (channel 42, live-chat 1311) to slip it past the per-npub rate
// limiter + client moderation while staying unattributable. Since tokens-everywhere, token-bearing
// space kinds route to the SPACE gate, which (with no space-write keys configured) rejects them —
// the same evasion stays closed, now with the space-gate's rejection. A non-space, non-blind kind
// with a token would still hit handleBlindPost's own kind gate.
// (hardening: token-kind rate-limit/moderation evasion)
func TestBlindTokenPathConfinedToBlindContentKinds(t *testing.T) {
	sk := testIssuer(t)
	// Allow-list INCLUDES 42 + 1311 so they pass the allow-list check and reach the token-routing
	// gates under test (not the earlier generic "kind not permitted").
	m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, membership.NewMemStore(), []int{1, 42, 1311, 1111}, 8, 0)

	for _, kind := range []int{42, 1311} {
		reject, msg := m.RejectEvent(context.Background(), blindEvent(kind, mintCred(t, sk)))
		if !reject {
			t.Fatalf("token-bearing attributable kind %d must be rejected off the blind path", kind)
		}
		if !strings.Contains(msg, "does not accept tokens here") {
			t.Fatalf("kind %d rejected for the wrong reason: %s", kind, msg)
		}
	}

	// Control: a legitimate blind-content kind (1) still passes the kind gate and is admitted — the
	// fix must not break real posting.
	if reject, msg := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, sk))); reject {
		t.Fatalf("token-bearing kind 1 (a real blind post) must still be admitted: %s", msg)
	}
}

func TestBlindPostExactRetryAdmittedButTokenReuseRejected(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	cred := mintCred(t, sk)
	event := blindEvent(1, cred)

	if reject, msg := m.RejectEvent(context.Background(), event); reject {
		t.Fatalf("first blind post should be admitted: %s", msg)
	}
	if reject, msg := m.RejectEvent(context.Background(), event); reject {
		t.Fatalf("the exact event must be retryable after a lost OK frame: %s", msg)
	}

	different := blindEvent(1, cred)
	different.Content = "different post"
	different.ID = different.GetID()
	if reject, _ := m.RejectEvent(context.Background(), different); !reject {
		t.Fatal("the same token must not pay for a different event")
	}
}

// TestConcurrentBlindPostSpentOnce drives the full policy path under contention: N goroutines
// submit the same token concurrently through RejectEvent. Exactly one must be admitted; the rest
// must be rejected. This is the end-to-end double-spend guard — the store's compare-and-set plus
// the policy layer mapping ErrTokenSpent to a rejection must let a token through exactly once.
func TestConcurrentBlindPostSpentOnce(t *testing.T) {
	const n = 48
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	cred := mintCred(t, sk)
	events := make([]*nostr.Event, n)
	for i := range events {
		events[i] = blindEvent(1, cred)
		events[i].Content = strconv.Itoa(i)
		events[i].ID = events[i].GetID()
	}

	var (
		wg       sync.WaitGroup
		start    = make(chan struct{})
		admitted atomic.Int64
	)
	for i := range events {
		wg.Add(1)
		go func(event *nostr.Event) {
			defer wg.Done()
			<-start
			if reject, _ := m.RejectEvent(context.Background(), event); !reject {
				admitted.Add(1)
			}
		}(events[i])
	}
	close(start)
	wg.Wait()

	if got := admitted.Load(); got != 1 {
		t.Fatalf("expected the token to be admitted exactly once, got %d", got)
	}
}

func TestConcurrentExactBlindPostRetriesAllAdmitted(t *testing.T) {
	const n = 48
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	event := blindEvent(1, mintCred(t, sk))

	var (
		wg       sync.WaitGroup
		start    = make(chan struct{})
		admitted atomic.Int64
	)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if reject, _ := m.RejectEvent(context.Background(), event); !reject {
				admitted.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()

	if got := admitted.Load(); got != n {
		t.Fatalf("all exact retries should be admitted, got %d of %d", got, n)
	}
}

// TestMembershipBindingRequiresBindingIssuer: with a DEDICATED binding-issuer key configured, a
// per-post token (signed by the general issuer) must NOT satisfy a kind-9011 membership binding —
// token domain separation, finding #16. A credential from the binding issuer still binds.
func TestMembershipBindingRequiresBindingIssuer(t *testing.T) {
	postIssuer := testIssuer(t) // general per-post/read/draw token issuer
	bindIssuer := testIssuer(t) // dedicated enrollment/binding credential issuer
	m := NewMembership([]*rsa.PublicKey{&postIssuer.PublicKey}, membership.NewMemStore(),
		[]int{1, KindMembershipBinding}, 8, 0)
	m.SetBindingIssuers([]*rsa.PublicKey{&bindIssuer.PublicKey})

	// A plentiful posting token presented inside a binding event must be rejected.
	if reject, _ := m.RejectEvent(context.Background(), blindEvent(KindMembershipBinding, mintCred(t, postIssuer))); !reject {
		t.Fatal("a posting token must not satisfy a membership binding once binding issuers are separated (finding #16)")
	}
	// A real enrollment credential (binding issuer) binds.
	if reject, msg := m.RejectEvent(context.Background(), blindEvent(KindMembershipBinding, mintCred(t, bindIssuer))); reject {
		t.Fatalf("a credential from the binding issuer must bind: %s", msg)
	}
}

// TestMembershipBindingFallsBackWithoutBindingIssuer: with no dedicated binding issuer configured,
// binding verifies against the general issuers (backward compatible / ships dark).
func TestMembershipBindingFallsBackWithoutBindingIssuer(t *testing.T) {
	sk := testIssuer(t)
	m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, membership.NewMemStore(), []int{KindMembershipBinding}, 8, 0)
	if reject, msg := m.RejectEvent(context.Background(), blindEvent(KindMembershipBinding, mintCred(t, sk))); reject {
		t.Fatalf("without a separate binding issuer the general issuer must still bind: %s", msg)
	}
}

// TestBlindPostRequiresPostingIssuer: with a DEDICATED posting-issuer key configured, a token signed
// by the general issuer must NOT satisfy a per-post blind post — the posting half of token domain
// separation, finding #16 / S3. A token from the posting issuer still posts.
func TestBlindPostRequiresPostingIssuer(t *testing.T) {
	generalIssuer := testIssuer(t) // general issuer (e.g. binding/enrollment)
	postIssuer := testIssuer(t)    // dedicated per-post token issuer
	m := NewMembership([]*rsa.PublicKey{&generalIssuer.PublicKey}, membership.NewMemStore(), []int{1}, 8, 0)
	m.SetPostingIssuers([]*rsa.PublicKey{&postIssuer.PublicKey})

	// A token from the general issuer must NOT post once posting issuers are separated.
	if reject, _ := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, generalIssuer))); !reject {
		t.Fatal("a general-issuer token must not post once posting issuers are separated (S3)")
	}
	// A token from the dedicated posting issuer posts.
	if reject, msg := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, postIssuer))); reject {
		t.Fatalf("a token from the posting issuer must be admitted: %s", msg)
	}
}

// TestBlindPostFallsBackWithoutPostingIssuer: with no dedicated posting issuer configured (the
// default), posting verifies against the general issuers — backward compatible / ships dark (S3).
func TestBlindPostFallsBackWithoutPostingIssuer(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk) // no SetPostingIssuers → falls back to the general issuer
	if reject, msg := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, sk))); reject {
		t.Fatalf("without a separate posting issuer the general issuer must still post: %s", msg)
	}
}

// TestBlindPostRepeatedTokenDedupedBeforeVerify: the same valid token repeated far beyond the
// distinct-token cap must dedup to ONE distinct token (one verification, one unit of cost) and be
// admitted — proving repeated tokens can't force a full RSA verification per copy (findings #36/#73).
func TestBlindPostRepeatedTokenDedupedBeforeVerify(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	cred := mintCred(t, sk)
	ev := &nostr.Event{Kind: 1, PubKey: "throwaway", Content: "x"}
	for i := 0; i < maxTokenPairsPerEvent*2; i++ {
		ev.Tags = append(ev.Tags,
			nostr.Tag{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
			nostr.Tag{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)})
	}
	ev.ID = ev.GetID()
	if reject, msg := m.RejectEvent(context.Background(), ev); reject {
		t.Fatalf("a repeated valid token must dedup to one distinct token and be admitted, not rejected: %s", msg)
	}
}

func TestBlindPostFromWrongIssuerRejected(t *testing.T) {
	sk := testIssuer(t)
	other := testIssuer(t)
	m := newTokenMembership(sk)
	// A credential signed by a different issuer must not verify.
	if reject, _ := m.RejectEvent(context.Background(), blindEvent(1, mintCred(t, other))); !reject {
		t.Fatal("token from the wrong issuer should be rejected")
	}
}

func TestBlindPostDisallowedKindRejected(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk) // only kinds 1 and 1111 are allow-listed
	if reject, _ := m.RejectEvent(context.Background(), blindEvent(9999, mintCred(t, sk))); !reject {
		t.Fatal("a blind post of a non-allowed kind should be rejected")
	}
}

func TestNonMemberWithoutTokenRejected(t *testing.T) {
	sk := testIssuer(t)
	m := newTokenMembership(sk)
	ev := &nostr.Event{Kind: 1, PubKey: "stranger", Content: "spam", Tags: nostr.Tags{}}
	if reject, _ := m.RejectEvent(context.Background(), ev); !reject {
		t.Fatal("a non-member note carrying no token must be rejected")
	}
}

// A blind post never binds an npub: the store records the token spent but no membership, so the
// relay learns nothing about the author.
func TestBlindPostBindsNoNpub(t *testing.T) {
	sk := testIssuer(t)
	store := membership.NewMemStore()
	m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, store, []int{1}, 8, 0)
	ev := blindEvent(1, mintCred(t, sk))
	if reject, msg := m.RejectEvent(context.Background(), ev); reject {
		t.Fatalf("blind post should be admitted: %s", msg)
	}
	if store.IsBound(ev.PubKey) {
		t.Fatal("a blind post must not bind its throwaway pubkey")
	}
}

// TestSpareBindingCredentialIsBurned (R2c). handleBinding's already-bound fast path used to return
// BEFORE store.Bind, so the credential a re-presenting device offered was accepted and never spent.
// A member holding a SECOND organizer-issued invite could therefore bind once, re-present the spare
// (accepted, unburned), and keep it fully usable to mint ANOTHER npub later — precisely the
// one-npub-per-invite scarcity the member roll rests on.
func TestSpareBindingCredentialIsBurned(t *testing.T) {
	issuer := testIssuer(t)
	store := membership.NewMemStore()
	m := NewMembership([]*rsa.PublicKey{&issuer.PublicKey}, store, []int{KindMembershipBinding}, 8, 0)

	// Alice binds with her first invite.
	first := blindEvent(KindMembershipBinding, mintCred(t, issuer))
	first.PubKey = "alice"
	if reject, msg := m.RejectEvent(context.Background(), first); reject {
		t.Fatalf("first binding must succeed: %s", msg)
	}

	// She presents a SPARE credential. She is already bound, so this changes nothing for her — and
	// must still be admitted (an idempotent re-bind is a normal lost-OK-frame retry, not an attack).
	spare := mintCred(t, issuer)
	replay := blindEvent(KindMembershipBinding, spare)
	replay.PubKey = "alice"
	if reject, msg := m.RejectEvent(context.Background(), replay); reject {
		t.Fatalf("an already-bound member re-presenting a credential must still be admitted: %s", msg)
	}

	// The spare is now BURNED: a fresh npub cannot mint an account with it.
	sock := blindEvent(KindMembershipBinding, spare)
	sock.PubKey = "alice-sockpuppet"
	if reject, _ := m.RejectEvent(context.Background(), sock); !reject {
		t.Fatal("a spare credential presented by an already-bound member must be spent, not left reusable (R2c)")
	}
	if store.IsBound("alice-sockpuppet") {
		t.Fatal("the sock puppet must never have been bound")
	}
	if !store.IsBound("alice") {
		t.Fatal("alice must remain bound throughout")
	}
}

// The re-bind above must not cost the member their seniority: boundAt drives the organizer's
// newcomer window (no links, no channel creation for the first N days), so stamping it again would
// silently demote an established member back to newcomer.
func TestReBindPreservesBoundAtSeniority(t *testing.T) {
	issuer := testIssuer(t)
	store := membership.NewMemStore()
	m := NewMembership([]*rsa.PublicKey{&issuer.PublicKey}, store, []int{KindMembershipBinding}, 8, 0)

	first := blindEvent(KindMembershipBinding, mintCred(t, issuer))
	first.PubKey = "veteran"
	if reject, msg := m.RejectEvent(context.Background(), first); reject {
		t.Fatalf("first binding must succeed: %s", msg)
	}
	original, ok := store.BoundAt("veteran")
	if !ok {
		t.Fatal("a bound member must have a boundAt stamp")
	}

	replay := blindEvent(KindMembershipBinding, mintCred(t, issuer))
	replay.PubKey = "veteran"
	if reject, msg := m.RejectEvent(context.Background(), replay); reject {
		t.Fatalf("re-bind must be admitted: %s", msg)
	}

	if after, _ := store.BoundAt("veteran"); after != original {
		t.Errorf("boundAt moved %d → %d on re-bind; the member would be demoted to newcomer", original, after)
	}
}
