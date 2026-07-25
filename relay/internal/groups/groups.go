// Package groups implements the NIP-29 relay-managed group state machine: who owns/admins/
// belongs to each group, and the validated transitions driven by the management event kinds
// (9000-9007, 9021, 9022). It is deliberately self-contained — no khatru, no request-path
// wiring — so the rules can be unit-tested in isolation. Phase D wires Apply into RejectEvent
// and StateEvents into the relay's event emission.
//
// Model (a closed community is small, so a mutex-guarded map persisted on each change is
// plenty): every group has an owner (its creator, who can never be removed), a set of admins
// (who may manage membership and metadata), and a set of members. Open groups admit a join
// request immediately; closed groups hold it pending until an admin adds the user.
package groups

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"

	"github.com/nbd-wtf/go-nostr"
)

// Management + state event kinds (NIP-29).
const (
	KindAddUser      = 9000 // admin adds/promotes a user (role "owner" by the owner = transfer)
	KindRemoveUser   = 9001 // admin removes (kicks) a user / denies a pending join
	KindEditMetadata = 9002 // admin edits group metadata
	KindCreateGroup  = 9007 // create a group (actor becomes owner+admin)
	KindDeleteGroup  = 9008 // owner deletes the group entirely
	KindJoinRequest     = 9021 // a user asks to join
	KindLeaveRequest    = 9022 // a user leaves
	KindSetInteractions = 9009 // admin opens/closes comments+reactions on a specific post
	KindInviteGrant     = 9010 // admin-signed invite grant, carried inside a 9021 tag (never published)

	KindMetadata  = 39000 // relay-generated: group metadata
	KindAdmins    = 39001 // relay-generated: admin list
	KindMembers   = 39002 // relay-generated: member list
	KindRoles     = 39003 // relay-generated: role definitions
	KindPending   = 39004 // relay-generated: pending join requests (closed groups)
	KindPostState = 39005 // relay-generated: per-post interaction state (comments/reactions)

	KindChat        = 9  // group chat message
	KindThread      = 11 // group thread root
	KindThreadReply = 12 // group thread reply
	KindReaction    = 7  // reaction (group-scoped when carrying an h tag)
)

// RoleOwner is a transient role label on a 9000 event: when the current owner adds a target
// with this role, ownership transfers to the target. It is never stored as a role.
const RoleOwner = "owner"

// RoleAdmin is the single role stiq grants; the owner also holds it. NIP-29 roles are free-form
// labels, but a community this size only needs "can manage" vs "member".
const RoleAdmin = "admin"

// Group is the persisted state of one NIP-29 group.
type Group struct {
	ID      string `json:"id"`
	Name    string `json:"name,omitempty"`
	About   string `json:"about,omitempty"`
	Picture string `json:"picture,omitempty"`
	// Closed: a join request needs an admin to add the user (vs open = auto-admit).
	Closed bool `json:"closed"`
	// Private: only members may read the group's events (vs public = anyone may read).
	Private bool `json:"private"`
	// Gradient encodes the group's gradient identity (opaque to the relay).
	Gradient string `json:"gradient,omitempty"`
	// Broadcast: only admins may publish top-level posts; everyone else is read-only audience.
	Broadcast bool   `json:"broadcast,omitempty"`
	Owner     string `json:"owner"`
	// admins/members are sets keyed by hex pubkey. The owner is always in both.
	Admins  map[string]bool `json:"admins"`
	Members map[string]bool `json:"members"`
	// Pending join requests on a closed group (hex pubkey set), awaiting an admin.
	Pending map[string]bool `json:"pending,omitempty"`
	// Interactions holds per-post comment/reaction gates, keyed by postId. Absent = both closed.
	Interactions map[string]PostInteraction `json:"interactions,omitempty"`
	// RemovedAt records, per hex pubkey, the unix time of that pubkey's last removal from the
	// group — an admin kick (9001, which also covers a declined pending request) or a voluntary
	// leave (9022). Read by inviteGrantAdmits: an invite grant minted at-or-before this time is
	// STALE and must not re-admit the pubkey (a kicked member replaying their original invite DM's
	// grant would otherwise silently self-readmit for the grant's whole 30-day TTL). A grant
	// minted AFTER the removal — a deliberate fresh re-invite — admits as normal. Never emitted
	// in any 39xxx state event; additive + omitempty, so legacy stores load with a nil map
	// (normalized in LoadStore, lazily initialized by recordRemoval).
	RemovedAt map[string]int64 `json:"removedAt,omitempty"`
}

// recordRemoval stamps pk's removal time, lazily initializing the map so a Group built by any
// path that predates the field (a legacy unmarshal missed by normalization) can never panic.
func (g *Group) recordRemoval(pk string, at nostr.Timestamp) {
	if g.RemovedAt == nil {
		g.RemovedAt = map[string]int64{}
	}
	g.RemovedAt[pk] = int64(at)
}

// PostInteraction is the per-post gate: whether comments and reactions are open. The zero value
// (both false) is the default for any post — audience interaction is closed until an admin opens it.
type PostInteraction struct {
	Comments  bool `json:"comments"`
	Reactions bool `json:"reactions"`
}

func newGroup(id, owner string) *Group {
	return &Group{
		ID:           id,
		Owner:        owner,
		Admins:       map[string]bool{owner: true},
		Members:      map[string]bool{owner: true},
		Pending:      map[string]bool{},
		Interactions: map[string]PostInteraction{},
	}
}

// Store holds all groups with optional JSON persistence (mirrors membership.MemStore).
type Store struct {
	mu     sync.RWMutex
	groups map[string]*Group
	path   string // "" disables persistence
}

// NewStore creates an in-memory store.
func NewStore() *Store {
	return &Store{groups: map[string]*Group{}}
}

// LoadStore loads (or creates) a persistent store at path.
func LoadStore(path string) (*Store, error) {
	s := NewStore()
	s.path = path
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var groups map[string]*Group
	if err := json.Unmarshal(data, &groups); err != nil {
		return nil, err
	}
	if groups != nil {
		s.groups = groups
	}
	// Normalize maps that may be nil after unmarshal: empty sets/maps are dropped by
	// `omitempty` on save, so a group persisted with no pending requests or no per-post
	// interaction state reloads with a nil map. Writing to a nil map panics (e.g. a join
	// request to a closed group → g.Pending[pk]=true), so initialize them up front.
	for _, g := range s.groups {
		if g == nil {
			continue
		}
		if g.Admins == nil {
			g.Admins = map[string]bool{}
		}
		if g.Members == nil {
			g.Members = map[string]bool{}
		}
		if g.Pending == nil {
			g.Pending = map[string]bool{}
		}
		if g.Interactions == nil {
			g.Interactions = map[string]PostInteraction{}
		}
		if g.RemovedAt == nil {
			g.RemovedAt = map[string]int64{}
		}
	}
	return s, nil
}

// save writes the store to disk. Caller holds the write lock.
func (s *Store) save() error {
	if s.path == "" {
		return nil
	}
	data, err := json.Marshal(s.groups)
	if err != nil {
		return err
	}
	return writeFileAtomic(s.path, data, 0o600)
}

// writeFileAtomic writes data to a temp file in the target's directory, fsyncs it, then renames
// it over the target. os.WriteFile truncates-then-writes in place, so a crash mid-write leaves a
// half-written groups.json that bricks relay startup; rename is atomic on POSIX (the relay deploys
// to Linux), so a reader ever sees either the old file or the complete new one. (Mirrors the same
// helper in package membership — kept package-local to avoid a shared util dependency for two files.)
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// ── queries (used by Phase D enforcement) ──────────────────────────────────────────────────

// Exists reports whether a group with this id has been created.
func (s *Store) Exists(groupID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.groups[groupID]
	return ok
}

// IsMember reports whether pubkey is a member of the group (false if the group is unknown).
func (s *Store) IsMember(groupID, pubkey string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	g, ok := s.groups[groupID]
	return ok && g.Members[pubkey]
}

// IsAdmin reports whether pubkey may manage the group.
func (s *Store) IsAdmin(groupID, pubkey string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	g, ok := s.groups[groupID]
	return ok && g.Admins[pubkey]
}

// IsPrivate reports whether the group restricts reads to members (false if unknown).
func (s *Store) IsPrivate(groupID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	g, ok := s.groups[groupID]
	return ok && g.Private
}

// IsBroadcast reports whether the group is a broadcast channel (admins-only top-level posts).
func (s *Store) IsBroadcast(groupID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	g, ok := s.groups[groupID]
	return ok && g.Broadcast
}

// InteractionState returns the per-post comment/reaction gate. The zero value (both closed) is
// the default for any post that an admin has not explicitly opened.
func (s *Store) InteractionState(groupID, postID string) PostInteraction {
	s.mu.RLock()
	defer s.mu.RUnlock()
	g, ok := s.groups[groupID]
	if !ok {
		return PostInteraction{}
	}
	return g.Interactions[postID]
}

// snapshot returns a deep copy of a group for safe read-only use outside the lock.
func (s *Store) snapshot(groupID string) (*Group, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	g, ok := s.groups[groupID]
	if !ok {
		return nil, false
	}
	cp := *g
	cp.Admins = cloneSet(g.Admins)
	cp.Members = cloneSet(g.Members)
	cp.Pending = cloneSet(g.Pending)
	cp.Interactions = cloneInteractions(g.Interactions)
	return &cp, true
}

func cloneInteractions(m map[string]PostInteraction) map[string]PostInteraction {
	out := make(map[string]PostInteraction, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func cloneSet(m map[string]bool) map[string]bool {
	out := make(map[string]bool, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// ── apply (validated transitions) ──────────────────────────────────────────────────────────

// Apply validates a management event against the actor's role and mutates group state. It
// returns (reject, msg) in the same shape as a khatru RejectEvent hook: reject=false means the
// event is accepted (and was applied). Non-management kinds are accepted untouched. This is the
// single entry point Phase D plugs into RejectEvent.
func (s *Store) Apply(event *nostr.Event) (reject bool, msg string) {
	switch event.Kind {
	case KindCreateGroup, KindDeleteGroup, KindAddUser, KindRemoveUser, KindEditMetadata, KindJoinRequest, KindLeaveRequest, KindSetInteractions:
		// handled below
	default:
		return false, ""
	}

	groupID := hTag(event)
	if groupID == "" {
		return true, "blocked: group management event missing h tag"
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.groups[groupID]

	switch event.Kind {
	case KindCreateGroup:
		if g != nil {
			return true, "blocked: group already exists"
		}
		ng := newGroup(groupID, event.PubKey)
		applyMetadataTags(ng, event)
		s.groups[groupID] = ng

	case KindDeleteGroup:
		if g == nil {
			return true, "blocked: group does not exist"
		}
		if event.PubKey != g.Owner {
			return true, "blocked: only the group owner can delete the group"
		}
		delete(s.groups, groupID)

	case KindEditMetadata:
		if g == nil {
			return true, "blocked: group does not exist"
		}
		if !g.Admins[event.PubKey] {
			return true, "blocked: only admins can edit group metadata"
		}
		applyMetadataTags(g, event)

	case KindAddUser:
		if g == nil {
			return true, "blocked: group does not exist"
		}
		if !g.Admins[event.PubKey] {
			return true, "blocked: only admins can add users"
		}
		target, roles := pTagWithRoles(event)
		if target == "" {
			return true, "blocked: add-user event missing p tag"
		}
		if !isHexPubkey(target) {
			return true, "blocked: add-user target is not a valid pubkey"
		}
		// Ownership transfer: only the current owner may hand off, via the "owner" role. The new
		// owner becomes owner+admin+member; the previous owner stays an admin+member.
		if hasRole(roles, RoleOwner) {
			if event.PubKey != g.Owner {
				return true, "blocked: only the current owner can transfer ownership"
			}
			g.Owner = target
			g.Members[target] = true
			g.Admins[target] = true
			delete(g.Pending, target)
			break
		}
		g.Members[target] = true
		delete(g.Pending, target)
		if hasRole(roles, RoleAdmin) {
			g.Admins[target] = true
		} else if target != g.Owner {
			// Re-adding without the admin role demotes an existing admin back to member.
			// The owner's admin status is permanent and cannot be removed this way.
			delete(g.Admins, target)
		}

	case KindRemoveUser:
		if g == nil {
			return true, "blocked: group does not exist"
		}
		if !g.Admins[event.PubKey] {
			return true, "blocked: only admins can remove users"
		}
		target, _ := pTagWithRoles(event)
		if target == "" {
			return true, "blocked: remove-user event missing p tag"
		}
		// Deliberately NOT validated with isHexPubkey (unlike AddUser above). A prior client
		// bug wrote non-hex strings (e.g. a 63-char "npub1..." instead of the 64-char hex
		// pubkey) into some groups' Members/Admins rosters. The only way for an admin to
		// purge such an already-corrupted entry is a RemoveUser whose p tag IS that garbage
		// string — rejecting non-hex targets here would make the corruption permanent and
		// unremovable. AddUser still validates, so this path can only ever delete, never
		// (re)introduce a malformed entry.
		if target == g.Owner {
			return true, "blocked: cannot remove the group owner"
		}
		delete(g.Members, target)
		delete(g.Admins, target)
		delete(g.Pending, target) // also denies a pending join request
		// Invalidate every invite grant minted at-or-before this removal (see inviteGrantAdmits):
		// a kick (or a declined pending request) must also kill the target's outstanding grants,
		// or the removed person could replay their original invite DM's grant and self-readmit.
		g.recordRemoval(target, event.CreatedAt)

	case KindJoinRequest:
		if g == nil {
			return true, "blocked: group does not exist"
		}
		if g.Closed {
			// Accept-first invites: a join request carrying a valid admin-signed invite grant is
			// admitted to membership IMMEDIATELY, so an invited person gets in without waiting for
			// an admin's client to be online to approve. Consent is preserved — the invitee still
			// chose to send this request. A grantless (or invalid/expired-grant) request queues as
			// pending for an admin to review, exactly as before.
			if inviteGrantAdmits(event, g) {
				g.Members[event.PubKey] = true
				delete(g.Pending, event.PubKey)
			} else {
				g.Pending[event.PubKey] = true // awaits an admin's add-user
			}
		} else {
			g.Members[event.PubKey] = true
		}

	case KindLeaveRequest:
		if g == nil {
			return true, "blocked: group does not exist"
		}
		if event.PubKey == g.Owner {
			return true, "blocked: the group owner cannot leave"
		}
		delete(g.Members, event.PubKey)
		delete(g.Admins, event.PubKey)
		delete(g.Pending, event.PubKey)
		// A voluntary leave also invalidates the leaver's older grants — rejoining requires either
		// a fresh invite (a grant minted after this) or the normal pending-approval path.
		g.recordRemoval(event.PubKey, event.CreatedAt)

	case KindSetInteractions:
		if g == nil {
			return true, "blocked: group does not exist"
		}
		if !g.Admins[event.PubKey] {
			return true, "blocked: only admins can set post interactions"
		}
		postID := eTag(event)
		if postID == "" {
			return true, "blocked: set-interactions event missing e tag"
		}
		if g.Interactions == nil {
			g.Interactions = map[string]PostInteraction{}
		}
		g.Interactions[postID] = PostInteraction{
			Comments:  tagValue(event, "comments") == "1",
			Reactions: tagValue(event, "reactions") == "1",
		}
	}

	if err := s.save(); err != nil {
		return true, "error: could not persist group state"
	}
	return false, ""
}

// applyMetadataTags copies name/about/picture/access tags from a 9007/9002 event onto g.
func applyMetadataTags(g *Group, event *nostr.Event) {
	for _, tag := range event.Tags {
		if len(tag) < 1 {
			continue
		}
		switch tag[0] {
		case "name":
			if len(tag) >= 2 {
				g.Name = tag[1]
			}
		case "about":
			if len(tag) >= 2 {
				g.About = tag[1]
			}
		case "picture":
			if len(tag) >= 2 {
				g.Picture = tag[1]
			}
		case "gradient":
			if len(tag) >= 2 {
				g.Gradient = tag[1]
			}
		case "broadcast":
			g.Broadcast = true
		case "open":
			g.Closed = false
		case "closed":
			g.Closed = true
		case "public":
			g.Private = false
		case "private":
			g.Private = true
		}
	}
}

// ── state-event templates (Phase D signs + stores these) ────────────────────────────────────

// StateEvents builds the four relay-generated replaceable state events (39000-39003) for a
// group as UNSIGNED templates (Kind/Tags/Content/CreatedAt set; the caller signs them with the
// relay key). Returns nil if the group does not exist. Member/admin lists are sorted so the
// output is deterministic (stable ids on re-emit).
func (s *Store) StateEvents(groupID string, createdAt nostr.Timestamp) []nostr.Event {
	g, ok := s.snapshot(groupID)
	if !ok {
		return nil
	}

	access := "open"
	if g.Closed {
		access = "closed"
	}
	visibility := "public"
	if g.Private {
		visibility = "private"
	}

	metadata := nostr.Event{
		Kind:      KindMetadata,
		CreatedAt: createdAt,
		Content:   "",
		Tags: nostr.Tags{
			{"d", g.ID},
			{"name", g.Name},
			{"about", g.About},
			{"picture", g.Picture},
			{"gradient", g.Gradient},
			{"owner", g.Owner},
			{access},
			{visibility},
		},
	}
	if g.Broadcast {
		metadata.Tags = append(metadata.Tags, nostr.Tag{"broadcast"})
	}

	admins := nostr.Event{Kind: KindAdmins, CreatedAt: createdAt, Tags: nostr.Tags{{"d", g.ID}}}
	for _, pk := range sortedKeys(g.Admins) {
		admins.Tags = append(admins.Tags, nostr.Tag{"p", pk, RoleAdmin})
	}

	members := nostr.Event{Kind: KindMembers, CreatedAt: createdAt, Tags: nostr.Tags{{"d", g.ID}}}
	for _, pk := range sortedKeys(g.Members) {
		members.Tags = append(members.Tags, nostr.Tag{"p", pk})
	}

	roles := nostr.Event{
		Kind:      KindRoles,
		CreatedAt: createdAt,
		Tags: nostr.Tags{
			{"d", g.ID},
			{"role", RoleAdmin, "add users, remove users, edit metadata"},
		},
	}

	// Pending join requests (closed groups). Always emitted (possibly empty) so a cleared queue
	// replaces a prior non-empty 39004.
	pending := nostr.Event{Kind: KindPending, CreatedAt: createdAt, Tags: nostr.Tags{{"d", g.ID}}}
	for _, pk := range sortedKeys(g.Pending) {
		pending.Tags = append(pending.Tags, nostr.Tag{"p", pk})
	}

	out := []nostr.Event{metadata, admins, members, roles, pending}

	// Per-post interaction state (39005), one addressable event per post with a gate set. The `d`
	// tag is "<groupID>:<postId>" so each post replaces independently; `h` scopes it to the group
	// and `e` names the post. comments/reactions are "1" (open) or "0" (closed).
	for _, postID := range sortedInteractionKeys(g.Interactions) {
		st := g.Interactions[postID]
		out = append(out, nostr.Event{
			Kind:      KindPostState,
			CreatedAt: createdAt,
			Tags: nostr.Tags{
				{"d", g.ID + ":" + postID},
				{"h", g.ID},
				{"e", postID},
				{"comments", boolFlag(st.Comments)},
				{"reactions", boolFlag(st.Reactions)},
			},
		})
	}

	return out
}

func boolFlag(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func sortedInteractionKeys(m map[string]PostInteraction) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ── tag helpers ────────────────────────────────────────────────────────────────────────────

// GroupID returns the group id from the event's `h` tag, or "" (exported for the enforcement
// layer in package policy).
func GroupID(event *nostr.Event) string {
	return hTag(event)
}

// IsManagementKind reports whether a kind is a NIP-29 management event this relay applies.
func IsManagementKind(kind int) bool {
	switch kind {
	case KindCreateGroup, KindDeleteGroup, KindAddUser, KindRemoveUser, KindEditMetadata, KindJoinRequest, KindLeaveRequest, KindSetInteractions:
		return true
	}
	return false
}

// IsChatKind reports whether a kind is a NIP-29 group chat/thread event (membership-gated).
func IsChatKind(kind int) bool {
	return kind == KindChat || kind == KindThread || kind == KindThreadReply
}

// IsStateKind reports whether a kind is a relay-generated group state event (39000-39003).
func IsStateKind(kind int) bool {
	return kind == KindMetadata || kind == KindAdmins || kind == KindMembers ||
		kind == KindRoles || kind == KindPending || kind == KindPostState
}

// hTag returns the group id from the event's `h` tag, or "".
func hTag(event *nostr.Event) string {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "h" {
			return tag[1]
		}
	}
	return ""
}

// eTag returns the first `e` tag value (a referenced event/post id), or "".
func eTag(event *nostr.Event) string {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "e" {
			return tag[1]
		}
	}
	return ""
}

// ETag returns the first `e` tag value (exported for the enforcement layer in package policy).
func ETag(event *nostr.Event) string {
	return eTag(event)
}

// HasTag reports whether the event carries a tag with the given name (exported for policy).
func HasTag(event *nostr.Event, name string) bool {
	for _, tag := range event.Tags {
		if len(tag) >= 1 && tag[0] == name {
			return true
		}
	}
	return false
}

// tagValue returns the value of the first tag with the given name, or "".
func tagValue(event *nostr.Event, name string) string {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == name {
			return tag[1]
		}
	}
	return ""
}

// isHexPubkey reports whether s is a canonical Nostr pubkey: exactly 64 lowercase hex digits.
// This is the exact form of event.PubKey, so a malformed target (e.g. a bech32 "npub1..."
// string) is rejected here rather than being written into the roster.
func isHexPubkey(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}

// pTagWithRoles returns the first `p` tag's pubkey and any role labels after it.
func pTagWithRoles(event *nostr.Event) (pubkey string, roles []string) {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "p" {
			return tag[1], tag[2:]
		}
	}
	return "", nil
}

func hasRole(roles []string, want string) bool {
	for _, r := range roles {
		if r == want {
			return true
		}
	}
	return false
}

// InviteGrantTag is the 9021 tag that carries a base64-encoded, admin-signed invite grant (a
// KindInviteGrant event). See inviteGrantAdmits.
const InviteGrantTag = "invite_grant"

// inviteGrantAdmits reports whether a join request (9021) carries a valid invite grant that
// authorizes admitting its signer to g DIRECTLY — the relay-verifiable half of accept-first
// invites. The grant is a KindInviteGrant event, base64-encoded in the request's `invite_grant`
// tag, by which an admin attests "I invite <p> to <h>, valid until <exp>". It is verified, never
// trusted:
//   - the signing pubkey must be a CURRENT admin/owner of this group (a demoted admin's old grant
//     stops working, and a non-admin can never mint one);
//   - the grant must name THIS group and be issued FOR this exact requester, so it can be replayed
//     neither by a different pubkey nor into a different group;
//   - it must be unexpired (a bounded window caps the damage of a leaked/forwarded grant);
//   - its signature must verify (CheckSignature re-serializes, so the tags above are all covered).
//
// The grant rides inside the DM invite and is forwarded by the invitee; it is never published as a
// standalone event, so the relay stores no invite state and stays blind to who was invited until an
// invitee actually acts on it.
func inviteGrantAdmits(joinReq *nostr.Event, g *Group) bool {
	raw := tagValue(joinReq, InviteGrantTag)
	if raw == "" {
		return false
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return false
	}
	var grant nostr.Event
	if err := json.Unmarshal(data, &grant); err != nil {
		return false
	}
	// Cheap structural checks first — defer the costly signature verification to the end.
	if grant.Kind != KindInviteGrant {
		return false
	}
	if !g.Admins[grant.PubKey] {
		return false // only a current admin/owner may authorize an invite
	}
	if hTag(&grant) != g.ID {
		return false // grant is for a different group
	}
	if target, _ := pTagWithRoles(&grant); target != joinReq.PubKey {
		return false // grant was issued for a different pubkey than the requester
	}
	exp := tagValue(&grant, "exp")
	if exp == "" {
		return false // require a bounded window — an undated grant would never expire
	}
	n, err := strconv.ParseInt(exp, 10, 64)
	if err != nil || nostr.Timestamp(n) < nostr.Now() {
		return false // malformed or expired
	}
	// A removal (kick / declined request / voluntary leave) invalidates every grant minted
	// at-or-before it: without this, a kicked member replaying the grant from their original
	// invite DM would silently self-readmit for the grant's whole TTL, with no admin involved.
	// `<=` deliberately treats a same-second grant as stale (safety over convenience — it just
	// falls to the pending queue); a deliberate re-invite mints a strictly newer grant and admits.
	if removedAt, wasRemoved := g.RemovedAt[joinReq.PubKey]; wasRemoved && int64(grant.CreatedAt) <= removedAt {
		return false
	}
	ok, err := grant.CheckSignature()
	return err == nil && ok
}
