package policy

import (
	"context"
	"crypto/rsa"
	"strconv"
	"strings"
	"testing"

	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/membership"
)

// minePoW mines a NIP-13 event of the given kind that meets `difficulty` leading zero bits and
// commits that target in its nonce tag, so handlePoW admits it. difficulty 8 is trivial to mine.
func minePoW(t *testing.T, kind, difficulty int, pubkey string) *nostr.Event {
	t.Helper()
	for nonce := 0; ; nonce++ {
		e := &nostr.Event{
			Kind:   kind,
			PubKey: pubkey,
			Tags:   nostr.Tags{{"nonce", strconv.Itoa(nonce), strconv.Itoa(difficulty)}},
		}
		e.ID = e.GetID()
		if membership.LeadingZeroBits(e.ID) >= difficulty {
			return e
		}
	}
}

// ── T4: read-meter mailbox admission (kinds 9026/9027) ─────────────────────────────────────────

// A properly-mined unlock request (9026) / response (9027) is admitted via the enroll-PoW mailbox
// path — even though the kind allow-list here deliberately EXCLUDES them, proving the mailbox branch
// (not the allow-list) admits them. Without the fix, 9026 fell to "not a member" and 9027 to "kind
// not permitted", so the read-meter could never complete.
func TestReadMeterMailboxAdmitted(t *testing.T) {
	sk := testIssuer(t)
	m := NewMembership([]*rsa.PublicKey{&sk.PublicKey}, membership.NewMemStore(), []int{1}, 16, 8)
	for _, kind := range []int{KindUnlockRequest, KindUnlockResponse} {
		if reject, msg := m.RejectEvent(context.Background(), minePoW(t, kind, 8, "ephemeral")); reject {
			t.Fatalf("kind %d with valid enroll-PoW must be admitted: %s", kind, msg)
		}
		// A request with no committed PoW is rejected via the PoW path (not the membership/kind gates).
		bad := &nostr.Event{Kind: kind, PubKey: "ephemeral", Tags: nostr.Tags{{"nonce", "0", "0"}}}
		bad.ID = bad.GetID()
		reject, msg := m.RejectEvent(context.Background(), bad)
		if !reject {
			t.Fatalf("kind %d without PoW must be rejected", kind)
		}
		if !strings.Contains(msg, "proof-of-work") {
			t.Fatalf("kind %d must be rejected via the PoW path, got %q", kind, msg)
		}
	}
}

// ── T7: relay enforces stiq:permissions (separation of powers) ─────────────────────────────────

func TestModPermissionsEnforceScopes(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dModerators, "", nostr.Tag{"p", "mod"}, nostr.Tag{"p", "mod2"})); reject {
		t.Fatal("roster rejected")
	}
	// Before any permissions doc: permissive — a rostered mod holds every scope.
	if reject, _ := h.RejectEvent(context.Background(), modAction("mod", "ban")); reject {
		t.Fatal("without a permissions doc every rostered mod must hold every scope")
	}
	// Organizer publishes permissions: default = hide-post only; "mod" explicitly gets retag only.
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dPermissions, `{"def":["hide-post"],"mods":{"mod":["retag"]}}`)); reject {
		t.Fatalf("permissions doc rejected: %s", msg)
	}
	// "mod" holds only retag: retag allowed; every other action rejected.
	if reject, msg := h.RejectEvent(context.Background(), modAction("mod", "retag")); reject {
		t.Fatalf("mod with retag scope must be allowed to retag: %s", msg)
	}
	for _, a := range []string{"ban", "hide", "lock", "pin", "restore"} {
		if reject, _ := h.RejectEvent(context.Background(), modAction("mod", a)); !reject {
			t.Fatalf("mod lacking the %q scope must be blocked", a)
		}
	}
	// "mod2" is not listed → falls to the default (hide-post): may hide (bare report), not ban.
	if reject, msg := h.RejectEvent(context.Background(), modAction("mod2", "")); reject {
		t.Fatalf("default hide-post scope must allow a hide: %s", msg)
	}
	if reject, _ := h.RejectEvent(context.Background(), modAction("mod2", "ban")); !reject {
		t.Fatal("default scope (hide-post only) must block a ban")
	}
	// The organizer bypasses scope enforcement entirely.
	if reject, _ := h.RejectEvent(context.Background(), modAction(orgPK, "ban")); reject {
		t.Fatal("organizer must bypass scope enforcement")
	}
}

// ── T8a: relay enforces per-tag post-type scope (tsc) ──────────────────────────────────────────

func TestTagScopeEnforced(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	body := `{"ct":["news","quick"],"mem":true,"tsc":{"news":"article","quick":"note"}}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dTagPolicy, body)); reject {
		t.Fatalf("tag policy rejected: %s", msg)
	}
	tagged := func(ev *nostr.Event, tag string) *nostr.Event {
		ev.Tags = nostr.Tags{{"t", tag}}
		return ev
	}
	// article-scoped "news" on a note → rejected; note-scoped "quick" on a note → allowed.
	if reject, _ := h.RejectEvent(context.Background(), tagged(note("member", "x"), "news")); !reject {
		t.Fatal("an article-scoped tag on a note must be rejected")
	}
	if reject, msg := h.RejectEvent(context.Background(), tagged(note("member", "x"), "quick")); reject {
		t.Fatalf("a note-scoped tag on a note must pass: %s", msg)
	}
	// "news" on an article → allowed.
	if reject, msg := h.RejectEvent(context.Background(), tagged(article("member", "x"), "news")); reject {
		t.Fatalf("an article-scoped tag on an article must pass: %s", msg)
	}
	// Organizer is exempt from tag scopes.
	if reject, _ := h.RejectEvent(context.Background(), tagged(note(orgPK, "x"), "news")); reject {
		t.Fatal("organizer must be exempt from tag scopes")
	}
}

// ── T8b: relay enforces author-note (pinned comment) max length ────────────────────────────────

func TestAuthorNoteMaxEnforced(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dPostRules, `{"note":{"mx":0},"article":{"mx":0},"anmx":10}`)); reject {
		t.Fatalf("post-rules rejected: %s", msg)
	}
	pinned := func(pk, content string) *nostr.Event {
		return &nostr.Event{Kind: kindComment, PubKey: pk, Content: content, Tags: nostr.Tags{{"e", "post1"}, {pinMarkerTag, "post1"}}}
	}
	if reject, _ := h.RejectEvent(context.Background(), pinned("member", strings.Repeat("x", 11))); !reject {
		t.Fatal("an over-max author note must be rejected")
	}
	if reject, msg := h.RejectEvent(context.Background(), pinned("member", strings.Repeat("x", 10))); reject {
		t.Fatalf("an author note at exactly the max must pass: %s", msg)
	}
	// A plain comment (no pin marker) is never length-checked.
	plain := &nostr.Event{Kind: kindComment, PubKey: "member", Content: strings.Repeat("x", 1000), Tags: nostr.Tags{{"e", "post1"}}}
	if reject, _ := h.RejectEvent(context.Background(), plain); reject {
		t.Fatal("a plain comment must not be length-checked")
	}
	// Organizer is exempt.
	if reject, _ := h.RejectEvent(context.Background(), pinned(orgPK, strings.Repeat("x", 50))); reject {
		t.Fatal("organizer must be exempt from the author-note cap")
	}
}
