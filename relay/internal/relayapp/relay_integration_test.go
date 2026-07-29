package relayapp

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/config"
	"github.com/stiq/relay/internal/membership"
	"github.com/stiq/relay/internal/policy"
)

func keypair(t *testing.T) (sk, pk string) {
	t.Helper()
	sk = nostr.GeneratePrivateKey()
	pk, err := nostr.GetPublicKey(sk)
	if err != nil {
		t.Fatalf("GetPublicKey: %v", err)
	}
	return sk, pk
}

func signed(t *testing.T, sk string, kind int, content string) *nostr.Event {
	t.Helper()
	ev := &nostr.Event{Kind: kind, CreatedAt: nostr.Now(), Tags: nostr.Tags{}, Content: content}
	if err := ev.Sign(sk); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return ev
}

// issuerKeyPEM generates an RSA issuer keypair and returns the private key plus its public
// key in PEM (what the relay config holds).
func issuerKeyPEM(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	sk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen issuer key: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(&sk.PublicKey)
	if err != nil {
		t.Fatalf("marshal issuer pub: %v", err)
	}
	pemStr := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	return sk, pemStr
}

// makeCredential runs the real RFC 9474 blind flow against the given issuer.
func makeCredential(t *testing.T, issuerSK *rsa.PrivateKey) membership.Credential {
	t.Helper()
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		t.Fatalf("rand token: %v", err)
	}
	issuer := membership.NewIssuer(issuerSK)
	cred, err := membership.RequestCredential(&issuerSK.PublicKey, token, issuer.BlindSign)
	if err != nil {
		t.Fatalf("RequestCredential: %v", err)
	}
	return cred
}

// bindingEvent builds a membership-binding event carrying the credential, signed by member.
func bindingEvent(t *testing.T, memberSK string, cred membership.Credential) *nostr.Event {
	t.Helper()
	ev := &nostr.Event{
		Kind:      policy.KindMembershipBinding,
		CreatedAt: nostr.Now(),
		Tags: nostr.Tags{
			{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
			{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)},
		},
		Content: "",
	}
	if err := ev.Sign(memberSK); err != nil {
		t.Fatalf("Sign binding: %v", err)
	}
	return ev
}

func newTestRelay(t *testing.T, issuerPEM string) string {
	return newTestRelayWithPoW(t, issuerPEM, 0)
}

func newTestRelayWithPoW(t *testing.T, issuerPEM string, pow int) string {
	t.Helper()
	cfg := config.Config{
		Listen:           "127.0.0.1:0",
		IssuerPublicKeys: []string{issuerPEM},
		AllowedKinds:     config.DefaultAllowedKinds,
		PoWDifficulty:    pow,
	}
	relay, closeStore, _, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	srv := httptest.NewServer(relay)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// publish sends one EVENT over a raw WebSocket and returns the relay's OK frame.
func publish(t *testing.T, wsURL string, ev *nostr.Event) (accepted bool, msg string) {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()

	payload, err := json.Marshal([]any{"EVENT", ev})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("write: %v", err)
	}

	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var frame []json.RawMessage
		if err := json.Unmarshal(data, &frame); err != nil || len(frame) < 3 {
			continue
		}
		var typ string
		_ = json.Unmarshal(frame[0], &typ)
		if typ != "OK" {
			continue
		}
		_ = json.Unmarshal(frame[2], &accepted)
		if len(frame) > 3 {
			_ = json.Unmarshal(frame[3], &msg)
		}
		return accepted, msg
	}
}

// reqResult sends one REQ and reports whether the relay CLOSED it (filter rejected) or
// reached EOSE (accepted).
func reqResult(t *testing.T, wsURL string, filter map[string]any) (rejected bool, msg string) {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()

	payload, err := json.Marshal([]any{"REQ", "sub1", filter})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("write: %v", err)
	}

	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var frame []json.RawMessage
		if err := json.Unmarshal(data, &frame); err != nil || len(frame) < 2 {
			continue
		}
		var typ string
		_ = json.Unmarshal(frame[0], &typ)
		switch typ {
		case "CLOSED":
			if len(frame) > 2 {
				_ = json.Unmarshal(frame[2], &msg)
			}
			return true, msg
		case "EOSE", "EVENT":
			return false, ""
		}
	}
}

// bindMember binds a fresh identity and returns its keypair, failing the test on any error.
func bindMember(t *testing.T, ws string, issuerSK *rsa.PrivateKey) (sk, pk string) {
	t.Helper()
	sk, pk = keypair(t)
	if accepted, msg := publish(t, ws, bindingEvent(t, sk, makeCredential(t, issuerSK))); !accepted {
		t.Fatalf("bind should succeed: %q", msg)
	}
	return sk, pk
}

// signedTags builds and signs an event with the given kind and tags.
func signedTags(t *testing.T, sk string, kind int, tags nostr.Tags) *nostr.Event {
	t.Helper()
	ev := &nostr.Event{Kind: kind, CreatedAt: nostr.Now(), Tags: tags, Content: ""}
	if err := ev.Sign(sk); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return ev
}

// TestDeleteGroupPurgesStateEvents is the regression test for the lingering-state bug: deleting
// a group (kind 9008) removed it from the groups store BEFORE state emission ran, so its
// relay-generated 39000-39005 events were never deleted from the backend and kept being served
// for a group that no longer existed.
func TestDeleteGroupPurgesStateEvents(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayPersistent(t, issuerPEM)

	ownerSK, _ := bindMember(t, ws, issuerSK)
	gid := "group-doomed-1"
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9007, nostr.Tags{{"h", gid}, {"name", "Doomed"}, {"open"}})); !ok {
		t.Fatalf("create group should succeed: %q", msg)
	}
	// Open interactions on a post so a per-post 39005 state event exists too.
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9009, nostr.Tags{
		{"h", gid}, {"e", "post1"}, {"comments", "1"}, {"reactions", "1"},
	})); !ok {
		t.Fatalf("set interactions should succeed: %q", msg)
	}

	coreFilter := map[string]any{"kinds": []int{39000, 39001, 39002, 39003, 39004}, "#d": []string{gid}}
	postFilter := map[string]any{"kinds": []int{39005}, "#h": []string{gid}}
	if got := reqEvents(t, ws, coreFilter); len(got) == 0 {
		t.Fatal("expected 39000-39004 state events to be served before deletion")
	}
	if got := reqEvents(t, ws, postFilter); len(got) == 0 {
		t.Fatal("expected a 39005 post-state event to be served before deletion")
	}

	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9008, nostr.Tags{{"h", gid}})); !ok {
		t.Fatalf("delete group should succeed: %q", msg)
	}

	if got := reqEvents(t, ws, coreFilter); len(got) != 0 {
		kinds := make([]int, 0, len(got))
		for _, e := range got {
			kinds = append(kinds, e.Kind)
		}
		t.Fatalf("deleted group's 39000-39004 state events still served: kinds %v", kinds)
	}
	if got := reqEvents(t, ws, postFilter); len(got) != 0 {
		t.Fatalf("deleted group's 39005 post-state events still served: %d events", len(got))
	}
}

// newTestRelayWithReloader is like newTestRelay but returns the Reloader for hot-reload tests.
func newTestRelayWithReloader(t *testing.T, issuerPEM string) (wsURL string, reloader *Reloader) {
	t.Helper()
	cfg := config.Config{
		Listen:           "127.0.0.1:0",
		IssuerPublicKeys: []string{issuerPEM},
		AllowedKinds:     config.DefaultAllowedKinds,
	}
	relay, closeStore, rel, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	srv := httptest.NewServer(relay)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http"), rel
}

func TestSIGHUPReloadsOrganizerPubkeys(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)

	// Start relay with no organizer configured.
	ws, reloader := newTestRelayWithReloader(t, issuerPEM)

	// The keypair that will become the organizer after hot-reload.
	orgSK, orgPK := keypair(t)

	// Phase 1: BEFORE reload — kind-30078 stiq:limits rejected (not a member, not an organizer).
	limitsEvent := signedTags(t, orgSK, policy.KindAppData, nostr.Tags{{"d", "stiq:limits"}})
	if accepted, _ := publish(t, ws, limitsEvent); accepted {
		t.Fatal("expected rejection before hot-reload: key is not an organizer")
	}

	// Phase 2: hot-reload — atomically adds orgPK as organizer (simulates `systemctl reload`).
	reloader.Apply(config.Config{OrganizerPubkeys: []string{orgPK}})

	// Phase 3: AFTER reload — re-sign with a fresh CreatedAt so NIP-33 dedup doesn't fire.
	limitsEvent2 := signedTags(t, orgSK, policy.KindAppData, nostr.Tags{{"d", "stiq:limits"}})
	if accepted, msg := publish(t, ws, limitsEvent2); !accepted {
		t.Fatalf("expected acceptance after hot-reload: %q", msg)
	}

	// Phase 4: a bound non-organizer member must still be rejected for stiq: config events.
	otherSK, _ := bindMember(t, ws, issuerSK)
	impostor := signedTags(t, otherSK, policy.KindAppData, nostr.Tags{{"d", "stiq:limits"}})
	if accepted, _ := publish(t, ws, impostor); accepted {
		t.Fatal("expected rejection: bound member must not publish stiq: config events")
	}
}

// TestSIGHUPReloadsPrivateGroupReadAuth (finding #38 follow-up, 2026-07-21 landmine fix):
// private_group_read_auth used to be wired ONLY at construction (relay.go's old boot-only
// `if cfg.PrivateGroupReadAuth { ... }` branch appending the hook), so an operator who enabled it
// against a client fleet with zero NIP-42 support — blanking every private group with no error —
// could only turn it back OFF with a full relay restart. This proves the fix reloads BOTH
// directions: ON at boot (an unauthenticated read of private group content is rejected, requesting
// auth), a SIGHUP reload flips it OFF and the SAME read now passes with no restart, and a further
// reload flips it back ON and the read is rejected again.
func TestSIGHUPReloadsPrivateGroupReadAuth(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	cfg := config.Config{
		Listen:               "127.0.0.1:0",
		IssuerPublicKeys:     []string{issuerPEM},
		AllowedKinds:         config.DefaultAllowedKinds,
		PrivateGroupReadAuth: true,
	}
	relay, closeStore, reloader, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	srv := httptest.NewServer(relay)
	t.Cleanup(srv.Close)
	ws := "ws" + strings.TrimPrefix(srv.URL, "http")

	ownerSK, _ := bindMember(t, ws, issuerSK)
	gid := "reload-private-group-1"
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9007, nostr.Tags{
		{"h", gid}, {"name", "Reload Club"}, {"closed"}, {"private"},
	})); !ok {
		t.Fatalf("create private group should succeed: %q", msg)
	}

	groupFilter := map[string]any{"kinds": []int{9}, "#h": []string{gid}}

	// Phase 1: BEFORE reload — enforcement ON at boot, so an unauthenticated read of this private
	// group's chat kind is rejected and the relay requests NIP-42 auth.
	if rejected, msg := reqResult(t, ws, groupFilter); !rejected {
		t.Fatal("expected private-group read to be rejected while private_group_read_auth is on")
	} else if !strings.Contains(msg, "auth-required") {
		t.Fatalf("expected an auth-required rejection, got %q", msg)
	}

	// Phase 2: hot-reload — flips private_group_read_auth OFF (simulates `systemctl reload`).
	reloader.Apply(config.Config{PrivateGroupReadAuth: false})

	// Phase 3: AFTER reload — the SAME unauthenticated read now passes, with no relay restart.
	if rejected, msg := reqResult(t, ws, groupFilter); rejected {
		t.Fatalf("expected private-group read to pass after hot-reload disables enforcement: %q", msg)
	}

	// Phase 4: reload back ON — the flag re-enables live too (both directions), not just off→on.
	reloader.Apply(config.Config{PrivateGroupReadAuth: true})
	if rejected, _ := reqResult(t, ws, groupFilter); !rejected {
		t.Fatal("expected private-group read to be rejected again after re-enabling via reload")
	}
}

func TestBroadcastChannelEndToEnd(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)

	// Admin binds and creates a broadcast channel with a gradient.
	adminSK, _ := bindMember(t, ws, issuerSK)
	gid := "chan-broadcast-1"
	if ok, msg := publish(t, ws, signedTags(t, adminSK, 9007, nostr.Tags{
		{"h", gid}, {"name", "Broadcast"}, {"gradient", "grad-1"}, {"broadcast"}, {"open"},
	})); !ok {
		t.Fatalf("create broadcast channel should succeed: %q", msg)
	}

	// The relay-signed 39000 (scoped by #d) should be queryable and carry gradient + broadcast.
	if rejected, msg := reqResult(t, ws, map[string]any{"kinds": []int{39000}, "#d": []string{gid}}); rejected {
		t.Fatalf("scoped 39000 query should be allowed: %q", msg)
	}

	// A second user joins as audience.
	audSK, _ := bindMember(t, ws, issuerSK)
	if ok, msg := publish(t, ws, signedTags(t, audSK, 9021, nostr.Tags{{"h", gid}})); !ok {
		t.Fatalf("join request should succeed: %q", msg)
	}

	// Audience top-level post (kind 9) is rejected (broadcast: admins only).
	if ok, msg := publish(t, ws, signedTags(t, audSK, 9, nostr.Tags{{"h", gid}})); ok {
		t.Fatal("audience kind-9 post must be rejected in a broadcast channel")
	} else if !strings.Contains(msg, "only admins") {
		t.Fatalf("expected admins-only message, got %q", msg)
	}

	// Admin promotes the audience member to admin → their post is now accepted.
	audPK := mustPub(t, audSK)
	if ok, msg := publish(t, ws, signedTags(t, adminSK, 9000, nostr.Tags{{"h", gid}, {"p", audPK, "admin"}})); !ok {
		t.Fatalf("promote should succeed: %q", msg)
	}
	if ok, msg := publish(t, ws, signedTags(t, audSK, 9, nostr.Tags{{"h", gid}})); !ok {
		t.Fatalf("promoted admin kind-9 should be accepted: %q", msg)
	}

	// A third user joins as plain audience.
	aud2SK, _ := bindMember(t, ws, issuerSK)
	if ok, msg := publish(t, ws, signedTags(t, aud2SK, 9021, nostr.Tags{{"h", gid}})); !ok {
		t.Fatalf("third join should succeed: %q", msg)
	}

	// Comment on a closed post → rejected.
	if ok, _ := publish(t, ws, signedTags(t, aud2SK, 12, nostr.Tags{{"h", gid}, {"e", "postOpen"}})); ok {
		t.Fatal("comment on a closed post must be rejected")
	}

	// Admin opens comments on postOpen.
	if ok, msg := publish(t, ws, signedTags(t, adminSK, 9009, nostr.Tags{
		{"h", gid}, {"e", "postOpen"}, {"comments", "1"}, {"reactions", "0"},
	})); !ok {
		t.Fatalf("open comments (9009) should succeed: %q", msg)
	}

	// Now a comment on postOpen is accepted...
	if ok, msg := publish(t, ws, signedTags(t, aud2SK, 12, nostr.Tags{{"h", gid}, {"e", "postOpen"}})); !ok {
		t.Fatalf("comment on an opened post should be accepted: %q", msg)
	}
	// ...but a comment on a different (closed) post is rejected.
	if ok, _ := publish(t, ws, signedTags(t, aud2SK, 12, nostr.Tags{{"h", gid}, {"e", "postClosed"}})); ok {
		t.Fatal("comment on a different closed post must be rejected")
	}
}

func TestGroupChatRoundTripsOverWebsocket(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)

	ownerSK, _ := bindMember(t, ws, issuerSK)
	gid := "group-chat-1"
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9007, nostr.Tags{{"h", gid}, {"name", "Chat"}, {"open"}})); !ok {
		t.Fatalf("create group should succeed: %q", msg)
	}

	memberSK, _ := bindMember(t, ws, issuerSK)
	if ok, msg := publish(t, ws, signedTags(t, memberSK, 9021, nostr.Tags{{"h", gid}})); !ok {
		t.Fatalf("join should succeed: %q", msg)
	}
	// A plain member may post in a normal (non-broadcast) group.
	if ok, msg := publish(t, ws, signedTags(t, memberSK, 9, nostr.Tags{{"h", gid}})); !ok {
		t.Fatalf("member chat should be accepted: %q", msg)
	}
}

func TestNIP11AdvertisesGroupsAndChannels(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)
	httpURL := "http" + strings.TrimPrefix(ws, "ws")

	req, err := http.NewRequest("GET", httpURL, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Accept", "application/nostr+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET relay info: %v", err)
	}
	defer resp.Body.Close()

	var info struct {
		SupportedNIPs []int `json:"supported_nips"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		t.Fatalf("decode nip-11: %v", err)
	}
	has := func(n int) bool {
		for _, s := range info.SupportedNIPs {
			if s == n {
				return true
			}
		}
		return false
	}
	if !has(29) || !has(53) {
		t.Fatalf("supported_nips %v must contain 29 and 53", info.SupportedNIPs)
	}
}

func mustPub(t *testing.T, sk string) string {
	t.Helper()
	pk, err := nostr.GetPublicKey(sk)
	if err != nil {
		t.Fatalf("GetPublicKey: %v", err)
	}
	return pk
}

// newTestRelayPersistent builds a relay backed by a real badger store in a temp DataDir, so the
// replaceable-event path (db.ReplaceEvent) that production uses for group state is exercised.
func newTestRelayPersistent(t *testing.T, issuerPEM string) string {
	t.Helper()
	cfg := config.Config{
		Listen:           "127.0.0.1:0",
		IssuerPublicKeys: []string{issuerPEM},
		AllowedKinds:     config.DefaultAllowedKinds,
		DataDir:          t.TempDir(),
	}
	relay, closeStore, _, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	srv := httptest.NewServer(relay)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// reqEvents sends one REQ and collects every EVENT frame the relay returns before EOSE. This is
// exactly how a REQ is served, so counting the results tells us how many stored copies of a
// (kind, d) coordinate actually exist.
func reqEvents(t *testing.T, wsURL string, filter map[string]any) []nostr.Event {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()

	payload, err := json.Marshal([]any{"REQ", "sub1", filter})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("write: %v", err)
	}

	var events []nostr.Event
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var frame []json.RawMessage
		if err := json.Unmarshal(data, &frame); err != nil || len(frame) < 2 {
			continue
		}
		var typ string
		_ = json.Unmarshal(frame[0], &typ)
		switch typ {
		case "EVENT":
			if len(frame) >= 3 {
				var ev nostr.Event
				if err := json.Unmarshal(frame[2], &ev); err == nil {
					events = append(events, ev)
				}
			}
		case "EOSE":
			return events
		case "CLOSED":
			t.Fatalf("REQ unexpectedly CLOSED: %s", string(data))
		}
	}
}

// TestGroupStateReplacesNotAccumulates is the finding #26 regression: publishing multiple
// versions of the same group-state coordinate (kind, d) must leave exactly one stored copy,
// because the relay routes relay-generated state through ReplaceEvent (addressable kinds).
func TestGroupStateReplacesNotAccumulates(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayPersistent(t, issuerPEM)

	ownerSK, _ := bindMember(t, ws, issuerSK)
	gid := "grp-replace-1"

	// Create the group, then perform several management events that each re-emit the member list
	// (39002) with a NEW created_at (hence a new event id): joins by three distinct members.
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9007, nostr.Tags{{"h", gid}, {"name", "G"}, {"open"}})); !ok {
		t.Fatalf("create should succeed: %q", msg)
	}
	for i := 0; i < 3; i++ {
		mSK, _ := bindMember(t, ws, issuerSK)
		if ok, msg := publish(t, ws, signedTags(t, mSK, 9021, nostr.Tags{{"h", gid}})); !ok {
			t.Fatalf("join %d should succeed: %q", i, msg)
		}
	}

	// The member list (39002) has been re-emitted several times. Query it the way a REQ serves it.
	members := reqEvents(t, ws, map[string]any{"kinds": []int{39002}, "#d": []string{gid}})
	if len(members) != 1 {
		t.Fatalf("expected exactly ONE stored 39002 member list after repeated re-emission, got %d "+
			"(raw SaveEvent would accumulate one per management event)", len(members))
	}
	// And it must be the newest one (all four members: owner + 3 joiners).
	var pCount int
	for _, tag := range members[0].Tags {
		if len(tag) >= 2 && tag[0] == "p" {
			pCount++
		}
	}
	if pCount != 4 {
		t.Fatalf("the single retained member list must be the newest (4 members), got %d p-tags", pCount)
	}

	// The base metadata (39000) likewise has exactly one copy.
	meta := reqEvents(t, ws, map[string]any{"kinds": []int{39000}, "#d": []string{gid}})
	if len(meta) != 1 {
		t.Fatalf("expected exactly one stored 39000 metadata event, got %d", len(meta))
	}
}

func TestRelayRejectsUnscopedDiscovery(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)

	rejected, msg := reqResult(t, ws, map[string]any{"kinds": []int{40}})
	if !rejected {
		t.Fatal("expected an unscoped channel query to be rejected (§3.8)")
	}
	if !strings.Contains(msg, "discovery") {
		t.Fatalf("expected a discovery message, got %q", msg)
	}
}

func TestRelayAllowsScopedDiscovery(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)
	_, pk := keypair(t)

	rejected, _ := reqResult(t, ws, map[string]any{"kinds": []int{40}, "authors": []string{pk}})
	if rejected {
		t.Fatal("expected a scoped (author) channel query to be allowed")
	}
}

func TestRelayBindsThenAcceptsMemberPosts(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)
	memberSK, _ := keypair(t)

	// Bind a fresh on-device identity with a real blind credential.
	bindAccepted, bindMsg := publish(t, ws, bindingEvent(t, memberSK, makeCredential(t, issuerSK)))
	if !bindAccepted {
		t.Fatalf("expected binding accepted, relay said: %q", bindMsg)
	}

	// The now-bound member can post.
	postAccepted, postMsg := publish(t, ws, signed(t, memberSK, 1, "hello from a member"))
	if !postAccepted {
		t.Fatalf("expected member post accepted, relay said: %q", postMsg)
	}
}

func TestRelayRejectsNonMemberPosts(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)
	strangerSK, _ := keypair(t) // never bound

	accepted, msg := publish(t, ws, signed(t, strangerSK, 1, "hello"))
	if accepted {
		t.Fatal("expected reject for a non-member, relay accepted")
	}
	if !strings.Contains(msg, "not a member") {
		t.Fatalf("expected a not-a-member message, got %q", msg)
	}
}

func TestRelayRejectsReusedCredential(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)
	cred := makeCredential(t, issuerSK)

	memberA, _ := keypair(t)
	if accepted, msg := publish(t, ws, bindingEvent(t, memberA, cred)); !accepted {
		t.Fatalf("first bind should succeed: %q", msg)
	}

	memberB, _ := keypair(t)
	accepted, msg := publish(t, ws, bindingEvent(t, memberB, cred)) // same credential
	if accepted {
		t.Fatal("expected reject when reusing a spent credential")
	}
	if !strings.Contains(msg, "already used") {
		t.Fatalf("expected an already-used message, got %q", msg)
	}
}

func TestRelayRejectsForeignCredential(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t) // relay trusts this issuer
	otherIssuerSK, _ := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)
	memberSK, _ := keypair(t)

	// Credential signed by an issuer the relay does NOT trust.
	accepted, msg := publish(t, ws, bindingEvent(t, memberSK, makeCredential(t, otherIssuerSK)))
	if accepted {
		t.Fatal("expected reject for a credential from an untrusted issuer")
	}
	if !strings.Contains(msg, "invalid membership credential") {
		t.Fatalf("expected an invalid-credential message, got %q", msg)
	}
}

func TestRelayRejectsDisallowedKindFromMember(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)
	memberSK, _ := keypair(t)

	if accepted, msg := publish(t, ws, bindingEvent(t, memberSK, makeCredential(t, issuerSK))); !accepted {
		t.Fatalf("bind should succeed: %q", msg)
	}

	// kind 1059 is handled by the PoW path, not the member-kind path. With PoW disabled
	// (this relay), a DM is rejected as disabled.
	accepted, msg := publish(t, ws, signed(t, memberSK, 1059, "dm"))
	if accepted {
		t.Fatal("expected reject for kind 1059 with DMs disabled")
	}
	if !strings.Contains(msg, "disabled") {
		t.Fatalf("expected a DMs-disabled message, got %q", msg)
	}
}

// minedPoWEvent produces an ephemeral-signed event of the given kind with NIP-13 PoW at the
// given difficulty and a matching committed target in the nonce tag.
func minedPoWEvent(t *testing.T, kind, difficulty int) *nostr.Event {
	t.Helper()
	sk := nostr.GeneratePrivateKey()
	for nonce := 0; ; nonce++ {
		ev := &nostr.Event{
			Kind:      kind,
			CreatedAt: nostr.Now(),
			Tags:      nostr.Tags{{"nonce", strconv.Itoa(nonce), strconv.Itoa(difficulty)}},
			Content:   "ephemeral pow content",
		}
		if err := ev.Sign(sk); err != nil {
			t.Fatalf("Sign: %v", err)
		}
		if membership.LeadingZeroBits(ev.ID) >= difficulty {
			return ev
		}
	}
}

func minedGiftWrap(t *testing.T, difficulty int) *nostr.Event {
	return minedPoWEvent(t, 1059, difficulty)
}

func TestRelayAcceptsGiftWrapWithPoW(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayWithPoW(t, issuerPEM, 8)

	accepted, msg := publish(t, ws, minedGiftWrap(t, 8))
	if !accepted {
		t.Fatalf("expected gift wrap with PoW accepted, relay said: %q", msg)
	}
}

func TestRelayRejectsAnonCommentFromNonMember(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayWithPoW(t, issuerPEM, 8)

	// Anonymous comments are removed: a kind-1111 from a non-member is rejected even WITH PoW.
	// All comments must now be signed by a bound member.
	accepted, msg := publish(t, ws, minedPoWEvent(t, 1111, 8))
	if accepted {
		t.Fatal("expected reject: anonymous comments removed, non-members cannot comment")
	}
	if !strings.Contains(msg, "not a member") {
		t.Fatalf("expected a not-a-member message, got %q", msg)
	}
}

func TestRelayAcceptsEnrollMailboxWithPoW(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayWithPoW(t, issuerPEM, 8)

	// The credential-exchange mailbox: a not-yet-bound member's request (9020) and the
	// organizer's response (9021) are both ephemeral-signed and admitted via PoW, exactly
	// like gift wraps — so the automated, unlinkable exchange works before binding.
	for _, kind := range []int{policy.KindEnrollRequest, policy.KindEnrollResponse} {
		accepted, msg := publish(t, ws, minedPoWEvent(t, kind, 8))
		if !accepted {
			t.Fatalf("expected enroll mailbox kind %d with PoW accepted, relay said: %q", kind, msg)
		}
	}
}

func TestRelayRejectsEnrollMailboxWithoutPoW(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayWithPoW(t, issuerPEM, 8)

	// An enroll request committing to difficulty 0 — rejected by the committed-PoW check, so
	// the mailbox can't become a spam/DDoS channel for unbound senders.
	sk := nostr.GeneratePrivateKey()
	ev := &nostr.Event{
		Kind:      policy.KindEnrollRequest,
		CreatedAt: nostr.Now(),
		Tags:      nostr.Tags{{"nonce", "0", "0"}},
		Content:   "no pow",
	}
	if err := ev.Sign(sk); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	accepted, msg := publish(t, ws, ev)
	if accepted {
		t.Fatal("expected reject for an enroll request without committed PoW")
	}
	if !strings.Contains(msg, "proof-of-work") {
		t.Fatalf("expected a proof-of-work message, got %q", msg)
	}
}

func TestRelayRejectsGiftWrapWithoutPoW(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelayWithPoW(t, issuerPEM, 8)

	// A 1059 committing to difficulty 0 — rejected deterministically by the committed check.
	sk := nostr.GeneratePrivateKey()
	ev := &nostr.Event{
		Kind:      1059,
		CreatedAt: nostr.Now(),
		Tags:      nostr.Tags{{"nonce", "0", "0"}},
		Content:   "no pow",
	}
	if err := ev.Sign(sk); err != nil {
		t.Fatalf("Sign: %v", err)
	}
	accepted, msg := publish(t, ws, ev)
	if accepted {
		t.Fatal("expected reject for a gift wrap without committed PoW")
	}
	if !strings.Contains(msg, "proof-of-work") {
		t.Fatalf("expected a proof-of-work message, got %q", msg)
	}
}

// openSubscription dials a fresh WebSocket, sends a standing REQ, and drains the stored matches
// through EOSE — returning the still-open connection so the caller can read events the relay
// PUSHES afterwards. This is how a client's live group subscription behaves: it sees the current
// state, then waits for updates. The caller closes the connection.
func openSubscription(t *testing.T, wsURL, subID string, filter map[string]any) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	payload, err := json.Marshal([]any{"REQ", subID, filter})
	if err != nil {
		t.Fatalf("marshal REQ: %v", err)
	}
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("write REQ: %v", err)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read to EOSE: %v", err)
		}
		var frame []json.RawMessage
		if err := json.Unmarshal(data, &frame); err != nil || len(frame) < 1 {
			continue
		}
		var typ string
		_ = json.Unmarshal(frame[0], &typ)
		if typ == "EOSE" {
			return c
		}
	}
}

// readPushedEvent reads frames on an already-open subscription until it sees an EVENT for subID
// (what a relay-side BroadcastEvent delivers) or the deadline fires. Returns the parsed event.
func readPushedEvent(t *testing.T, c *websocket.Conn, subID string, within time.Duration) *nostr.Event {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(within))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("no EVENT pushed to the open subscription within %s: %v", within, err)
		}
		var frame []json.RawMessage
		if err := json.Unmarshal(data, &frame); err != nil || len(frame) < 3 {
			continue
		}
		var typ, sub string
		_ = json.Unmarshal(frame[0], &typ)
		_ = json.Unmarshal(frame[1], &sub)
		if typ != "EVENT" || sub != subID {
			continue
		}
		var ev nostr.Event
		if err := json.Unmarshal(frame[2], &ev); err != nil {
			t.Fatalf("decode pushed event: %v", err)
		}
		return &ev
	}
}

// TestApprovedMemberBroadcastLive is the regression test for the membership-approval delivery
// bug. When an admin approves a pending join request (kind 9000), the relay regenerates the
// group's 39002 member list and stores it via db.ReplaceEvent — a path that BYPASSES khatru's
// notifyListeners (that only runs for client-published events, see khatru/handlers.go). Before
// the fix, an already-subscribed requester therefore received nothing on approval and the space
// stayed hidden from their channels tab until a reconnect re-REQ'd the group. The fix
// BroadcastEvents relay-generated state; this asserts the updated 39002 is PUSHED to a live
// subscription (no re-REQ) and lists the newly approved member.
func TestApprovedMemberBroadcastLive(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)

	// Owner creates a CLOSED group: a join request queues as Pending until an admin approves,
	// so the later 9000 genuinely changes the member set (and re-emits 39002).
	ownerSK, _ := bindMember(t, ws, issuerSK)
	gid := "closed-approve-live-1"
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9007, nostr.Tags{
		{"h", gid}, {"name", "Closed"}, {"closed"},
	})); !ok {
		t.Fatalf("create closed group should succeed: %q", msg)
	}

	// A requester asks to join → lands in the pending queue, not yet a member.
	reqSK, _ := bindMember(t, ws, issuerSK)
	reqPK := mustPub(t, reqSK)
	if ok, msg := publish(t, ws, signedTags(t, reqSK, 9021, nostr.Tags{{"h", gid}})); !ok {
		t.Fatalf("join request should succeed: %q", msg)
	}

	// The requester opens a LIVE subscription to the member list and drains the current state
	// (owner only) through EOSE — exactly what the client's subscribeGroup does while pending.
	sub := openSubscription(t, ws, "members", map[string]any{"kinds": []int{39002}, "#d": []string{gid}})
	defer sub.Close()

	// Owner approves on a SEPARATE connection (publish dials its own socket).
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9000, nostr.Tags{{"h", gid}, {"p", reqPK}})); !ok {
		t.Fatalf("approve (9000 add-user) should succeed: %q", msg)
	}

	// The heart of the regression: the updated 39002 must be PUSHED to the open subscription,
	// and it must now list the requester. Before the fix nothing arrived here and the read timed out.
	ev := readPushedEvent(t, sub, "members", 5*time.Second)
	if ev.Kind != 39002 {
		t.Fatalf("expected a pushed 39002 member list, got kind %d", ev.Kind)
	}
	found := false
	for _, tag := range ev.Tags {
		if len(tag) >= 2 && tag[0] == "p" && tag[1] == reqPK {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("pushed 39002 does not list the approved member %s: tags %v", reqPK, ev.Tags)
	}
}

// stateListsPubkey REQs the latest relay-generated state event of `kind` for group `gid` and
// reports whether it carries a ['p', pk] tag (member/admin/pending membership).
func stateListsPubkey(t *testing.T, wsURL string, kind int, gid, pk string) bool {
	t.Helper()
	for _, ev := range reqEvents(t, wsURL, map[string]any{"kinds": []int{kind}, "#d": []string{gid}}) {
		if ev.Kind != kind {
			continue
		}
		for _, tag := range ev.Tags {
			if len(tag) >= 2 && tag[0] == "p" && tag[1] == pk {
				return true
			}
		}
	}
	return false
}

// TestInviteAcceptQueuesPending is the wire-level baseline for the accept-first invite flow: a
// bound community member who is NOT yet a group member taps Accept, sending a 9021 marked
// ['invite'] for a CLOSED group. The relay must accept it and queue them in the 39004 pending
// set (not yet a member). If this ever failed, the invitee's accept would never reach the queue
// and no admin — online or not — could approve it.
func TestInviteAcceptQueuesPending(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)

	ownerSK, _ := bindMember(t, ws, issuerSK)
	gid := "invite-accept-pending-1"
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9007, nostr.Tags{
		{"h", gid}, {"name", "Club"}, {"closed"}, {"private"},
	})); !ok {
		t.Fatalf("create closed group should succeed: %q", msg)
	}

	inviteeSK, _ := bindMember(t, ws, issuerSK)
	inviteePK := mustPub(t, inviteeSK)
	if ok, msg := publish(t, ws, signedTags(t, inviteeSK, 9021, nostr.Tags{
		{"h", gid}, {"invite"},
	})); !ok {
		t.Fatalf("invite-accept 9021 should be accepted by the relay: %q", msg)
	}

	if !stateListsPubkey(t, ws, 39004, gid, inviteePK) {
		t.Fatalf("invitee %s should be in the 39004 pending set after accepting", inviteePK)
	}
	if stateListsPubkey(t, ws, 39002, gid, inviteePK) {
		t.Fatalf("invitee %s must NOT be a member yet (no admin approved)", inviteePK)
	}
}

// signedInviteGrant builds an admin-signed invite grant (kind 9010: invited=invitedPk, group=gid,
// expiring at exp unix-seconds) and returns it base64-encoded exactly as it rides in a 9021's
// invite_grant tag. Mirrors what the inviting admin's client produces.
func signedInviteGrant(t *testing.T, signerSK, gid, invitedPk string, exp int64) string {
	t.Helper()
	grant := &nostr.Event{
		Kind:      9010,
		CreatedAt: nostr.Now(),
		Tags:      nostr.Tags{{"h", gid}, {"p", invitedPk}, {"exp", strconv.FormatInt(exp, 10)}},
		Content:   "",
	}
	if err := grant.Sign(signerSK); err != nil {
		t.Fatalf("sign invite grant: %v", err)
	}
	raw, err := json.Marshal(grant)
	if err != nil {
		t.Fatalf("marshal invite grant: %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// TestInviteGrantAdmitsMemberDirectly is the core of the accept-first invite fix: an invitee who
// attaches a valid admin-signed invite grant to their 9021 is admitted to the group IMMEDIATELY —
// no online admin needed. They land in the 39002 member list, not the 39004 pending queue.
func TestInviteGrantAdmitsMemberDirectly(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)

	ownerSK, _ := bindMember(t, ws, issuerSK)
	gid := "invite-grant-direct-1"
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9007, nostr.Tags{
		{"h", gid}, {"name", "Club"}, {"closed"}, {"private"},
	})); !ok {
		t.Fatalf("create closed group should succeed: %q", msg)
	}

	inviteeSK, _ := bindMember(t, ws, issuerSK)
	inviteePK := mustPub(t, inviteeSK)
	grant := signedInviteGrant(t, ownerSK, gid, inviteePK, int64(nostr.Now())+3600)

	// The invitee opens a LIVE member-list subscription (as the client does on accept) and drains
	// the current state (owner only) through EOSE — BEFORE sending their grant-bearing 9021.
	sub := openSubscription(t, ws, "members", map[string]any{"kinds": []int{39002}, "#d": []string{gid}})
	defer sub.Close()

	if ok, msg := publish(t, ws, signedTags(t, inviteeSK, 9021, nostr.Tags{
		{"h", gid}, {"invite"}, {"invite_grant", grant},
	})); !ok {
		t.Fatalf("invite-accept 9021 with a valid grant should be accepted: %q", msg)
	}

	// The heart of the fix: with NO admin action at all, the invitee's own accept makes them a
	// member, and the updated 39002 is PUSHED to their open subscription — the space surfaces on
	// their channels tab live.
	ev := readPushedEvent(t, sub, "members", 5*time.Second)
	if ev.Kind != 39002 {
		t.Fatalf("expected a pushed 39002 member list, got kind %d", ev.Kind)
	}
	found := false
	for _, tag := range ev.Tags {
		if len(tag) >= 2 && tag[0] == "p" && tag[1] == inviteePK {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("pushed 39002 does not list the grant-admitted invitee %s: tags %v", inviteePK, ev.Tags)
	}
	if stateListsPubkey(t, ws, 39004, gid, inviteePK) {
		t.Fatalf("invitee %s should NOT be pending (39004) — the grant admits directly", inviteePK)
	}
}

// TestInviteGrantInvalidFallsToPending checks that every way a grant can be illegitimate falls
// back to the pending queue (the safe default), never to direct membership. The 9021 itself is
// always accepted — an invalid grant is simply ignored, not a hard reject.
func TestInviteGrantInvalidFallsToPending(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)

	ownerSK, _ := bindMember(t, ws, issuerSK)
	gid := "invite-grant-invalid-1"
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9007, nostr.Tags{
		{"h", gid}, {"name", "Club"}, {"closed"}, {"private"},
	})); !ok {
		t.Fatalf("create closed group should succeed: %q", msg)
	}
	// A second closed group the owner also admins, to exercise cross-group replay.
	otherGid := "invite-grant-invalid-other-1"
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9007, nostr.Tags{
		{"h", otherGid}, {"name", "Other"}, {"closed"},
	})); !ok {
		t.Fatalf("create other group should succeed: %q", msg)
	}
	nonAdminSK, _ := bindMember(t, ws, issuerSK)

	cases := []struct {
		name  string
		grant func(inviteePK string) string
	}{
		{"signed by a non-admin", func(pk string) string {
			return signedInviteGrant(t, nonAdminSK, gid, pk, int64(nostr.Now())+3600)
		}},
		{"issued for a different pubkey", func(string) string {
			return signedInviteGrant(t, ownerSK, gid, strings.Repeat("ab", 32), int64(nostr.Now())+3600)
		}},
		{"issued for a different group", func(pk string) string {
			return signedInviteGrant(t, ownerSK, otherGid, pk, int64(nostr.Now())+3600)
		}},
		{"expired", func(pk string) string {
			return signedInviteGrant(t, ownerSK, gid, pk, int64(nostr.Now())-1)
		}},
		{"not base64", func(string) string { return "not-base64!!" }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			inviteeSK, _ := bindMember(t, ws, issuerSK)
			inviteePK := mustPub(t, inviteeSK)
			ev := signedTags(t, inviteeSK, 9021, nostr.Tags{
				{"h", gid}, {"invite"}, {"invite_grant", tc.grant(inviteePK)},
			})
			if ok, msg := publish(t, ws, ev); !ok {
				t.Fatalf("9021 should still be accepted (invalid grant is ignored, not rejected): %q", msg)
			}
			if stateListsPubkey(t, ws, 39002, gid, inviteePK) {
				t.Fatalf("invitee %s must NOT be a member on an invalid grant (%s)", inviteePK, tc.name)
			}
			if !stateListsPubkey(t, ws, 39004, gid, inviteePK) {
				t.Fatalf("invitee %s should fall to pending on an invalid grant (%s)", inviteePK, tc.name)
			}
		})
	}
}

// signedInviteGrantAt is signedInviteGrant with an explicit CreatedAt — the staleness tests need
// to control where the grant's mint time falls relative to a kick/leave.
func signedInviteGrantAt(t *testing.T, signerSK, gid, invitedPk string, exp int64, at nostr.Timestamp) string {
	t.Helper()
	grant := &nostr.Event{
		Kind:      9010,
		CreatedAt: at,
		Tags:      nostr.Tags{{"h", gid}, {"p", invitedPk}, {"exp", strconv.FormatInt(exp, 10)}},
		Content:   "",
	}
	if err := grant.Sign(signerSK); err != nil {
		t.Fatalf("sign invite grant: %v", err)
	}
	raw, err := json.Marshal(grant)
	if err != nil {
		t.Fatalf("marshal invite grant: %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// staleGrantFixture builds the shared setup for the grant-staleness tests: a closed+private group,
// an invitee admitted via an ORIGINAL grant (minted in the past), and returns everything needed to
// remove them and try re-admission.
func staleGrantFixture(t *testing.T, gid string) (ws, ownerSK, inviteeSK, inviteePK, originalGrant string) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws = newTestRelay(t, issuerPEM)

	ownerSK, _ = bindMember(t, ws, issuerSK)
	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9007, nostr.Tags{
		{"h", gid}, {"name", "Club"}, {"closed"}, {"private"},
	})); !ok {
		t.Fatalf("create closed group should succeed: %q", msg)
	}

	inviteeSK, _ = bindMember(t, ws, issuerSK)
	inviteePK = mustPub(t, inviteeSK)
	// The original invite grant, minted well before any removal.
	originalGrant = signedInviteGrantAt(t, ownerSK, gid, inviteePK, int64(nostr.Now())+3600, nostr.Now()-100)

	if ok, msg := publish(t, ws, signedTags(t, inviteeSK, 9021, nostr.Tags{
		{"h", gid}, {"invite"}, {"invite_grant", originalGrant},
	})); !ok {
		t.Fatalf("grant-bearing 9021 should be accepted: %q", msg)
	}
	if !stateListsPubkey(t, ws, 39002, gid, inviteePK) {
		t.Fatalf("baseline: the original grant should have admitted %s", inviteePK)
	}
	return ws, ownerSK, inviteeSK, inviteePK, originalGrant
}

// TestStaleGrantAfterKickFallsToPending closes the self-readmit hole: a kicked member replaying
// the grant from their original invite DM lands in the PENDING queue (a real admin decision is
// required again), never back in the member list.
func TestStaleGrantAfterKickFallsToPending(t *testing.T) {
	gid := "stale-grant-kick-1"
	ws, ownerSK, inviteeSK, inviteePK, originalGrant := staleGrantFixture(t, gid)

	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9001, nostr.Tags{
		{"h", gid}, {"p", inviteePK},
	})); !ok {
		t.Fatalf("kick should succeed: %q", msg)
	}
	if stateListsPubkey(t, ws, 39002, gid, inviteePK) {
		t.Fatalf("invitee should be out of the member list after the kick")
	}

	// The kicked member replays the ORIGINAL grant.
	if ok, msg := publish(t, ws, signedTags(t, inviteeSK, 9021, nostr.Tags{
		{"h", gid}, {"invite"}, {"invite_grant", originalGrant},
	})); !ok {
		t.Fatalf("the replayed 9021 is still accepted as an event: %q", msg)
	}
	if stateListsPubkey(t, ws, 39002, gid, inviteePK) {
		t.Fatalf("a grant minted before the kick must NOT re-admit %s", inviteePK)
	}
	if !stateListsPubkey(t, ws, 39004, gid, inviteePK) {
		t.Fatalf("the stale-grant request should fall to pending")
	}
}

// TestFreshGrantAfterKickReadmits proves the staleness gate doesn't break a deliberate re-invite:
// a grant minted strictly AFTER the kick admits directly, exactly like a first-time invite.
func TestFreshGrantAfterKickReadmits(t *testing.T) {
	gid := "stale-grant-fresh-1"
	ws, ownerSK, inviteeSK, inviteePK, _ := staleGrantFixture(t, gid)

	if ok, msg := publish(t, ws, signedTags(t, ownerSK, 9001, nostr.Tags{
		{"h", gid}, {"p", inviteePK},
	})); !ok {
		t.Fatalf("kick should succeed: %q", msg)
	}

	// A deliberate re-invite: a FRESH grant minted strictly after the kick.
	fresh := signedInviteGrantAt(t, ownerSK, gid, inviteePK, int64(nostr.Now())+3600, nostr.Now()+2)
	if ok, msg := publish(t, ws, signedTags(t, inviteeSK, 9021, nostr.Tags{
		{"h", gid}, {"invite"}, {"invite_grant", fresh},
	})); !ok {
		t.Fatalf("fresh-grant 9021 should be accepted: %q", msg)
	}
	if !stateListsPubkey(t, ws, 39002, gid, inviteePK) {
		t.Fatalf("a fresh grant minted after the kick should re-admit %s", inviteePK)
	}
	if stateListsPubkey(t, ws, 39004, gid, inviteePK) {
		t.Fatalf("re-admitted invitee should not linger in pending")
	}
}

// TestStaleGrantAfterVoluntaryLeaveFallsToPending: leaving on your own also invalidates your older
// grants — rejoining needs a fresh invite or the normal pending-approval path.
func TestStaleGrantAfterVoluntaryLeaveFallsToPending(t *testing.T) {
	gid := "stale-grant-leave-1"
	ws, _, inviteeSK, inviteePK, originalGrant := staleGrantFixture(t, gid)

	if ok, msg := publish(t, ws, signedTags(t, inviteeSK, 9022, nostr.Tags{{"h", gid}})); !ok {
		t.Fatalf("leave should succeed: %q", msg)
	}
	if stateListsPubkey(t, ws, 39002, gid, inviteePK) {
		t.Fatalf("invitee should be out of the member list after leaving")
	}

	if ok, msg := publish(t, ws, signedTags(t, inviteeSK, 9021, nostr.Tags{
		{"h", gid}, {"invite"}, {"invite_grant", originalGrant},
	})); !ok {
		t.Fatalf("the replayed 9021 is still accepted as an event: %q", msg)
	}
	if stateListsPubkey(t, ws, 39002, gid, inviteePK) {
		t.Fatalf("a grant minted before the leave must NOT re-admit %s", inviteePK)
	}
	if !stateListsPubkey(t, ws, 39004, gid, inviteePK) {
		t.Fatalf("the stale-grant request should fall to pending")
	}
}

// countResult sends one COUNT frame and reports whether the relay refused it. khatru's rejection
// shape for COUNT is NOT a CLOSED frame: handleCountRequest writes a NOTICE with the reject reason
// and returns early (the store is never queried), then the outer handler still emits a COUNT
// envelope with count 0. So "rejected" here = a NOTICE arrived before the COUNT, and the COUNT that
// follows must be 0.
func countResult(t *testing.T, wsURL string, filter map[string]any) (rejected bool, msg string) {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	payload, err := json.Marshal([]any{"COUNT", "cnt1", filter})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	sawNotice := false
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var frame []json.RawMessage
		if err := json.Unmarshal(data, &frame); err != nil || len(frame) < 2 {
			continue
		}
		var typ string
		_ = json.Unmarshal(frame[0], &typ)
		switch typ {
		case "NOTICE":
			sawNotice = true
			_ = json.Unmarshal(frame[1], &msg)
		case "COUNT":
			if sawNotice {
				var body struct {
					Count *int64 `json:"count"`
				}
				if len(frame) > 2 {
					_ = json.Unmarshal(frame[2], &body)
				}
				if body.Count != nil && *body.Count != 0 {
					t.Fatalf("rejected COUNT must not leak a tally, got %d", *body.Count)
				}
			}
			return sawNotice, msg
		}
	}
}

// Membership bindings are write-only at the wire: an explicit kind-9011 REQ or COUNT is refused
// outright (even scoped — there is no legitimate reader; the member roll ships via the organizer's
// encrypted stiq:member-roll doc), and a kind-less read never leaks a stored binding.
func TestBindingReadsClosed(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	ws := newTestRelay(t, issuerPEM)
	memberSK, memberPK := bindMember(t, ws, issuerSK)

	if rejected, msg := reqResult(t, ws, map[string]any{"kinds": []int{9011}}); !rejected {
		t.Fatalf("unscoped kind-9011 REQ must be rejected, got served (%q)", msg)
	}
	if rejected, _ := reqResult(t, ws, map[string]any{"kinds": []int{9011}, "authors": []string{memberPK}}); !rejected {
		t.Fatalf("author-scoped kind-9011 REQ must still be rejected (membership oracle)")
	}
	if rejected, _ := reqResult(t, ws, map[string]any{"kinds": []int{1, 9011}}); !rejected {
		t.Fatalf("mixed-kind REQ naming 9011 must be rejected")
	}
	if rejected, _ := countResult(t, ws, map[string]any{"kinds": []int{9011}, "authors": []string{memberPK}}); !rejected {
		t.Fatalf("kind-9011 COUNT must be rejected")
	}

	// A kind-less, author-scoped REQ passes the guards — but must never surface the binding event.
	// The member's ordinary content still serves, proving suppression is kind-targeted.
	note := signed(t, memberSK, 1, "hello roll")
	if accepted, msg := publish(t, ws, note); !accepted {
		t.Fatalf("bound member note should publish: %q", msg)
	}
	got := reqEvents(t, ws, map[string]any{"authors": []string{memberPK}})
	for _, ev := range got {
		if ev.Kind == 9011 {
			t.Fatalf("kind-less read leaked a membership binding")
		}
	}
	sawNote := false
	for _, ev := range got {
		if ev.Kind == 1 && ev.Content == "hello roll" {
			sawNote = true
		}
	}
	if !sawNote {
		t.Fatalf("suppression must not swallow ordinary content (note missing from author read)")
	}
}
