package policy

import (
	"context"
	"strings"
	"testing"

	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/groups"
)

const (
	gOwner  = "1111111111111111111111111111111111111111111111111111111111111111"
	gMember = "2222222222222222222222222222222222222222222222222222222222222222"
	gRando  = "3333333333333333333333333333333333333333333333333333333333333333"
)

func tag(name string, rest ...string) nostr.Tag {
	return nostr.Tag(append([]string{name}, rest...))
}

// newGuard returns a guard plus a slice capturing every relay-emitted state event.
func newGuard() (*GroupGuard, *[]nostr.Event) {
	sk := nostr.GeneratePrivateKey()
	pk, _ := nostr.GetPublicKey(sk)
	emitted := &[]nostr.Event{}
	g := NewGroupGuard(groups.NewStore(), sk, pk, func(e *nostr.Event) {
		*emitted = append(*emitted, *e)
	}, nil, nil)
	return g, emitted
}

func reject(g *GroupGuard, e *nostr.Event) (bool, string) {
	return g.RejectEvent(context.Background(), e)
}

func TestCreateGroupEmitsSignedState(t *testing.T) {
	g, emitted := newGuard()
	if r, msg := reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1")}}); r {
		t.Fatalf("create should be accepted: %s", msg)
	}
	if len(*emitted) != 5 {
		t.Fatalf("expected 5 emitted state events, got %d", len(*emitted))
	}
	for _, e := range *emitted {
		if e.Sig == "" || e.ID == "" {
			t.Fatal("emitted state events must be signed")
		}
		if ok, _ := e.CheckSignature(); !ok {
			t.Fatal("emitted state event signature must verify")
		}
	}
}

// countKinds tallies emitted state events by kind.
func countKinds(events []nostr.Event) map[int]int {
	out := map[int]int{}
	for _, e := range events {
		out[e.Kind]++
	}
	return out
}

// TestEmitStateOnlyReSignsChangedKinds proves finding #59's fix: a management event that changes
// only the member set re-emits only the member-related state kinds (39002 members, and 39004
// pending since add clears a pending entry), not the unrelated metadata/admins/roles events.
func TestEmitStateOnlyReSignsChangedKinds(t *testing.T) {
	g, emitted := newGuard()

	// Create → all 5 base state kinds emitted once.
	reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("closed")}})
	if got := countKinds(*emitted); got[groups.KindMetadata] != 1 || len(*emitted) != 5 {
		t.Fatalf("create should emit the 5 base state kinds once, got %v", got)
	}
	*emitted = nil

	// A join to a closed group only adds a pending entry → only 39004 (pending) changes.
	reject(g, &nostr.Event{Kind: groups.KindJoinRequest, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}})
	got := countKinds(*emitted)
	if got[groups.KindPending] != 1 {
		t.Fatalf("join should re-emit the pending list (39004), got %v", got)
	}
	for _, unchanged := range []int{groups.KindMetadata, groups.KindAdmins, groups.KindRoles} {
		if got[unchanged] != 0 {
			t.Fatalf("kind %d must NOT be re-emitted by an unrelated join, got %v", unchanged, got)
		}
	}
	*emitted = nil

	// Admin adds the pending member → members(39002) gains a p tag AND pending(39004) loses it;
	// metadata/admins/roles are still unchanged and must not re-emit.
	reject(g, &nostr.Event{Kind: groups.KindAddUser, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("p", gMember)}})
	got = countKinds(*emitted)
	if got[groups.KindMembers] != 1 || got[groups.KindPending] != 1 {
		t.Fatalf("add-user should re-emit members + pending, got %v", got)
	}
	if got[groups.KindMetadata] != 0 || got[groups.KindAdmins] != 0 || got[groups.KindRoles] != 0 {
		t.Fatalf("add-user must not re-emit metadata/admins/roles, got %v", got)
	}
}

// TestSetInteractionsReEmitsOnlyOnePostState proves the O(N²) fix: toggling one post's gate
// re-emits only that post's 39005, not one 39005 per previously-gated post.
func TestSetInteractionsReEmitsOnlyOnePostState(t *testing.T) {
	g, emitted := newGuard()
	reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("broadcast")}})

	// Open comments on three distinct posts.
	for _, post := range []string{"postA", "postB", "postC"} {
		reject(g, &nostr.Event{Kind: groups.KindSetInteractions, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("e", post), tag("comments", "1"), tag("reactions", "0")}})
	}
	*emitted = nil

	// Re-toggle only postB → exactly one 39005 should re-emit (not three).
	reject(g, &nostr.Event{Kind: groups.KindSetInteractions, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("e", "postB"), tag("comments", "0"), tag("reactions", "1")}})
	got := countKinds(*emitted)
	if got[groups.KindPostState] != 1 {
		t.Fatalf("re-toggling one post must re-emit exactly one 39005, got %d (all: %v)", got[groups.KindPostState], got)
	}
}

// TestEmitStateMonotonicTimestamps proves same-second emissions still strictly increase per
// group, so ReplaceEvent (which breaks CreatedAt ties by id) never drops the newer state.
func TestEmitStateMonotonicTimestamps(t *testing.T) {
	g, emitted := newGuard()
	// Freeze the clock so both emissions want the same CreatedAt.
	g.now = func() nostr.Timestamp { return 1000 }

	reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("open")}})
	reject(g, &nostr.Event{Kind: groups.KindJoinRequest, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}})

	var members []nostr.Event
	for _, e := range *emitted {
		if e.Kind == groups.KindMembers {
			members = append(members, e)
		}
	}
	if len(members) < 2 {
		t.Fatalf("expected the member list to be re-emitted after the join, got %d", len(members))
	}
	first, second := members[0].CreatedAt, members[len(members)-1].CreatedAt
	if second <= first {
		t.Fatalf("second emission must have a strictly greater CreatedAt (got %d then %d)", first, second)
	}
}

func TestGroupChatMemberAdmitNonMemberReject(t *testing.T) {
	g, _ := newGuard()
	reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("closed")}})

	// Owner (a member) may chat.
	if r, msg := reject(g, &nostr.Event{Kind: groups.KindChat, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1")}}); r {
		t.Fatalf("owner chat should be accepted: %s", msg)
	}
	// A non-member may not.
	if r, _ := reject(g, &nostr.Event{Kind: groups.KindChat, PubKey: gRando, Tags: nostr.Tags{tag("h", "g1")}}); !r {
		t.Fatal("non-member chat must be rejected")
	}
}

func TestKickedUserCannotChat(t *testing.T) {
	g, _ := newGuard()
	reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1")}})
	reject(g, &nostr.Event{Kind: groups.KindAddUser, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("p", gMember)}})

	// Member can chat...
	if r, _ := reject(g, &nostr.Event{Kind: groups.KindChat, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}}); r {
		t.Fatal("member should be able to chat before the kick")
	}
	// ...owner kicks them...
	reject(g, &nostr.Event{Kind: groups.KindRemoveUser, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("p", gMember)}})
	// ...now their chat is rejected (this is the end-to-end proof the kick takes effect).
	if r, _ := reject(g, &nostr.Event{Kind: groups.KindChat, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}}); !r {
		t.Fatal("kicked user chat must be rejected")
	}
}

func TestChatToUnknownGroupRejected(t *testing.T) {
	g, _ := newGuard()
	if r, _ := reject(g, &nostr.Event{Kind: groups.KindChat, PubKey: gOwner, Tags: nostr.Tags{tag("h", "ghost")}}); !r {
		t.Fatal("chat to a non-existent group must be rejected")
	}
}

func TestMemberCannotForgeGroupState(t *testing.T) {
	g, _ := newGuard()
	reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1")}})
	// A member trying to publish a 39002 member-list must be rejected outright.
	if r, msg := reject(g, &nostr.Event{Kind: groups.KindMembers, PubKey: gOwner, Tags: nostr.Tags{tag("d", "g1")}}); !r {
		t.Fatalf("member-submitted group state must be rejected, got accept: %s", msg)
	}
}

func TestNonGroupEventPassesThrough(t *testing.T) {
	g, _ := newGuard()
	// A normal feed post (kind 1) is none of the guard's business.
	if r, _ := reject(g, &nostr.Event{Kind: 1, PubKey: gRando}); r {
		t.Fatal("non-group event must pass through the guard")
	}
}

func TestBroadcastGatesTopLevelPostsToAdmins(t *testing.T) {
	g, _ := newGuard()
	reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("broadcast"), tag("open")}})
	// gMember joins the open broadcast channel as audience.
	reject(g, &nostr.Event{Kind: groups.KindJoinRequest, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}})

	// Admin (owner) can post.
	if r, msg := reject(g, &nostr.Event{Kind: groups.KindChat, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1")}}); r {
		t.Fatalf("admin kind-9 should be accepted in broadcast: %s", msg)
	}
	// Audience cannot post a top-level message.
	if r, msg := reject(g, &nostr.Event{Kind: groups.KindChat, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}}); !r {
		t.Fatal("audience kind-9 must be rejected in broadcast")
	} else if msg == "" {
		t.Fatal("expected a reject message")
	}

	// Promote gMember to admin → now they can post.
	reject(g, &nostr.Event{Kind: groups.KindAddUser, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("p", gMember, groups.RoleAdmin)}})
	if r, msg := reject(g, &nostr.Event{Kind: groups.KindChat, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}}); r {
		t.Fatalf("promoted admin kind-9 should be accepted: %s", msg)
	}
}

func TestNonBroadcastGroupUnaffectedByGate(t *testing.T) {
	g, _ := newGuard()
	reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("open")}})
	reject(g, &nostr.Event{Kind: groups.KindJoinRequest, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}})
	// A plain member may post freely in a normal group.
	if r, msg := reject(g, &nostr.Event{Kind: groups.KindChat, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}}); r {
		t.Fatalf("member post in normal group should be accepted: %s", msg)
	}
}

func TestBroadcastPerPostCommentAndReactionGating(t *testing.T) {
	g, _ := newGuard()
	reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("broadcast"), tag("open")}})
	reject(g, &nostr.Event{Kind: groups.KindJoinRequest, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}})

	// Audience comment on a closed post → rejected.
	if r, msg := reject(g, &nostr.Event{Kind: groups.KindThreadReply, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1"), tag("e", "postA")}}); !r {
		t.Fatal("audience comment on a closed post must be rejected")
	} else if msg == "" {
		t.Fatal("expected reject message")
	}
	// Audience reaction on a closed post → rejected.
	if r, _ := reject(g, &nostr.Event{Kind: groups.KindReaction, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1"), tag("e", "postA")}}); !r {
		t.Fatal("audience reaction on a closed post must be rejected")
	}

	// Admin opens comments on postA (only).
	reject(g, &nostr.Event{Kind: groups.KindSetInteractions, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("e", "postA"), tag("comments", "1"), tag("reactions", "0")}})

	// Now an audience comment on postA is accepted.
	if r, msg := reject(g, &nostr.Event{Kind: groups.KindThreadReply, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1"), tag("e", "postA")}}); r {
		t.Fatalf("audience comment on an opened post should be accepted: %s", msg)
	}
	// But a reaction on postA is still closed.
	if r, _ := reject(g, &nostr.Event{Kind: groups.KindReaction, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1"), tag("e", "postA")}}); !r {
		t.Fatal("reaction should still be closed on postA")
	}
	// And a comment on a different (closed) post is rejected.
	if r, _ := reject(g, &nostr.Event{Kind: groups.KindThreadReply, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1"), tag("e", "postB")}}); !r {
		t.Fatal("comment on a different closed post must be rejected")
	}

	// Admin may always comment/react regardless of gate.
	if r, _ := reject(g, &nostr.Event{Kind: groups.KindReaction, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("e", "postB")}}); r {
		t.Fatal("admin reaction must always be allowed")
	}
}

func TestFeedReactionWithoutHTagPassesThrough(t *testing.T) {
	g, _ := newGuard()
	// A kind-7 with no h tag is a feed reaction; the group guard must not touch it.
	if r, _ := reject(g, &nostr.Event{Kind: groups.KindReaction, PubKey: gRando, Tags: nostr.Tags{tag("e", "somefeedpost")}}); r {
		t.Fatal("feed reaction (no h tag) must pass through the group guard")
	}
}

// TestGroupRejectCodes drives representative rejecting group events through GroupGuard.RejectEvent
// and asserts each carries the stable "[code]" prefix (T12). group_missing_tag, unknown_group and
// group_query_scope are reachable too but exercised elsewhere; this covers the 5 the plan calls out.
func TestGroupRejectCodes(t *testing.T) {
	assertPrefix := func(t *testing.T, code string, reject bool, msg string) {
		t.Helper()
		if !reject {
			t.Fatalf("expected a rejection carrying %q, got accept", code)
		}
		if !strings.HasPrefix(msg, "["+code+"] ") {
			t.Fatalf("reject reason %q must begin with [%s]", msg, code)
		}
	}

	// [group_state_managed]: a client may never publish relay-managed state (39000-39005).
	t.Run("group_state_managed", func(t *testing.T) {
		g, _ := newGuard()
		rej, msg := reject(g, &nostr.Event{Kind: groups.KindMembers, PubKey: gOwner, Tags: nostr.Tags{tag("d", "g1")}})
		assertPrefix(t, "group_state_managed", rej, msg)
	})

	// [not_group_member]: a non-member cannot chat in an existing group.
	t.Run("not_group_member", func(t *testing.T) {
		g, _ := newGuard()
		reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("closed")}})
		rej, msg := reject(g, &nostr.Event{Kind: groups.KindChat, PubKey: gRando, Tags: nostr.Tags{tag("h", "g1")}})
		assertPrefix(t, "not_group_member", rej, msg)
	})

	// [broadcast_only]: audience members can't post top-level messages in a broadcast channel.
	t.Run("broadcast_only", func(t *testing.T) {
		g, _ := newGuard()
		reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("broadcast"), tag("open")}})
		reject(g, &nostr.Event{Kind: groups.KindJoinRequest, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}})
		rej, msg := reject(g, &nostr.Event{Kind: groups.KindChat, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}})
		assertPrefix(t, "broadcast_only", rej, msg)
	})

	// [comments_closed] / [reactions_closed]: audience interactions on a closed broadcast post.
	t.Run("comments_and_reactions_closed", func(t *testing.T) {
		g, _ := newGuard()
		reject(g, &nostr.Event{Kind: groups.KindCreateGroup, PubKey: gOwner, Tags: nostr.Tags{tag("h", "g1"), tag("broadcast"), tag("open")}})
		reject(g, &nostr.Event{Kind: groups.KindJoinRequest, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1")}})

		rej, msg := reject(g, &nostr.Event{Kind: groups.KindThreadReply, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1"), tag("e", "postA")}})
		assertPrefix(t, "comments_closed", rej, msg)

		rej, msg = reject(g, &nostr.Event{Kind: groups.KindReaction, PubKey: gMember, Tags: nostr.Tags{tag("h", "g1"), tag("e", "postA")}})
		assertPrefix(t, "reactions_closed", rej, msg)
	})
}

func TestRequireScopedGroupQuery(t *testing.T) {
	// Unscoped query touching group chat is rejected.
	if r, _ := RequireScopedGroupQuery(context.Background(), nostr.Filter{Kinds: []int{groups.KindChat}}); !r {
		t.Fatal("unscoped group-chat query must be rejected")
	}
	// Scoped by h tag is allowed.
	scoped := nostr.Filter{Kinds: []int{groups.KindChat}, Tags: nostr.TagMap{"h": []string{"g1"}}}
	if r, _ := RequireScopedGroupQuery(context.Background(), scoped); r {
		t.Fatal("h-scoped group-chat query must be allowed")
	}
	// A normal feed query is unaffected.
	if r, _ := RequireScopedGroupQuery(context.Background(), nostr.Filter{Kinds: []int{1, 7}}); r {
		t.Fatal("feed query must not be touched by the group filter")
	}
}
