package policy

// Finding F1: a token must be committed to the spent-set ONLY after every reject hook has passed.
// Before the fix the membership hook spent the token inline (gateSpaceTokens / handleBlindPost), so a
// later reject (admitAttributed, organizer, ratelimit, group) abandoned a spent token on an event the
// relay never stored. The fix splits each gate into VerifyEvent (verify, no spend — the membership
// hook) and CommitSpend (the FINAL reject hook). These tests drive the REAL post-verify hooks in the
// relay's order (mirroring relay.go, minus signature/weight) and assert the token survives whenever a
// middle hook rejects — for BOTH the space (attributed) and post (blind) domains. The ratelimit
// surface lives in a sibling relayapp test (the limiter package can't be imported here without a cycle).

import (
	"context"
	"crypto/rsa"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/groups"
	"github.com/stiq/relay/internal/membership"
)

// f1SpaceMembership mirrors spaceMembership but RETAINS the store so a test can assert spent-ness.
// The member is bound; space-write enforcement is on with a dedicated space issuer key.
func f1SpaceMembership(t *testing.T, boundPubkey string) (*Membership, *membership.MemStore, *rsa.PrivateKey) {
	t.Helper()
	generalSk := testIssuer(t)
	store := membership.NewMemStore()
	if err := store.Bind("bound-credential-id", boundPubkey); err != nil {
		t.Fatalf("bind: %v", err)
	}
	kinds := append(append([]int{}, gateKinds...), 9, 11, 12)
	m := NewMembership([]*rsa.PublicKey{&generalSk.PublicKey}, store, kinds, 8, 0)
	spaceSk := testIssuer(t)
	m.SetSpaceWriteIssuers([]*rsa.PublicKey{&spaceSk.PublicKey})
	m.SetSpaceTokensRequired(true)
	return m, store, spaceSk
}

// f1AnySpent reports whether ANY of the event's distinct tokens is in the spent-set. Uses the same
// distinctTokenIDs the commit phase spends, so it sees exactly what CommitSpend would have burned.
func f1AnySpent(store *membership.MemStore, event *nostr.Event) bool {
	for _, id := range distinctTokenIDs(event) {
		if store.IsSpent(id) {
			return true
		}
	}
	return false
}

// f1Stage is one post-verify reject hook plus its name, so a failing chain can report where it stopped.
type f1Stage struct {
	name string
	hook func(context.Context, *nostr.Event) (bool, string)
}

// f1RunChain replays the relay's reject-hook sequence after signature+weight (relay.go): the
// membership VERIFY hook, then the ordered post-verify hooks, then the token COMMIT hook — stopping at
// the FIRST reject exactly like khatru (adding.go / ephemeral.go). It returns the stage that rejected
// ("membership"/<name>/"commit") or "" if the event was fully admitted (committed). This is the exact
// short-circuit that makes the F1 invariant hold: a reject in any middle stage skips CommitSpend.
func f1RunChain(m *Membership, stages []f1Stage, event *nostr.Event) (stage, msg string) {
	ctx := context.Background()
	if reject, msg := m.VerifyEvent(ctx, event); reject {
		return "membership", msg
	}
	for _, s := range stages {
		if reject, msg := s.hook(ctx, event); reject {
			return s.name, msg
		}
	}
	if reject, msg := m.CommitSpend(ctx, event); reject {
		return "commit", msg
	}
	return "", ""
}

// emptyGroupGuard builds a GroupGuard over an EMPTY group store, so any group chat event names an
// unknown group and is rejected — the simplest real GroupGuard reject, needing no group setup.
func emptyGroupGuard() *GroupGuard {
	return NewGroupGuard(groups.NewStore(), "", "", nil, nil, nil)
}

// --- The split itself: VerifyEvent never spends; CommitSpend does. Both domains. --------------------

func TestF1VerifyEventDoesNotSpendCommitDoes(t *testing.T) {
	ctx := context.Background()

	t.Run("blind post", func(t *testing.T) {
		sk := testIssuer(t)
		store := membership.NewMemStore()
		m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, store, []int{1}, 8, 0)
		cred := mintCred(t, sk)
		ev := blindEvent(1, cred)
		id := membership.TokenID(cred.Token)

		if reject, msg := m.VerifyEvent(ctx, ev); reject {
			t.Fatalf("verify must pass a valid blind post: %s", msg)
		}
		if store.IsSpent(id) {
			t.Fatal("VerifyEvent must NOT spend the blind token (spend is deferred to CommitSpend)")
		}
		if reject, msg := m.CommitSpend(ctx, ev); reject {
			t.Fatalf("commit must succeed after a passing verify: %s", msg)
		}
		if !store.IsSpent(id) {
			t.Fatal("CommitSpend must spend the blind token")
		}
	})

	t.Run("space content", func(t *testing.T) {
		pk := memberPubkey(t)
		m, store, spaceSk := f1SpaceMembership(t, pk)
		ev := spaceEvent(t, spaceSk, 9, pk, 1)

		if reject, msg := m.VerifyEvent(ctx, ev); reject {
			t.Fatalf("verify must pass a valid space message: %s", msg)
		}
		if f1AnySpent(store, ev) {
			t.Fatal("VerifyEvent must NOT spend the space token (spend is deferred to CommitSpend)")
		}
		if reject, msg := m.CommitSpend(ctx, ev); reject {
			t.Fatalf("commit must succeed after a passing verify: %s", msg)
		}
		if !f1AnySpent(store, ev) {
			t.Fatal("CommitSpend must spend the space token")
		}
	})
}

// --- (a) token NOT consumed when a post-verify hook rejects, both domains --------------------------

// admitAttributed reject (space): a stranger's space message with VALID tokens passes the token
// verify but is refused by admitAttributed (not a member) — inside the membership hook, AFTER
// gateSpaceTokens. The token must not be consumed. (Under the old inline spend it was burned first.)
func TestF1SpaceTokenNotSpentWhenAdmitAttributedRejects(t *testing.T) {
	member := memberPubkey(t)
	stranger := memberPubkey(t) // valid pubkey, never bound
	m, store, spaceSk := f1SpaceMembership(t, member)
	ev := spaceEvent(t, spaceSk, 9, stranger, 1) // valid tokens, signed by the non-member

	stage, msg := f1RunChain(m, nil, ev)
	if stage != "membership" || !strings.Contains(msg, codeNotAMember) {
		t.Fatalf("expected a not-a-member reject in the membership hook, got stage=%q msg=%s", stage, msg)
	}
	if f1AnySpent(store, ev) {
		t.Fatal("F1: a valid space token must NOT be consumed when admitAttributed rejects")
	}
}

// organizer reject (post): a blind post that exceeds the organizer's note max is refused by the
// organizer hook, which runs AFTER the membership verify. The blind token must not be consumed.
func TestF1BlindTokenNotSpentWhenOrganizerRejects(t *testing.T) {
	sk := testIssuer(t)
	store := membership.NewMemStore()
	m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, store, []int{1}, 8, 0)

	const orgPk = "organizer-pubkey"
	holder := NewConfigHolder([]string{orgPk})
	rules := &nostr.Event{
		Kind: KindAppData, PubKey: orgPk, CreatedAt: nostr.Now(),
		Tags:    nostr.Tags{{"d", "stiq:post-rules"}},
		Content: `{"note":{"mn":0,"mx":5},"article":{"mn":0,"mx":0}}`,
	}
	rules.ID = rules.GetID()
	if reject, msg := holder.RejectEvent(context.Background(), rules); reject {
		t.Fatalf("organizer post-rules publish must be accepted: %s", msg)
	}

	cred := mintCred(t, sk)
	ev := blindEvent(1, cred)
	ev.Content = "way over the five-character note limit"
	ev.ID = ev.GetID()

	stage, msg := f1RunChain(m, []f1Stage{{"organizer", holder.RejectEvent}}, ev)
	if stage != "organizer" || !strings.Contains(msg, codeContentTooLong) {
		t.Fatalf("expected an organizer content-too-long reject, got stage=%q msg=%s", stage, msg)
	}
	if store.IsSpent(membership.TokenID(cred.Token)) {
		t.Fatal("F1: a valid blind token must NOT be consumed when the organizer hook rejects")
	}
}

// group reject (space): a group chat message for an UNKNOWN group passes the token verify + the
// organizer hook but is refused by the GroupGuard, which runs LAST before the commit. The space
// token must not be consumed — this is exactly the mid-flight kick/close race the old comment
// admitted was unpaid-for.
func TestF1SpaceTokenNotSpentWhenGroupRejects(t *testing.T) {
	member := memberPubkey(t)
	m, store, spaceSk := f1SpaceMembership(t, member)
	gg := emptyGroupGuard()
	ev := spaceEvent(t, spaceSk, 9, member, 1, nostr.Tag{"h", "no-such-group"})

	stage, msg := f1RunChain(m, []f1Stage{{"group", gg.RejectEvent}}, ev)
	if stage != "group" || !strings.Contains(msg, codeUnknownGroup) {
		t.Fatalf("expected a GroupGuard unknown-group reject, got stage=%q msg=%s", stage, msg)
	}
	if f1AnySpent(store, ev) {
		t.Fatal("F1: a valid space token must NOT be consumed when the group hook rejects")
	}
}

// The positive control: with NO middle hook rejecting, the same space message runs the full chain
// through CommitSpend and the token IS consumed — proving the tests above fail for the right reason
// (a real reject preventing the commit), not because the token was never spendable.
func TestF1SpaceTokenConsumedWhenChainFullyPasses(t *testing.T) {
	member := memberPubkey(t)
	m, store, spaceSk := f1SpaceMembership(t, member)
	ev := spaceEvent(t, spaceSk, 9, member, 1) // no h tag → not routed to GroupGuard's chat path

	if stage, msg := f1RunChain(m, nil, ev); stage != "" {
		t.Fatalf("a fully-valid space message must be admitted end-to-end, got stage=%q msg=%s", stage, msg)
	}
	if !f1AnySpent(store, ev) {
		t.Fatal("a fully-admitted space message must have its token committed by CommitSpend")
	}
}

// --- (b) two concurrent same-token DISTINCT events → exactly one committed, the rest ErrTokenSpent --

func TestF1ConcurrentSameTokenExactlyOnce(t *testing.T) {
	const n = 32

	run := func(t *testing.T, m *Membership, events []*nostr.Event) {
		var (
			wg       sync.WaitGroup
			start    = make(chan struct{})
			admitted atomic.Int64
			spent    atomic.Int64
		)
		for _, ev := range events {
			wg.Add(1)
			go func(ev *nostr.Event) {
				defer wg.Done()
				<-start
				// The full gate = VerifyEvent + CommitSpend, exactly what the relay's two hooks do in
				// sequence. Both events pass verify; they serialize at the commit.
				reject, msg := m.RejectEvent(context.Background(), ev)
				if !reject {
					admitted.Add(1)
				} else if strings.Contains(msg, codeTokenSpent) {
					spent.Add(1)
				}
			}(ev)
		}
		close(start)
		wg.Wait()
		if admitted.Load() != 1 {
			t.Fatalf("exactly one same-token event must be committed, got %d", admitted.Load())
		}
		if spent.Load() != n-1 {
			t.Fatalf("the other %d must be rejected as already-spent, got %d", n-1, spent.Load())
		}
	}

	t.Run("blind post", func(t *testing.T) {
		sk := testIssuer(t)
		m := newTokenMembership(sk)
		cred := mintCred(t, sk)
		events := make([]*nostr.Event, n)
		for i := range events {
			ev := blindEvent(1, cred)
			ev.Content = strconv.Itoa(i) // distinct id, one shared token
			ev.ID = ev.GetID()
			events[i] = ev
		}
		run(t, m, events)
	})

	t.Run("space content", func(t *testing.T) {
		pk := memberPubkey(t)
		m, _, spaceSk := f1SpaceMembership(t, pk)
		base := spaceEvent(t, spaceSk, 9, pk, 1)
		events := make([]*nostr.Event, n)
		for i := range events {
			// Same token + same holder proof (both bound to pk), distinct content → distinct id.
			ev := &nostr.Event{Kind: 9, PubKey: pk, Content: strconv.Itoa(i), Tags: base.Tags}
			ev.ID = ev.GetID()
			events[i] = ev
		}
		run(t, m, events)
	})
}

// --- (c) same-event retry → idempotent, never double-charged, both domains ------------------------

func TestF1SameEventRetryIdempotent(t *testing.T) {
	ctx := context.Background()

	t.Run("blind post", func(t *testing.T) {
		sk := testIssuer(t)
		store := membership.NewMemStore()
		m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, store, []int{1}, 8, 0)
		cred := mintCred(t, sk)
		ev := blindEvent(1, cred)

		if reject, msg := m.RejectEvent(ctx, ev); reject {
			t.Fatalf("first admit must succeed: %s", msg)
		}
		if reject, msg := m.RejectEvent(ctx, ev); reject {
			t.Fatalf("re-publishing the exact same event must be idempotent (OK-frame-lost retry): %s", msg)
		}
		// Not double-charged: a DIFFERENT event reusing the token is still refused as spent.
		other := blindEvent(1, cred)
		other.Content = "different"
		other.ID = other.GetID()
		if reject, msg := m.RejectEvent(ctx, other); !reject || !strings.Contains(msg, codeTokenSpent) {
			t.Fatalf("the token must be spent exactly once, got reject=%v msg=%s", reject, msg)
		}
	})

	t.Run("space content", func(t *testing.T) {
		pk := memberPubkey(t)
		m, store, spaceSk := f1SpaceMembership(t, pk)
		ev := spaceEvent(t, spaceSk, 9, pk, 1)

		if reject, msg := m.RejectEvent(ctx, ev); reject {
			t.Fatalf("first admit must succeed: %s", msg)
		}
		if !f1AnySpent(store, ev) {
			t.Fatal("token should be committed after the first admit")
		}
		if reject, msg := m.RejectEvent(ctx, ev); reject {
			t.Fatalf("re-publishing the exact same space event must be idempotent: %s", msg)
		}
		reused := &nostr.Event{Kind: 9, PubKey: pk, Content: "again", Tags: ev.Tags}
		reused.ID = reused.GetID()
		if reject, msg := m.RejectEvent(ctx, reused); !reject || !strings.Contains(msg, codeTokenSpent) {
			t.Fatalf("the space token must be spent exactly once, got reject=%v msg=%s", reject, msg)
		}
	})
}
