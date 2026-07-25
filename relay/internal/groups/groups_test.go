package groups

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/nbd-wtf/go-nostr"
)

// ev builds a management event from a kind, author, and tags.
func ev(kind int, author string, tags ...nostr.Tag) *nostr.Event {
	return &nostr.Event{Kind: kind, PubKey: author, Tags: nostr.Tags(tags)}
}

const (
	owner   = "0000000000000000000000000000000000000000000000000000000000000001"
	admin2  = "0000000000000000000000000000000000000000000000000000000000000002"
	member3 = "0000000000000000000000000000000000000000000000000000000000000003"
	rando   = "00000000000000000000000000000000000000000000000000000000000000ff"
)

func mustApply(t *testing.T, s *Store, e *nostr.Event) {
	t.Helper()
	if reject, msg := s.Apply(e); reject {
		t.Fatalf("expected accept for kind %d, got reject: %s", e.Kind, msg)
	}
}

func mustReject(t *testing.T, s *Store, e *nostr.Event, wantSubstr string) {
	t.Helper()
	reject, msg := s.Apply(e)
	if !reject {
		t.Fatalf("expected reject for kind %d, got accept", e.Kind)
	}
	if wantSubstr != "" && !contains(msg, wantSubstr) {
		t.Fatalf("reject msg %q does not contain %q", msg, wantSubstr)
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// TestLoadStoreInitializesNilMapsForLegacyGroups guards the production crash where a CLOSED
// group persisted by an older binary (no "pending"/"interactions" keys — omitempty dropped the
// empty maps) reloaded with nil maps, and a 9021 join request wrote to the nil g.Pending map →
// "assignment to entry in nil map" panic.
func TestLoadStoreInitializesNilMapsForLegacyGroups(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "groups.json")
	legacy := `{"gC":{"id":"gC","name":"Closed","closed":true,"owner":"` + owner +
		`","admins":{"` + owner + `":true},"members":{"` + owner + `":true}}}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := LoadStore(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	// A join request to the closed group must be queued (not panic on the nil Pending map).
	mustApply(t, s, ev(KindJoinRequest, rando, nostr.Tag{"h", "gC"}))
	if g, ok := s.snapshot("gC"); !ok || !g.Pending[rando] {
		t.Fatal("requester should be pending after a join request to a closed group")
	}

	// Opening per-post interactions must also work (the Interactions map was nil on load).
	mustApply(t, s, ev(KindSetInteractions, owner,
		nostr.Tag{"h", "gC"}, nostr.Tag{"e", "post1"}, nostr.Tag{"comments", "1"}))
	if !s.InteractionState("gC", "post1").Comments {
		t.Fatal("comments should be open on post1 after set-interactions")
	}
}

func TestCreateGroupMakesOwnerAdminAndMember(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"name", "Test"}))

	if !s.Exists("g1") {
		t.Fatal("group should exist")
	}
	if !s.IsMember("g1", owner) || !s.IsAdmin("g1", owner) {
		t.Fatal("creator should be owner+admin+member")
	}
}

func TestCreateGroupRejectsDuplicate(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}))
	mustReject(t, s, ev(KindCreateGroup, rando, nostr.Tag{"h", "g1"}), "already exists")
}

func TestManagementEventRequiresHTag(t *testing.T) {
	s := NewStore()
	mustReject(t, s, ev(KindCreateGroup, owner), "missing h tag")
}

func TestOnlyAdminsCanAddUsers(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}))

	// A non-admin cannot add anyone.
	mustReject(t, s, ev(KindAddUser, rando, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3}), "only admins")
	if s.IsMember("g1", member3) {
		t.Fatal("member3 should not have been added by a non-admin")
	}

	// The owner (admin) can add a member.
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3}))
	if !s.IsMember("g1", member3) {
		t.Fatal("member3 should be a member after owner add")
	}
	if s.IsAdmin("g1", member3) {
		t.Fatal("member3 should not be an admin (no role tag)")
	}
}

func TestAddUserWithAdminRolePromotes(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}))
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2, RoleAdmin}))

	if !s.IsAdmin("g1", admin2) {
		t.Fatal("admin2 should be an admin")
	}
	// And a promoted admin can now add others.
	mustApply(t, s, ev(KindAddUser, admin2, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3}))
	if !s.IsMember("g1", member3) {
		t.Fatal("member3 should be added by admin2")
	}
}

func TestKickRemovesMemberAndAdmin(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}))
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2, RoleAdmin}))

	// Non-admin cannot kick.
	mustReject(t, s, ev(KindRemoveUser, rando, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2}), "only admins")

	// Owner kicks admin2.
	mustApply(t, s, ev(KindRemoveUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2}))
	if s.IsMember("g1", admin2) || s.IsAdmin("g1", admin2) {
		t.Fatal("admin2 should be fully removed after kick")
	}
}

func TestOwnerCannotBeRemovedOrLeave(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}))
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2, RoleAdmin}))

	mustReject(t, s, ev(KindRemoveUser, admin2, nostr.Tag{"h", "g1"}, nostr.Tag{"p", owner}), "owner")
	mustReject(t, s, ev(KindLeaveRequest, owner, nostr.Tag{"h", "g1"}), "owner cannot leave")
	if !s.IsMember("g1", owner) {
		t.Fatal("owner should still be a member")
	}
}

func TestJoinOpenGroupAutoAdmits(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"open"}))
	mustApply(t, s, ev(KindJoinRequest, member3, nostr.Tag{"h", "g1"}))
	if !s.IsMember("g1", member3) {
		t.Fatal("open-group join should auto-admit")
	}
}

func TestJoinClosedGroupStaysPendingUntilAdded(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"closed"}))

	// Join request is accepted as an event but does not grant membership.
	mustApply(t, s, ev(KindJoinRequest, member3, nostr.Tag{"h", "g1"}))
	if s.IsMember("g1", member3) {
		t.Fatal("closed-group join must not auto-admit")
	}

	// An admin then adds the user.
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3}))
	if !s.IsMember("g1", member3) {
		t.Fatal("user should be a member after admin add")
	}
}

func TestLeaveRemovesMember(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"open"}))
	mustApply(t, s, ev(KindJoinRequest, member3, nostr.Tag{"h", "g1"}))
	mustApply(t, s, ev(KindLeaveRequest, member3, nostr.Tag{"h", "g1"}))
	if s.IsMember("g1", member3) {
		t.Fatal("member3 should be gone after leaving")
	}
}

func TestEditMetadataAdminOnly(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"open"}))
	mustReject(t, s, ev(KindEditMetadata, rando, nostr.Tag{"h", "g1"}, nostr.Tag{"name", "x"}), "only admins")

	mustApply(t, s, ev(KindEditMetadata, owner,
		nostr.Tag{"h", "g1"}, nostr.Tag{"name", "Renamed"}, nostr.Tag{"closed"}, nostr.Tag{"private"}))

	if !s.IsPrivate("g1") {
		t.Fatal("group should now be private")
	}
}

func TestNonManagementKindIsIgnored(t *testing.T) {
	s := NewStore()
	if reject, _ := s.Apply(ev(KindChat, owner, nostr.Tag{"h", "g1"})); reject {
		t.Fatal("chat kind should pass through Apply untouched")
	}
}

func TestStateEventsReflectMembership(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"name", "G"}, nostr.Tag{"closed"}, nostr.Tag{"private"}))
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2, RoleAdmin}))
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3}))

	events := s.StateEvents("g1", 1000)
	if len(events) != 5 {
		t.Fatalf("expected 5 state events, got %d", len(events))
	}

	byKind := map[int]nostr.Event{}
	for _, e := range events {
		byKind[e.Kind] = e
	}

	meta := byKind[KindMetadata]
	if meta.Tags.GetD() != "g1" {
		t.Fatalf("metadata d tag = %q, want g1", meta.Tags.GetD())
	}
	if !hasTag(meta.Tags, "closed") || !hasTag(meta.Tags, "private") {
		t.Fatal("metadata should be marked closed + private")
	}

	if countPTags(byKind[KindAdmins].Tags) != 2 { // owner + admin2
		t.Fatalf("expected 2 admins, got %d", countPTags(byKind[KindAdmins].Tags))
	}
	if countPTags(byKind[KindMembers].Tags) != 3 { // owner + admin2 + member3
		t.Fatalf("expected 3 members, got %d", countPTags(byKind[KindMembers].Tags))
	}
}

func TestStateEventsNilForUnknownGroup(t *testing.T) {
	s := NewStore()
	if s.StateEvents("nope", 1) != nil {
		t.Fatal("expected nil state events for unknown group")
	}
}

func TestPersistenceRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "groups.json")
	s, err := LoadStore(path)
	if err != nil {
		t.Fatal(err)
	}
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"closed"}))
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3}))

	reloaded, err := LoadStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.IsMember("g1", member3) || !reloaded.IsAdmin("g1", owner) {
		t.Fatal("group state should survive a reload")
	}
}

func hasTag(tags nostr.Tags, name string) bool {
	for _, tag := range tags {
		if len(tag) >= 1 && tag[0] == name {
			return true
		}
	}
	return false
}

func countPTags(tags nostr.Tags) int {
	n := 0
	for _, tag := range tags {
		if len(tag) >= 2 && tag[0] == "p" {
			n++
		}
	}
	return n
}

func TestDemoteAdminToMember(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}))
	// Promote admin2 to admin.
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2, RoleAdmin}))
	if !s.IsAdmin("g1", admin2) {
		t.Fatal("admin2 should be an admin after promotion")
	}
	// Re-add admin2 without admin role → demotes to plain member.
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2}))
	if s.IsAdmin("g1", admin2) {
		t.Fatal("admin2 should be demoted to plain member")
	}
	if !s.IsMember("g1", admin2) {
		t.Fatal("admin2 should still be a member after demotion")
	}
}

func TestOwnerAdminStatusIsProtectedFromDemotion(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}))
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2, RoleAdmin}))
	// admin2 tries to "re-add" owner without admin role — owner must stay admin.
	mustApply(t, s, ev(KindAddUser, admin2, nostr.Tag{"h", "g1"}, nostr.Tag{"p", owner}))
	if !s.IsAdmin("g1", owner) {
		t.Fatal("owner admin status must be permanent")
	}
}

func TestOnlyOwnerCanDeleteGroup(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}))
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2, RoleAdmin}))

	// An admin (not owner) cannot delete.
	mustReject(t, s, ev(KindDeleteGroup, admin2, nostr.Tag{"h", "g1"}), "only the group owner")
	if !s.Exists("g1") {
		t.Fatal("group should survive a non-owner delete attempt")
	}
	// Owner deletes it.
	mustApply(t, s, ev(KindDeleteGroup, owner, nostr.Tag{"h", "g1"}))
	if s.Exists("g1") {
		t.Fatal("group should be gone after owner delete")
	}
}

func TestOwnershipTransfer(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}))
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3}))
	// admin2 is an admin but not the owner.
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2, RoleAdmin}))

	// An admin who is not the owner cannot transfer ownership.
	mustReject(t, s, ev(KindAddUser, admin2, nostr.Tag{"h", "g1"}, nostr.Tag{"p", admin2, RoleOwner}),
		"only the current owner")

	// Owner transfers to member3.
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3, RoleOwner}))
	if !s.IsAdmin("g1", member3) || !s.IsMember("g1", member3) {
		t.Fatal("new owner should be admin+member")
	}
	// The new owner is now protected from removal; the old owner is not.
	mustReject(t, s, ev(KindRemoveUser, member3, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3}), "cannot remove the group owner")
	mustApply(t, s, ev(KindRemoveUser, member3, nostr.Tag{"h", "g1"}, nostr.Tag{"p", owner}))
	if s.IsMember("g1", owner) {
		t.Fatal("previous owner should be removable by the new owner")
	}
}

func TestDenyClearsPendingAndPendingStateEmitted(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"closed"}))
	mustApply(t, s, ev(KindJoinRequest, member3, nostr.Tag{"h", "g1"}))

	// 39004 pending state should list member3.
	pending := stateByKind(s.StateEvents("g1", 1), KindPending)
	if countPTags(pending.Tags) != 1 {
		t.Fatalf("expected 1 pending request, got %d", countPTags(pending.Tags))
	}

	// Deny via a remove-user — clears the pending entry without adding them.
	mustApply(t, s, ev(KindRemoveUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3}))
	if s.IsMember("g1", member3) {
		t.Fatal("denied user must not be a member")
	}
	pending = stateByKind(s.StateEvents("g1", 2), KindPending)
	if countPTags(pending.Tags) != 0 {
		t.Fatalf("pending should be empty after deny, got %d", countPTags(pending.Tags))
	}
}

func tagVal(tags nostr.Tags, name string) string {
	for _, tag := range tags {
		if len(tag) >= 2 && tag[0] == name {
			return tag[1]
		}
	}
	return ""
}

func TestGradientRoundTripsAndAppearsInMetadata(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"gradient", "grad-abc"}))

	meta := stateByKind(s.StateEvents("g1", 1), KindMetadata)
	if got := tagVal(meta.Tags, "gradient"); got != "grad-abc" {
		t.Fatalf("metadata gradient = %q, want grad-abc", got)
	}

	// Edit changes it.
	mustApply(t, s, ev(KindEditMetadata, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"gradient", "grad-xyz"}))
	meta = stateByKind(s.StateEvents("g1", 2), KindMetadata)
	if got := tagVal(meta.Tags, "gradient"); got != "grad-xyz" {
		t.Fatalf("metadata gradient = %q, want grad-xyz", got)
	}
}

func TestBroadcastFlagRoundTrips(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"broadcast"}))

	if !s.IsBroadcast("g1") {
		t.Fatal("group should be a broadcast channel")
	}
	meta := stateByKind(s.StateEvents("g1", 1), KindMetadata)
	if !hasTag(meta.Tags, "broadcast") {
		t.Fatal("metadata should carry a broadcast flag")
	}

	// A normal group is not broadcast and emits no flag.
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g2"}))
	if s.IsBroadcast("g2") {
		t.Fatal("g2 should not be broadcast")
	}
	if hasTag(stateByKind(s.StateEvents("g2", 1), KindMetadata).Tags, "broadcast") {
		t.Fatal("non-broadcast metadata should not carry a broadcast flag")
	}
}

func TestSetInteractionsAdminOnly(t *testing.T) {
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"broadcast"}))
	mustApply(t, s, ev(KindAddUser, owner, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3}))

	// Default: both closed.
	if st := s.InteractionState("g1", "post1"); st.Comments || st.Reactions {
		t.Fatal("default interaction state should be both closed")
	}

	// A non-admin member cannot set interactions.
	mustReject(t, s, ev(KindSetInteractions, member3,
		nostr.Tag{"h", "g1"}, nostr.Tag{"e", "post1"}, nostr.Tag{"comments", "1"}), "only admins")

	// Admin opens comments only.
	mustApply(t, s, ev(KindSetInteractions, owner,
		nostr.Tag{"h", "g1"}, nostr.Tag{"e", "post1"}, nostr.Tag{"comments", "1"}, nostr.Tag{"reactions", "0"}))
	st := s.InteractionState("g1", "post1")
	if !st.Comments || st.Reactions {
		t.Fatalf("expected comments open, reactions closed; got %+v", st)
	}

	// 39005 state event reflects it.
	ps := stateByKind(s.StateEvents("g1", 1), KindPostState)
	if ps.Kind != KindPostState {
		t.Fatal("expected a 39005 post-state event")
	}
	if tagVal(ps.Tags, "d") != "g1:post1" {
		t.Fatalf("39005 d tag = %q, want g1:post1", tagVal(ps.Tags, "d"))
	}
	if tagVal(ps.Tags, "comments") != "1" || tagVal(ps.Tags, "reactions") != "0" {
		t.Fatalf("39005 flags wrong: %v", ps.Tags)
	}
}

func stateByKind(events []nostr.Event, kind int) nostr.Event {
	for _, e := range events {
		if e.Kind == kind {
			return e
		}
	}
	return nostr.Event{}
}

// grantB64For builds a signed invite grant (kind 9010) with an explicit CreatedAt, base64-encoded
// exactly as it rides in a 9021's invite_grant tag. Mirrors the inviting admin's client.
func grantB64For(t *testing.T, signerSK, gid, invitedPk string, at nostr.Timestamp) string {
	t.Helper()
	grant := &nostr.Event{
		Kind:      KindInviteGrant,
		CreatedAt: at,
		Tags: nostr.Tags{
			{"h", gid}, {"p", invitedPk},
			{"exp", strconv.FormatInt(int64(nostr.Now())+3600, 10)},
		},
	}
	if err := grant.Sign(signerSK); err != nil {
		t.Fatalf("sign grant: %v", err)
	}
	raw, err := json.Marshal(grant)
	if err != nil {
		t.Fatalf("marshal grant: %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// TestKickInvalidatesOlderGrants is the stale-grant self-readmit fix: a kicked member replaying
// the grant from their original invite DM must fall to pending, while a deliberately re-minted
// fresh grant (created after the kick) still admits directly.
func TestKickInvalidatesOlderGrants(t *testing.T) {
	adminSK := nostr.GeneratePrivateKey()
	adminPK, _ := nostr.GetPublicKey(adminSK)
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, adminPK, nostr.Tag{"h", "g1"}, nostr.Tag{"closed"}))

	join := func(grant string) *nostr.Event {
		return ev(KindJoinRequest, member3, nostr.Tag{"h", "g1"}, nostr.Tag{"invite_grant", grant})
	}

	// Baseline: the original grant admits directly.
	original := grantB64For(t, adminSK, "g1", member3, nostr.Now()-100)
	mustApply(t, s, join(original))
	if !s.IsMember("g1", member3) {
		t.Fatal("a valid grant should admit directly")
	}

	// Kick (strictly after the grant's mint time) — must record the removal.
	kick := ev(KindRemoveUser, adminPK, nostr.Tag{"h", "g1"}, nostr.Tag{"p", member3})
	kick.CreatedAt = nostr.Now() - 50
	mustApply(t, s, kick)
	if g, ok := s.snapshot("g1"); !ok || g.RemovedAt[member3] != int64(kick.CreatedAt) {
		t.Fatal("kick should record RemovedAt for the target")
	}

	// Replaying the ORIGINAL grant must not re-admit — it falls to the pending queue.
	mustApply(t, s, join(original))
	if s.IsMember("g1", member3) {
		t.Fatal("a grant minted before the kick must NOT re-admit")
	}
	if g, _ := s.snapshot("g1"); !g.Pending[member3] {
		t.Fatal("the stale-grant request should fall to pending")
	}

	// A FRESH grant minted after the kick is a deliberate re-invite and admits again.
	fresh := grantB64For(t, adminSK, "g1", member3, nostr.Now())
	mustApply(t, s, join(fresh))
	if !s.IsMember("g1", member3) {
		t.Fatal("a fresh grant minted after the kick should admit")
	}
}

// TestLeaveInvalidatesOlderGrants: a voluntary leave (9022) invalidates the leaver's older grants
// the same way a kick does.
func TestLeaveInvalidatesOlderGrants(t *testing.T) {
	adminSK := nostr.GeneratePrivateKey()
	adminPK, _ := nostr.GetPublicKey(adminSK)
	s := NewStore()
	mustApply(t, s, ev(KindCreateGroup, adminPK, nostr.Tag{"h", "g1"}, nostr.Tag{"closed"}))

	original := grantB64For(t, adminSK, "g1", member3, nostr.Now()-100)
	mustApply(t, s, ev(KindJoinRequest, member3, nostr.Tag{"h", "g1"}, nostr.Tag{"invite_grant", original}))
	if !s.IsMember("g1", member3) {
		t.Fatal("grant should admit")
	}

	leave := ev(KindLeaveRequest, member3, nostr.Tag{"h", "g1"})
	leave.CreatedAt = nostr.Now() - 50
	mustApply(t, s, leave)

	mustApply(t, s, ev(KindJoinRequest, member3, nostr.Tag{"h", "g1"}, nostr.Tag{"invite_grant", original}))
	if s.IsMember("g1", member3) {
		t.Fatal("a grant minted before the leave must NOT re-admit")
	}
	if g, _ := s.snapshot("g1"); !g.Pending[member3] {
		t.Fatal("the stale-grant request should fall to pending")
	}
}

// TestLegacyGroupKickRecordsRemovalWithoutPanic: a group persisted by a binary that predates
// RemovedAt loads with a nil map; the first kick must lazily initialize it, not panic.
func TestLegacyGroupKickRecordsRemovalWithoutPanic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "groups.json")
	legacy := `{"gL":{"id":"gL","name":"Legacy","closed":true,"owner":"` + owner +
		`","admins":{"` + owner + `":true},"members":{"` + owner + `":true,"` + member3 + `":true}}}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := LoadStore(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	kick := ev(KindRemoveUser, owner, nostr.Tag{"h", "gL"}, nostr.Tag{"p", member3})
	kick.CreatedAt = nostr.Now()
	mustApply(t, s, kick)
	if g, ok := s.snapshot("gL"); !ok || g.RemovedAt[member3] != int64(kick.CreatedAt) {
		t.Fatal("legacy group should record RemovedAt after the first kick")
	}
}
