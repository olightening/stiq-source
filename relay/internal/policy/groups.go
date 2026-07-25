package policy

import (
	"context"
	"log"
	"strconv"
	"strings"
	"sync"

	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/groups"
)

// Stable reject codes for the NIP-29 group path (groups.go). Lowercase snake_case, stable across
// releases (bump RejectCodesVersion in membership.go on any change). reason() lives in
// membership.go and is reused directly. Added in RejectCodesVersion 3.
const (
	codeGroupStateManaged = "group_state_managed"
	codeGroupMissingTag   = "group_missing_tag"
	codeUnknownGroup      = "unknown_group"
	codeNotGroupMember    = "not_group_member"
	codeBroadcastOnly     = "broadcast_only"
	codeCommentsClosed    = "comments_closed"
	codeReactionsClosed   = "reactions_closed"
	codeGroupQueryScope   = "group_query_scope"
)

// GroupGuard enforces NIP-29 on the request path:
//   - management events (9000-9007, 9021, 9022) are validated + applied to group state, and on
//     acceptance the relay (re)emits the 39000-39003 replaceable state events, signed by the
//     relay key;
//   - chat events (kind 9/11/12) are admitted only from members of the `h`-tagged group;
//   - the relay-managed state kinds (39000-39003) are rejected from clients — only the relay
//     itself writes them (directly, bypassing this hook), so a member can't forge group state.
//
// It runs AFTER the signature + membership checks, so by the time an event reaches here it is a
// validly-signed event from a bound relay member.
type GroupGuard struct {
	store       *groups.Store
	relaySK     string
	relayPK     string
	saveEvent   func(*nostr.Event)
	queryEvents func(context.Context, nostr.Filter) (chan *nostr.Event, error)
	deleteEvent func(context.Context, *nostr.Event) error
	now         func() nostr.Timestamp

	// flagMu guards privateGroupReadAuth below. A separate, tiny mutex from emitMu: this flag is read
	// on every REQ/COUNT touching group content (hot path), while emitMu is only ever taken on
	// accepted management events (rare) — sharing one lock would serialize the hot read path behind
	// management writes for no reason.
	flagMu sync.RWMutex
	// privateGroupReadAuth mirrors config.PrivateGroupReadAuth, read fresh on every
	// RequirePrivateGroupReadAuth call so the operator can flip it via SIGHUP without a relay
	// restart (finding: private_group_read_auth was boot-only, so an operator who enabled it against
	// a client fleet with zero NIP-42 support — blanking every private group — could not undo that
	// without a full restart). See SetPrivateGroupReadAuth.
	privateGroupReadAuth bool

	// emitMu guards the per-group emit bookkeeping below. emitState is only reached on accepted
	// management events (infrequent), so a single mutex is ample and keeps concurrent management
	// events from racing on the caches.
	emitMu sync.Mutex
	// lastState[groupID][stateAddr] is the content fingerprint (tags+content, CreatedAt excluded)
	// of the state event last emitted for that addressable coordinate. A management event only
	// re-signs+re-stores the state events whose fingerprint changed, instead of re-emitting all
	// 5 + one-per-gated-post every time (finding #59: 9009 touches one 39005, a join touches
	// 39002/39004, yet the old code re-signed everything → O(N²) over N gated posts).
	lastState map[string]map[string]string
	// lastEmit[groupID] is the CreatedAt of this group's most recent emission. Emissions are
	// clamped to strictly increase per group so two management events in the same wall-clock
	// second still produce a state event that ReplaceEvent accepts as newer (IsOlder breaks
	// CreatedAt ties by id, which would otherwise drop ~half of same-second updates).
	lastEmit map[string]nostr.Timestamp
}

// NewGroupGuard builds a guard. saveEvent stores a relay-generated state event via the same
// backend as member events (called for each 39000-39003 emit). queryEvents/deleteEvent give the
// guard read+delete access to that backend so a deleted group's state events can be purged;
// either may be nil, in which case purging is skipped. relaySK/relayPK may be empty in degraded
// setups, in which case state emission is skipped but enforcement still applies.
func NewGroupGuard(store *groups.Store, relaySK, relayPK string, saveEvent func(*nostr.Event),
	queryEvents func(context.Context, nostr.Filter) (chan *nostr.Event, error),
	deleteEvent func(context.Context, *nostr.Event) error) *GroupGuard {
	return &GroupGuard{
		store:       store,
		relaySK:     relaySK,
		relayPK:     relayPK,
		saveEvent:   saveEvent,
		queryEvents: queryEvents,
		deleteEvent: deleteEvent,
		now:         nostr.Now,
		lastState:   map[string]map[string]string{},
		lastEmit:    map[string]nostr.Timestamp{},
	}
}

// SetPrivateGroupReadAuth toggles NIP-29 private-group read enforcement (RequirePrivateGroupReadAuth
// below). false (the default) leaves `private` metadata-only, exactly as if the hook were never
// registered. Safe at construction and on hot-reload — the caller (relayapp.Reloader.Apply) is
// responsible for logging the loud client-compatibility warning whenever this turns true; this
// method only flips the enforced value.
func (gg *GroupGuard) SetPrivateGroupReadAuth(v bool) {
	gg.flagMu.Lock()
	gg.privateGroupReadAuth = v
	gg.flagMu.Unlock()
}

// UpdatePrivateGroupReadAuth is an alias used on SIGHUP hot-reload, mirroring the
// Set*/Update* naming convention used throughout Membership (SetBlindRequired/UpdateBlindRequired
// etc.).
func (gg *GroupGuard) UpdatePrivateGroupReadAuth(v bool) { gg.SetPrivateGroupReadAuth(v) }

// RejectEvent is a khatru RejectEvent hook implementing the rules above. Non-group kinds pass
// through untouched, so the feed and NIP-53 channels are unaffected.
func (gg *GroupGuard) RejectEvent(_ context.Context, event *nostr.Event) (reject bool, msg string) {
	switch {
	case groups.IsStateKind(event.Kind):
		// Group state is relay-managed; clients may never publish it.
		return true, reason(codeGroupStateManaged, "blocked: group state (39000-39005) is relay-managed")

	case groups.IsManagementKind(event.Kind):
		reject, msg = gg.store.Apply(event)
		if !reject {
			if event.Kind == groups.KindDeleteGroup {
				// The group is gone from the store, so StateEvents returns nil and a re-emit
				// can't overwrite anything — actively purge its 39000-39005 events instead,
				// or they'd be served forever for a group that no longer exists.
				gg.purgeState(groups.GroupID(event))
			} else {
				gg.emitState(groups.GroupID(event))
			}
		}
		return reject, msg

	case event.Kind == groups.KindReaction && groups.GroupID(event) != "":
		// A kind-7 reaction carrying an `h` tag is a group reaction; one without `h` is a feed
		// reaction and falls through untouched (handled by the default branch below).
		return gg.guardGroupEvent(event)

	case groups.IsChatKind(event.Kind):
		return gg.guardGroupEvent(event)

	default:
		return false, ""
	}
}

// guardGroupEvent enforces membership, broadcast admin-only posting (B2), and per-post
// interaction gating (C3) for group chat/thread/reply/reaction events.
func (gg *GroupGuard) guardGroupEvent(event *nostr.Event) (reject bool, msg string) {
	groupID := groups.GroupID(event)
	if groupID == "" {
		return true, reason(codeGroupMissingTag, "blocked: group chat event missing h tag")
	}
	if !gg.store.Exists(groupID) {
		return true, reason(codeUnknownGroup, "blocked: unknown group")
	}
	if !gg.store.IsMember(groupID, event.PubKey) {
		return true, reason(codeNotGroupMember, "blocked: not a member of this group")
	}

	isAdmin := gg.store.IsAdmin(groupID, event.PubKey)
	if !gg.store.IsBroadcast(groupID) {
		// Normal group: members may post/reply/react freely.
		return false, ""
	}

	// Broadcast channel rules. Admins are always allowed.
	if isAdmin {
		return false, ""
	}

	switch event.Kind {
	case groups.KindChat, groups.KindThread:
		// Top-level posts are admins-only in a broadcast channel.
		return true, reason(codeBroadcastOnly, "blocked: broadcast channel — only admins may post")
	case groups.KindThreadReply:
		// Audience comments allowed only if the parent post has comments opened.
		parent := groups.ETag(event)
		if parent == "" || !gg.store.InteractionState(groupID, parent).Comments {
			return true, reason(codeCommentsClosed, "blocked: comments are closed on this post")
		}
		return false, ""
	case groups.KindReaction:
		// Audience reactions allowed only if the target post has reactions opened.
		target := groups.ETag(event)
		if target == "" || !gg.store.InteractionState(groupID, target).Reactions {
			return true, reason(codeReactionsClosed, "blocked: reactions are closed on this post")
		}
		return false, ""
	}
	return false, ""
}

// emitState re-signs and stores only the group state events whose content actually changed
// since the last emission for this group (best-effort). It runs on the admission path, so it
// avoids re-signing all 5 + one-per-gated-post state events on every management event.
func (gg *GroupGuard) emitState(groupID string) {
	if groupID == "" || gg.relaySK == "" || gg.saveEvent == nil {
		return
	}

	gg.emitMu.Lock()
	defer gg.emitMu.Unlock()

	// Strictly-monotonic per-group timestamp: two management events in the same second would
	// otherwise share a CreatedAt, and badger's ReplaceEvent (IsOlder) breaks that tie by id —
	// dropping the newer event ~half the time. Bump past the last emission so the replacement
	// always wins.
	ts := gg.now()
	if last, ok := gg.lastEmit[groupID]; ok && ts <= last {
		ts = last + 1
	}

	templates := gg.store.StateEvents(groupID, ts)
	if templates == nil {
		// Group was deleted (or never existed): nothing to emit. Keep the caches so a recreated
		// group with the same id still diffs against the last-known state.
		return
	}

	prev := gg.lastState[groupID]
	next := make(map[string]string, len(templates))
	emittedAny := false

	for _, tmpl := range templates {
		addr := stateAddr(&tmpl)
		fp := stateFingerprint(&tmpl)
		next[addr] = fp
		if prev != nil && prev[addr] == fp {
			// Unchanged since last emission — skip the sign + store entirely.
			continue
		}

		e := tmpl
		if err := e.Sign(gg.relaySK); err != nil {
			// Sign only fails on a malformed relay key, which a retry cannot fix, so we log and
			// skip rather than sleeping on the admission path (the old 500ms sleep-retry stalled
			// the publisher's goroutine for a case that never recovers). Do NOT record this addr
			// in `next` so the next management event retries it.
			log.Printf("groups: emitState kind-%d sign failed: %v (state may be stale)", e.Kind, err)
			delete(next, addr)
			continue
		}
		gg.saveEvent(&e)
		emittedAny = true
	}

	gg.lastState[groupID] = next
	if emittedAny {
		gg.lastEmit[groupID] = ts
	}
}

// stateAddr is the addressable coordinate (kind + d-tag) that ReplaceEvent keys on. State kinds
// carry a unique d-tag per (kind, and per-post for 39005), so this uniquely identifies each
// replaceable state event within a group.
func stateAddr(e *nostr.Event) string {
	return strings.Join([]string{itoa(e.Kind), e.Tags.GetD()}, ":")
}

// stateFingerprint is a content identity for a state template, excluding CreatedAt (which changes
// on every emission and would defeat the diff). Two emissions with the same fingerprint produce
// byte-identical stored state modulo timestamp, so re-signing them is pure waste.
func stateFingerprint(e *nostr.Event) string {
	var b strings.Builder
	b.WriteString(e.Content)
	for _, tag := range e.Tags {
		b.WriteByte('\x1e') // record separator, cannot appear in hex pubkeys/flags
		for _, v := range tag {
			b.WriteByte('\x1f') // unit separator
			b.WriteString(v)
		}
	}
	return b.String()
}

func itoa(n int) string {
	return strconv.Itoa(n)
}

// purgeState deletes the group's relay-generated 39000-39005 state events from the backend
// after the group itself has been deleted (best-effort). 39000-39004 carry the group id in
// their `d` tag; the per-post 39005 events use `d` = "<group>:<post>" but always carry the
// group id in an `h` tag, so two filters cover all six kinds.
func (gg *GroupGuard) purgeState(groupID string) {
	if groupID == "" {
		return
	}
	// Drop the emit caches for this group: a later recreate with the same id must re-emit all
	// its state events from scratch (they've been purged from the backend), not diff against the
	// fingerprints of the now-deleted events and skip them as "unchanged".
	gg.emitMu.Lock()
	delete(gg.lastState, groupID)
	delete(gg.lastEmit, groupID)
	gg.emitMu.Unlock()

	if gg.queryEvents == nil || gg.deleteEvent == nil {
		return
	}
	ctx := context.Background()
	filters := []nostr.Filter{
		{
			Kinds: []int{groups.KindMetadata, groups.KindAdmins, groups.KindMembers,
				groups.KindRoles, groups.KindPending},
			Tags: nostr.TagMap{"d": []string{groupID}},
		},
		{
			Kinds: []int{groups.KindPostState},
			Tags:  nostr.TagMap{"h": []string{groupID}},
		},
	}
	for _, filter := range filters {
		ch, err := gg.queryEvents(ctx, filter)
		if err != nil {
			log.Printf("groups: purgeState query kinds %v failed: %v (stale state may linger)", filter.Kinds, err)
			continue
		}
		for ev := range ch {
			if err := gg.deleteEvent(ctx, ev); err != nil {
				log.Printf("groups: purgeState delete kind-%d %s failed: %v", ev.Kind, ev.ID, err)
			}
		}
	}
}

// groupQueryKinds are the kinds whose REQ filters must be scoped to a specific group (or
// author/id), to prevent enumerating all group content with a firehose query.
var groupQueryKinds = map[int]struct{}{
	groups.KindChat: {}, groups.KindThread: {}, groups.KindThreadReply: {},
	groups.KindMetadata: {}, groups.KindAdmins: {}, groups.KindMembers: {},
	groups.KindRoles: {}, groups.KindPending: {}, groups.KindPostState: {},
}

// groupContentKinds are the kinds carrying a private group's actual conversation (chat/thread/
// reply/reaction + the relay-managed state that lists members). A private group's read guarantee is
// meaningful only for these.
var groupContentKinds = map[int]struct{}{
	groups.KindChat: {}, groups.KindThread: {}, groups.KindThreadReply: {}, groups.KindReaction: {},
	groups.KindMetadata: {}, groups.KindAdmins: {}, groups.KindMembers: {},
	groups.KindRoles: {}, groups.KindPending: {}, groups.KindPostState: {},
}

// RequirePrivateGroupReadAuth is a khatru RejectFilter hook that enforces the `private` group read
// restriction (finding #38). For a query touching group content scoped to a group (`#h`), if that
// group is private the connection must be an AUTHENTICATED (NIP-42) member; otherwise the relay
// requests auth and rejects. Public groups and non-group queries pass untouched.
//
// UNCONDITIONALLY REGISTERED (relay.go) so the operator can flip enforcement via SIGHUP without a
// restart; the actual gate is the privateGroupReadAuth flag (SetPrivateGroupReadAuth), checked FIRST
// so this is a no-op — byte-identical to never being registered — whenever it is false (ships dark).
// It REQUIRES clients to speak NIP-42 AUTH once true; without that, private-group reads break for
// every member (relayapp.Reloader.Apply logs a loud warning whenever it turns on). Bound as a method
// so it can read the group store + membership.
func (gg *GroupGuard) RequirePrivateGroupReadAuth(ctx context.Context, filter nostr.Filter) (reject bool, msg string) {
	gg.flagMu.RLock()
	enabled := gg.privateGroupReadAuth
	gg.flagMu.RUnlock()
	if !enabled {
		return false, ""
	}
	touches := false
	for _, k := range filter.Kinds {
		if _, ok := groupContentKinds[k]; ok {
			touches = true
			break
		}
	}
	if !touches {
		return false, ""
	}
	// Collect the group ids this query is scoped to (RequireScopedGroupQuery already ensured group
	// queries are scoped; here we only act on the ones that name a group via #h/#d).
	groupIDs := append([]string{}, filter.Tags["h"]...)
	groupIDs = append(groupIDs, filter.Tags["d"]...)
	if len(groupIDs) == 0 {
		return false, "" // scoped by author/id only — not a group-content firehose we can map here
	}
	authed := khatru.GetAuthed(ctx)
	for _, gid := range groupIDs {
		// 39005 state uses d="<group>:<post>"; take the group prefix so it maps to the right group.
		if i := strings.IndexByte(gid, ':'); i >= 0 {
			gid = gid[:i]
		}
		if !gg.store.IsPrivate(gid) {
			continue
		}
		if authed == "" {
			khatru.RequestAuth(ctx)
			return true, "auth-required: this group is private; authenticate to read it"
		}
		if !gg.store.IsMember(gid, authed) {
			return true, "restricted: not a member of this private group"
		}
	}
	return false, ""
}

// RequireScopedGroupQuery is a khatru RejectFilter hook: a query touching group kinds must name
// a group (`#h` or `#d`), an author, or specific ids. Other kinds (feed, NIP-53) are unaffected.
func RequireScopedGroupQuery(_ context.Context, filter nostr.Filter) (reject bool, msg string) {
	touches := false
	for _, k := range filter.Kinds {
		if _, ok := groupQueryKinds[k]; ok {
			touches = true
			break
		}
	}
	if !touches {
		return false, ""
	}
	if len(filter.Authors) > 0 || len(filter.IDs) > 0 ||
		len(filter.Tags["h"]) > 0 || len(filter.Tags["d"]) > 0 {
		return false, ""
	}
	return true, reason(codeGroupQueryScope, "blocked: group queries must specify a group (h/d), author, or id")
}
