package policy

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

const orgPK = "organizer-pubkey"

// appDataSeq gives each appData event a strictly-increasing CreatedAt, mirroring a real organizer
// that republishes config with a newer timestamp each time. Without this the replay/monotonicity
// guard (finding #17) would treat two zero-CreatedAt events as non-superseding and ignore the second.
var appDataSeq nostr.Timestamp

func appData(pubkey, d string, content string, tags ...nostr.Tag) *nostr.Event {
	all := nostr.Tags{nostr.Tag{"d", d}}
	all = append(all, tags...)
	appDataSeq++
	return &nostr.Event{Kind: KindAppData, PubKey: pubkey, Tags: all, Content: content, CreatedAt: appDataSeq}
}

// appDataAt builds an organizer config event with an explicit CreatedAt (for replay-ordering tests).
func appDataAt(pubkey, d, content string, createdAt nostr.Timestamp) *nostr.Event {
	e := appData(pubkey, d, content)
	e.CreatedAt = createdAt
	return e
}

// fakeMember is a test MemberInfo: bind times keyed by pubkey. A pubkey absent from the map
// reports no bind time (treated as an existing member by newcomer rules).
type fakeMember struct{ boundAt map[string]int64 }

func (f fakeMember) BoundAt(pubkey string) (int64, bool) {
	ts, ok := f.boundAt[pubkey]
	return ts, ok
}

// TestConcurrentConfigApplyOrderMatchesRecord: when several distinct-newer configs for the same `d`
// are applied concurrently, the config left live on policy must be the NEWEST one — apply order must
// track record order. Before the fix, applyIfNewer recorded the version under mu but ran apply()
// outside it, so two goroutines could record E1→E2 yet apply E2→E1, leaving live policy stale
// relative to `applied`. applyMu now serializes compare-record-apply. (finding S7)
func TestConcurrentConfigApplyOrderMatchesRecord(t *testing.T) {
	const rounds = 20
	const n = 64
	for r := 0; r < rounds; r++ {
		h := NewConfigHolder([]string{orgPK})
		events := make([]*nostr.Event, n)
		for i := 0; i < n; i++ {
			// Encode CreatedAt into mailbox_per_min so the winning config is identifiable. Distinct
			// CreatedAt values mean id tie-breaks never matter here.
			events[i] = appDataAt(orgPK, dLimits, fmt.Sprintf(`{"mailbox_per_min":%d}`, 1000+i), nostr.Timestamp(1000+i))
		}
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(ev *nostr.Event) {
				defer wg.Done()
				<-start
				h.applyIfNewer(ev, dLimits)
			}(events[i])
		}
		close(start)
		wg.Wait()

		if got := h.Limits().MailboxPerMin; got != 1000+n-1 {
			t.Fatalf("round %d: live policy is stale — MailboxPerMin=%d, want %d (apply order must match record order)", r, got, 1000+n-1)
		}
	}
}

func TestRosterFromOrganizer(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	roster := appData(orgPK, dModerators, "", nostr.Tag{"p", "mod1"}, nostr.Tag{"p", "mod2"})
	if reject, msg := h.RejectEvent(context.Background(), roster); reject {
		t.Fatalf("organizer roster rejected: %s", msg)
	}
	if !h.IsModerator("mod1") || !h.IsModerator("mod2") {
		t.Fatal("roster pubkeys should be moderators")
	}
	if h.IsModerator("someone-else") {
		t.Fatal("non-listed pubkey must not be a moderator")
	}
}

func TestImpostorRosterRejected(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	roster := appData("attacker", dModerators, "", nostr.Tag{"p", "attacker"})
	if reject, _ := h.RejectEvent(context.Background(), roster); !reject {
		t.Fatal("stiq config from a non-organizer must be rejected")
	}
	if h.IsModerator("attacker") {
		t.Fatal("rejected roster must not take effect")
	}
}

func TestNonStiqAppDataAllowedFromAnyone(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	other := appData("alice", "my-app:prefs", "{}")
	if reject, _ := h.RejectEvent(context.Background(), other); reject {
		t.Fatal("non-stiq app data should not be gated")
	}
}

// TestSpaceOfferDTagNotOrganizerReserved pins the wire contract of the client's "offer to
// community log" consent event (kind-30078, d="space-offer:<groupId>", signed by the space
// OWNER — not the organizer): that d tag must stay outside the organizer-reserved `stiq:`
// prefix, or every owner-published offer would bounce with code_config_reserved. The log-offer
// feature (client logOffer.ts + dashboard /api/discover) depends on exactly this acceptance.
func TestSpaceOfferDTagNotOrganizerReserved(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	offer := appData("space-owner", "space-offer:group-abc",
		`{"v":1,"gid":"group-abc","n":"Quiet Corner","pr":true,"cl":true,"bc":false,"at":1752900000}`)
	if reject, msg := h.RejectEvent(context.Background(), offer); reject {
		t.Fatalf("owner-signed space-offer must not be organizer-reserved: %s", msg)
	}
}

func TestLimitsParsed(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	body := `{"posts":{"daily":20,"weekly":100},"dm_global_per_min":60,"exempt_moderators":true}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dLimits, body)); reject {
		t.Fatalf("limits event rejected: %s", msg)
	}
	l := h.Limits()
	if l.Posts.Daily != 20 || l.Posts.Weekly != 100 {
		t.Fatalf("unexpected post window: %+v", l.Posts)
	}
	if l.DMGlobalPerMin != 60 || !l.ExemptModerators {
		t.Fatalf("unexpected limits: %+v", l)
	}
}

func TestDefaultLimitsAppliedBeforeOrganizerConfig(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	// A fresh holder must expose the non-zero DEFAULT, not the wide-open zero value.
	if l := h.Limits(); l == (Limits{}) {
		t.Fatal("a fresh holder must be bounded (DefaultLimits), not the unlimited zero value")
	}
	if h.Limits().Posts.Daily != DefaultLimits.Posts.Daily {
		t.Fatalf("fresh holder should equal DefaultLimits, got %+v", h.Limits())
	}
	// A published stiq:limits fully REPLACES the default: posts.daily is overridden and an explicit
	// 0 for a category still means unlimited (it must not fall back to the default).
	body := `{"posts":{"daily":5},"comments":{"daily":0}}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dLimits, body)); reject {
		t.Fatalf("limits event rejected: %s", msg)
	}
	if got := h.Limits().Posts.Daily; got != 5 {
		t.Fatalf("published posts.daily should override the default, got %d", got)
	}
	if got := h.Limits().Comments.Daily; got != 0 {
		t.Fatalf("published comments.daily=0 (unlimited) must replace the default 100, got %d", got)
	}
}

func TestMailboxCapsParsedFromPublishedLimits(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	// The dashboard publishes the mailbox flood caps inside stiq:limits; the relay must apply them.
	body := `{"posts":{"daily":20},"mailbox_per_min":90,"mailbox_per_conn_per_min":5}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dLimits, body)); reject {
		t.Fatalf("limits event rejected: %s", msg)
	}
	l := h.Limits()
	if l.MailboxPerMin != 90 || l.MailboxPerConnPerMin != 5 {
		t.Fatalf("published mailbox caps not applied: %+v", l)
	}
	// An explicit 0 disables a cap (organizer opting out), and must NOT fall back to the default.
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dLimits, `{"mailbox_per_min":0,"mailbox_per_conn_per_min":0}`)); reject {
		t.Fatal("limits event rejected")
	}
	if l := h.Limits(); l.MailboxPerMin != 0 || l.MailboxPerConnPerMin != 0 {
		t.Fatalf("explicit 0 must disable the caps, got %+v", l)
	}
}

// TestConfigReplayIgnored: a captured OLDER organizer-signed config event, rebroadcast by anyone,
// must NOT revert the live policy root to the stale version (finding #17).
func TestConfigReplayIgnored(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	// Organizer tightens the mailbox cap at t=200.
	newer := appDataAt(orgPK, dLimits, `{"mailbox_per_min":30}`, 200)
	if reject, msg := h.RejectEvent(context.Background(), newer); reject {
		t.Fatalf("newer limits rejected: %s", msg)
	}
	if got := h.Limits().MailboxPerMin; got != 30 {
		t.Fatalf("expected tightened cap 30, got %d", got)
	}
	// An adversary replays a captured OLDER limits event (t=100) that loosened the cap.
	stale := appDataAt(orgPK, dLimits, `{"mailbox_per_min":9999}`, 100)
	if reject, _ := h.RejectEvent(context.Background(), stale); reject {
		t.Fatal("stale event should be admitted as an event but ignored for policy, not rejected")
	}
	if got := h.Limits().MailboxPerMin; got != 30 {
		t.Fatalf("replayed older config reverted the live policy: MailboxPerMin=%d, want 30", got)
	}
	// A genuinely newer republish (t=300) still applies.
	if reject, _ := h.RejectEvent(context.Background(), appDataAt(orgPK, dLimits, `{"mailbox_per_min":45}`, 300)); reject {
		t.Fatal("newer republish rejected")
	}
	if got := h.Limits().MailboxPerMin; got != 45 {
		t.Fatalf("newer republish not applied: MailboxPerMin=%d, want 45", got)
	}
}

func TestMailboxCapsFallBackForLegacyLimits(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	// A stiq:limits event published BEFORE the mailbox caps existed omits those fields. They must
	// fall back to the protective DefaultLimits — never parse as 0 (unlimited) and silently disable
	// the flood protection.
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dLimits, `{"posts":{"daily":7}}`)); reject {
		t.Fatalf("limits event rejected: %s", msg)
	}
	l := h.Limits()
	if l.Posts.Daily != 7 {
		t.Fatalf("posts.daily should be overridden, got %d", l.Posts.Daily)
	}
	if l.MailboxPerMin != DefaultLimits.MailboxPerMin || l.MailboxPerConnPerMin != DefaultLimits.MailboxPerConnPerMin {
		t.Fatalf("absent mailbox caps must fall back to DefaultLimits, got %+v", l)
	}
}

// --- 2026-07-29 rate-limiter default-deny fix: Reaction/GroupChat/Default pointer fields --------
//
// Reaction/GroupChat/Default (limitsJSON) are pointers for the exact same reason MailboxPerMin/
// MailboxPerConnPerMin already are (see TestMailboxCapsFallBackForLegacyLimits above): an absent key
// must fall back to the protective DefaultLimits, never decode as an explicit {0,0,0} = unlimited.

// TestLimitsJSONOldPayloadFallsBackToDefaultForNewFields is the regression test for the exact
// live-prod scenario the pointer-typed fields exist to prevent: a stiq:limits payload shaped
// byte-for-byte like prod's live limits.json (verified 2026-07-29 — predates this change, so it has
// no reaction/group_chat/default keys at all) must decode with Reaction/GroupChat/Default equal to
// DefaultLimits' non-zero values, NOT the zero-value Window{} (=unlimited). This test must FAIL
// against a plain (non-pointer) field implementation and PASS against the pointer implementation —
// it is the one that would have caught the exact regression this change is designed to prevent: an
// organizer's Node issuer republishing limits.json before it knows about these new fields.
func TestLimitsJSONOldPayloadFallsBackToDefaultForNewFields(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	body := `{"posts":{"daily":50,"weekly":200,"monthly":600},"comments":{"daily":200,"weekly":800,"monthly":2400},"channel":{"daily":100,"weekly":400,"monthly":1200},"dm_global_per_min":700,"exempt_moderators":true}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dLimits, body)); reject {
		t.Fatalf("legacy-shaped limits event rejected: %s", msg)
	}
	l := h.Limits()
	if l.Reaction != DefaultLimits.Reaction {
		t.Errorf("Reaction = %+v, want the protective default %+v (got the unlimited zero value instead)", l.Reaction, DefaultLimits.Reaction)
	}
	if l.GroupChat != DefaultLimits.GroupChat {
		t.Errorf("GroupChat = %+v, want the protective default %+v (got the unlimited zero value instead)", l.GroupChat, DefaultLimits.GroupChat)
	}
	if l.Default != DefaultLimits.Default {
		t.Errorf("Default = %+v, want the protective default %+v (got the unlimited zero value instead)", l.Default, DefaultLimits.Default)
	}
	if l.Reaction == (Window{}) || l.GroupChat == (Window{}) || l.Default == (Window{}) {
		t.Fatalf("new fields must never silently become Window{} (unlimited) for a legacy payload: %+v", l)
	}
}

// TestLimitsJSONExplicitZeroMeansUnlimitedForNewFields confirms the operator escape hatch survives
// the pointer change: an EXPLICIT {"daily":0,"weekly":0,"monthly":0} for reaction/group_chat/default
// must decode to Window{} (genuinely unlimited), not silently keep the code default. Mirrors the
// explicit-0 half of TestMailboxCapsParsedFromPublishedLimits above.
func TestLimitsJSONExplicitZeroMeansUnlimitedForNewFields(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	body := `{"reaction":{"daily":0,"weekly":0,"monthly":0},"group_chat":{"daily":0,"weekly":0,"monthly":0},"default":{"daily":0,"weekly":0,"monthly":0}}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dLimits, body)); reject {
		t.Fatalf("limits event rejected: %s", msg)
	}
	l := h.Limits()
	if l.Reaction != (Window{}) {
		t.Errorf("explicit reaction:0 should decode to Window{} (unlimited), got %+v", l.Reaction)
	}
	if l.GroupChat != (Window{}) {
		t.Errorf("explicit group_chat:0 should decode to Window{} (unlimited), got %+v", l.GroupChat)
	}
	if l.Default != (Window{}) {
		t.Errorf("explicit default:0 should decode to Window{} (unlimited), got %+v", l.Default)
	}
}

// TestLimitsJSONExplicitNonZeroForNewFields confirms an organizer publishing real numbers for the
// new fields sees them applied verbatim — the positive-value counterpart of the two tests above,
// mirroring the non-zero half of TestMailboxCapsParsedFromPublishedLimits. Uses the prod-scale
// first-week-safety-margin numbers from the rate-limiter default-deny spec (§7).
func TestLimitsJSONExplicitNonZeroForNewFields(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	body := `{"reaction":{"daily":1000,"weekly":5000,"monthly":15000},"group_chat":{"daily":600,"weekly":3000,"monthly":9000},"default":{"daily":100,"weekly":400,"monthly":1200}}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dLimits, body)); reject {
		t.Fatalf("limits event rejected: %s", msg)
	}
	l := h.Limits()
	wantReaction := Window{Daily: 1000, Weekly: 5000, Monthly: 15000}
	wantGroupChat := Window{Daily: 600, Weekly: 3000, Monthly: 9000}
	wantDefault := Window{Daily: 100, Weekly: 400, Monthly: 1200}
	if l.Reaction != wantReaction {
		t.Errorf("Reaction = %+v, want %+v", l.Reaction, wantReaction)
	}
	if l.GroupChat != wantGroupChat {
		t.Errorf("GroupChat = %+v, want %+v", l.GroupChat, wantGroupChat)
	}
	if l.Default != wantDefault {
		t.Errorf("Default = %+v, want %+v", l.Default, wantDefault)
	}
}

func TestNoOrganizerConfigured(t *testing.T) {
	h := NewConfigHolder(nil)
	// With no organizer, a stiq config event from anyone is rejected (no trust root).
	if reject, _ := h.RejectEvent(context.Background(), appData("x", dLimits, "{}")); !reject {
		t.Fatal("with no organizer, stiq config must be rejected")
	}
}

func note(pubkey, content string) *nostr.Event {
	return &nostr.Event{Kind: kindNote, PubKey: pubkey, Tags: nostr.Tags{}, Content: content}
}

func article(pubkey, content string) *nostr.Event {
	return &nostr.Event{Kind: kindLongform, PubKey: pubkey, Tags: nostr.Tags{}, Content: content}
}

// noteComment builds the HYBRID kind-1 comment: a comment on a plain note, which NIP-22 forbids from
// being a kind-1111, so it borrows kind-1 and marks itself (client feed/comments.ts buildNoteComment).
func noteComment(pubkey, content string) *nostr.Event {
	return &nostr.Event{
		Kind:    kindNote,
		PubKey:  pubkey,
		Tags:    nostr.Tags{nostr.Tag{"e", "root", "", "root"}, nostr.Tag{"t", stiqCommentMarker}},
		Content: content,
	}
}

// bodyOf builds any other member-authored body kind (channel broadcast, group message, 1111 comment).
func bodyOf(kind int, pubkey, content string) *nostr.Event {
	return &nostr.Event{Kind: kind, PubKey: pubkey, Tags: nostr.Tags{}, Content: content}
}

// ── stiq:post-rules ──────────────────────────────────────────────────────────────────────────

func TestPostRulesParsedAndEnforced(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	body := `{"note":{"mn":10,"mx":20,"lr":true},"article":{"mn":0,"mx":3,"lr":false}}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dPostRules, body)); reject {
		t.Fatalf("post-rules event rejected: %s", msg)
	}

	// A note at exactly the max (20 runes) is allowed; 21 is rejected.
	if reject, msg := h.RejectEvent(context.Background(), note("member", strings.Repeat("x", 20))); reject {
		t.Fatalf("note at max length should pass: %s", msg)
	}
	if reject, _ := h.RejectEvent(context.Background(), note("member", strings.Repeat("x", 21))); !reject {
		t.Fatal("over-max note must be rejected")
	}

	// Articles measure WORDS. 3 words ok, 4 rejected.
	if reject, msg := h.RejectEvent(context.Background(), article("member", "one two three")); reject {
		t.Fatalf("3-word article should pass: %s", msg)
	}
	if reject, _ := h.RejectEvent(context.Background(), article("member", "one two three four")); !reject {
		t.Fatal("4-word article must be rejected (article max is words)")
	}

	// Min length + label-required are client-side: a 1-char note (below mn=10, no label) is
	// NOT rejected by the relay.
	if reject, msg := h.RejectEvent(context.Background(), note("member", "x")); reject {
		t.Fatalf("relay must not enforce min length / label-required: %s", msg)
	}
}

func TestPostRulesUnlimitedAndOrganizerExempt(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	// mx=0 ⇒ unlimited for notes; article capped at 2 words.
	body := `{"note":{"mn":0,"mx":0,"lr":false},"article":{"mn":0,"mx":2,"lr":false}}`
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dPostRules, body)); reject {
		t.Fatal("post-rules event rejected")
	}
	if reject, _ := h.RejectEvent(context.Background(), note("member", strings.Repeat("x", 5000))); reject {
		t.Fatal("mx=0 should mean unlimited note length")
	}
	// Organizer is exempt from the article cap.
	if reject, _ := h.RejectEvent(context.Background(), article(orgPK, "one two three four five")); reject {
		t.Fatal("organizer must be exempt from post-rules length caps")
	}
}

func TestPostRulesMalformedNoOp(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dPostRules, "not json")); reject {
		t.Fatal("malformed post-rules must be a no-op (accepted), not a reject")
	}
	// No rules took effect → a long note is fine.
	if reject, _ := h.RejectEvent(context.Background(), note("member", strings.Repeat("x", 1000))); reject {
		t.Fatal("malformed post-rules must not enforce any cap")
	}
}

// picTok builds a valid inline picture token whose base64 payload is `payloadLen` chars long — used
// to prove a media-only note is exempt from the character limit even when its raw content is huge.
func picTok(payloadLen int) string {
	return "[[pic:2;2;" + strings.Repeat("A", payloadLen) + "]]"
}

func voiceTok(payloadLen int) string {
	return "[[voice:audio/mp4;3;" + strings.Repeat("A", payloadLen) + "]]"
}

// TestPostRulesMediaExemptAndCapped is the regression for the persistent picture/voice-note failure:
// inline media must NOT count toward the note character limit (prose-only measurement), and a
// per-type media COUNT cap is hard-enforced.
func TestPostRulesMediaExemptAndCapped(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	// note: max 20 chars of prose, at most 1 media. article: max 3 words, at most 2 media.
	body := `{"note":{"mn":0,"mx":20,"mm":1,"lr":false},"article":{"mn":0,"mx":3,"mm":2,"lr":false}}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dPostRules, body)); reject {
		t.Fatalf("post-rules event rejected: %s", msg)
	}

	// A picture-only note whose RAW content is thousands of runes is ACCEPTED — media is exempt from
	// the 20-char prose limit. (This is exactly the post that used to be rejected server-side.)
	if reject, msg := h.RejectEvent(context.Background(), note("member", picTok(4000))); reject {
		t.Fatalf("media-only note must be exempt from the length limit: %s", msg)
	}
	// One picture + a short caption (≤20 prose chars) is fine.
	if reject, msg := h.RejectEvent(context.Background(), note("member", "hello "+picTok(4000))); reject {
		t.Fatalf("caption + 1 picture must pass: %s", msg)
	}
	// But PROSE beyond 20 chars (media stripped) is still rejected.
	if reject, _ := h.RejectEvent(context.Background(), note("member", strings.Repeat("x", 21)+picTok(50))); !reject {
		t.Fatal("over-max PROSE must still be rejected even with media present")
	}
	// TWO media in a note exceeds the cap of 1 → rejected.
	if reject, _ := h.RejectEvent(context.Background(), note("member", picTok(20)+voiceTok(20))); !reject {
		t.Fatal("a note with 2 media must be rejected (note media cap is 1)")
	}
	// Articles: 2 media ok, 3 rejected; media never counts toward the 3-word limit.
	if reject, msg := h.RejectEvent(context.Background(), article("member", "one two "+picTok(9000)+voiceTok(9000))); reject {
		t.Fatalf("article with 2 media + 2 words must pass: %s", msg)
	}
	if reject, _ := h.RejectEvent(context.Background(), article("member", picTok(20)+picTok(20)+picTok(20))); !reject {
		t.Fatal("an article with 3 media must be rejected (article media cap is 2)")
	}

	// mm omitted / 0 ⇒ unlimited media (back-compat with pre-media-cap organizer docs).
	body2 := `{"note":{"mn":0,"mx":0,"lr":false},"article":{"mn":0,"mx":0,"lr":false}}`
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dPostRules, body2)); reject {
		t.Fatal("post-rules update rejected")
	}
	if reject, msg := h.RejectEvent(context.Background(), note("member", picTok(20)+picTok(20)+voiceTok(20))); reject {
		t.Fatalf("mm=0 must mean unlimited media: %s", msg)
	}
}

// embedTok builds a valid `stiq:<kind>:` embed token with a `payloadLen`-char base64url payload.
func embedTok(kind string, payloadLen int) string {
	return "stiq:" + kind + ":" + strings.Repeat("A", payloadLen)
}

// TestPostRulesEmbedsExemptFromLength pins the other half of the exemption: an embedded CARD (event,
// space, private post, draft, or a nostr reference) is a machine payload the reader only ever sees as
// a card, so it must not count toward the note character / article word limit either. The composer
// stopped counting it (client/src/feed/embedTokens.ts); if the relay still counted it, a note with one
// event card — ~2 KB of base64 — would be hard-rejected right after the composer accepted it.
func TestPostRulesEmbedsExemptFromLength(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	// note: max 20 chars of prose, at most 1 media. article: max 3 words.
	body := `{"note":{"mn":0,"mx":20,"mm":1,"lr":false},"article":{"mn":0,"mx":3,"mm":2,"lr":false}}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dPostRules, body)); reject {
		t.Fatalf("post-rules event rejected: %s", msg)
	}

	for _, kind := range []string{"event", "space", "msg", "draft"} {
		if reject, msg := h.RejectEvent(context.Background(), note("member", "come along "+embedTok(kind, 2000))); reject {
			t.Fatalf("note with a %s card must be exempt from the length limit: %s", kind, msg)
		}
	}
	// A long run of the same characters is prose, not a token, and is still measured.
	if reject, _ := h.RejectEvent(context.Background(), note("member", "see "+strings.Repeat("q", 300))); !reject {
		t.Fatal("long prose must still be rejected when it carries no token")
	}
	// A nostr reference is a card too.
	if reject, msg := h.RejectEvent(context.Background(), note("member", "this: nostr:nevent1"+strings.Repeat("q", 400))); reject {
		t.Fatalf("note with a nostr reference must be exempt: %s", msg)
	}
	// An embed does NOT count against the media cap (it is not media): 1 picture + 3 cards is fine.
	// Tokens are separated as a real body has them — see the glued-token case in
	// TestInlineMediaStripMatchesClient for what both sides do when they are not.
	if reject, msg := h.RejectEvent(context.Background(), note("member", picTok(500)+" "+embedTok("event", 500)+" "+embedTok("space", 500)+" "+embedTok("draft", 500))); reject {
		t.Fatalf("cards must not count against the media cap: %s", msg)
	}
	// Prose beyond the cap is still rejected, card or no card.
	if reject, _ := h.RejectEvent(context.Background(), note("member", strings.Repeat("x", 21)+embedTok("event", 500))); !reject {
		t.Fatal("over-max PROSE must still be rejected even with an embed present")
	}
	// Articles measure words the same way: 2 words + 3 cards passes a 3-word cap.
	if reject, msg := h.RejectEvent(context.Background(), article("member", "look here "+embedTok("event", 900)+" "+embedTok("msg", 900)+" "+embedTok("draft", 900))); reject {
		t.Fatalf("article cards must not count as words: %s", msg)
	}
	// An unknown scheme is NOT a card — it stays prose and is measured.
	if reject, _ := h.RejectEvent(context.Background(), note("member", "stiq:unknown:"+strings.Repeat("A", 100))); !reject {
		t.Fatal("an unrecognized stiq: scheme must be measured as prose, not exempted")
	}
}

// TestInlineMediaStripMatchesClient pins the cross-language contract: for each body, the relay's
// prose length + media count MUST equal the client's (client/src/feed/inlineMedia.test.ts uses the
// SAME body list and the SAME expected numbers). A media token can be nested inside the other type's
// frame — and an embed token nested in a media frame invalidates that frame — so the strip order
// matters; both sides strip voice, then pictures, then embed/reference tokens. If either side
// changes, the mirrored test on the other side must change too — that is the whole point of pinning
// it twice.
func TestInlineMediaStripMatchesClient(t *testing.T) {
	cases := []struct {
		body    string
		proseLn int
		media   int
	}{
		{"", 0, 0},
		{"hello world", 11, 0},
		{"[[pic:8;4;AAAA]]", 0, 1},
		{"[[voice:audio/mp4;3;QQ==]]", 0, 1},
		{"a[[pic:8;4;AAAA]]b[[voice:audio/mp4;3;QQ]]c", 3, 2},
		// Nested: a valid voice inside an (otherwise invalid) pic frame — the dangerous case where the
		// composer used to measure 0 while a pic-first relay measured 16 and hard-rejected the post.
		{"[[pic:8;4;[[voice:audio/x;1;QQ]]AAAA]]", 0, 1},
		// Nested the other way: valid pic inside an invalid voice frame → the voice frame is left as prose.
		{"[[voice:audio/x;1;[[pic:8;4;AAAA]]QQ]]", 22, 1},
		// Double-nested.
		{"[[pic:8;4;[[voice:audio/x;1;[[pic:2;2;ZZ]]QQ]]AA]]", 36, 1},
		// Embed/reference cards: a card is not prose and is not media — 0 length, 0 media count.
		{"stiq:event:AAAA", 0, 0},
		{"look stiq:event:AAAA", 5, 0},
		{"stiq:msg:AA stiq:draft:BB", 1, 0},
		// Two tokens GLUED together with no separator: the token charset covers letters, so the first
		// match swallows the second's "stiq" and leaves ":space:BB" behind as prose. That is the shared
		// grammar's behaviour — the renderers draw one card and literal text here too — and both sides
		// land on the identical residue, which is all this contract requires.
		{"stiq:event:AAstiq:space:BB", 9, 0},
		{"nostr:nevent1qqqq", 0, 0},
		{"[[pic:2;2;AAAA]] stiq:event:ZZZZ", 1, 1},
		// An embed inside a pic frame: the frame is INVALID while it still holds the ':'-bearing token,
		// so media-then-embeds leaves the (now well-formed) frame as prose. Stripping embeds first
		// would reveal the frame to the media pass and measure 0 instead of 14 — the divergence the
		// fixed order rules out. Both sides make one pass each, in this order.
		{"[[pic:8;4;AAstiq:event:BB]]", 14, 0},
	}
	for _, c := range cases {
		if n := len([]rune(bodyForMeasure(c.body))); n != c.proseLn {
			t.Errorf("prose length for %q = %d, want %d (must match client bodyForMeasure)", c.body, n, c.proseLn)
		}
		if n := countInlineMedia(c.body); n != c.media {
			t.Errorf("media count for %q = %d, want %d (must match client countInlineMedia)", c.body, n, c.media)
		}
	}
}

// ── stiq:gov channel-create ──────────────────────────────────────────────────────────────────

func createGroup(pubkey string) *nostr.Event {
	return &nostr.Event{Kind: kindCreateGroup, PubKey: pubkey, Tags: nostr.Tags{{"h", "g1"}}}
}

func TestChannelCreateOrgOnly(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dGov, `{"cc":"org"}`)); reject {
		t.Fatal("gov event rejected")
	}
	if reject, msg := h.RejectEvent(context.Background(), createGroup(orgPK)); reject {
		t.Fatalf("organizer must be able to create a channel: %s", msg)
	}
	if reject, _ := h.RejectEvent(context.Background(), createGroup("member")); !reject {
		t.Fatal(`cc="org" must reject a non-organizer channel create`)
	}
}

func TestChannelCreateModsOrOrg(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	// Roster: make "mod" a moderator.
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dModerators, "", nostr.Tag{"p", "mod"})); reject {
		t.Fatal("roster rejected")
	}
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dGov, `{"cc":"mods"}`)); reject {
		t.Fatal("gov event rejected")
	}
	if reject, msg := h.RejectEvent(context.Background(), createGroup("mod")); reject {
		t.Fatalf(`cc="mods" must allow a moderator: %s`, msg)
	}
	if reject, msg := h.RejectEvent(context.Background(), createGroup(orgPK)); reject {
		t.Fatalf(`cc="mods" must allow the organizer: %s`, msg)
	}
	if reject, _ := h.RejectEvent(context.Background(), createGroup("rando")); !reject {
		t.Fatal(`cc="mods" must reject a plain member`)
	}
}

func TestChannelCreateAnyAllowsEveryone(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dGov, `{"cc":"any"}`)); reject {
		t.Fatal("gov event rejected")
	}
	if reject, msg := h.RejectEvent(context.Background(), createGroup("member")); reject {
		t.Fatalf(`cc="any" must allow any member: %s`, msg)
	}
	// Empty/unconfigured cc also allows everyone.
	h2 := NewConfigHolder([]string{orgPK})
	if reject, _ := h2.RejectEvent(context.Background(), createGroup("member")); reject {
		t.Fatal("unconfigured channel-create must allow members")
	}
}

// ── stiq:gov newcomer ────────────────────────────────────────────────────────────────────────

func TestNewcomerLinkBlockedThenAllowed(t *testing.T) {
	now := time.Unix(10*secondsPerDay, 0)
	h := NewConfigHolder([]string{orgPK})
	h.now = func() time.Time { return now }
	// "newbie" bound on day 9 (1 day ago); "old" bound on day 0 (10 days ago).
	h.SetMemberInfo(fakeMember{boundAt: map[string]int64{
		"newbie": 9 * secondsPerDay,
		"old":    0,
	}})
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dGov, `{"ncd":3,"nl":true}`)); reject {
		t.Fatal("gov event rejected")
	}

	// Newcomer (1 day < 3) posting a link → blocked.
	if reject, _ := h.RejectEvent(context.Background(), note("newbie", "check https://x.com")); !reject {
		t.Fatal("newcomer link post must be rejected")
	}
	// Newcomer posting WITHOUT a link → allowed.
	if reject, msg := h.RejectEvent(context.Background(), note("newbie", "just text")); reject {
		t.Fatalf("newcomer non-link post should pass: %s", msg)
	}
	// Established member (10 days > 3) posting a link → allowed.
	if reject, msg := h.RejectEvent(context.Background(), note("old", "see https://x.com")); reject {
		t.Fatalf("established member link post should pass: %s", msg)
	}
	// Unknown bind time → treated as old → allowed.
	if reject, _ := h.RejectEvent(context.Background(), note("ghost", "http://y.com")); reject {
		t.Fatal("member with unknown bind time must not be treated as a newcomer")
	}

	// Move the clock 3 days forward: the newbie is now past the window → link allowed.
	now = now.Add(3 * 24 * time.Hour)
	if reject, msg := h.RejectEvent(context.Background(), note("newbie", "now https://x.com")); reject {
		t.Fatalf("link should be allowed once the newcomer window passes: %s", msg)
	}
}

func TestNewcomerChannelCreateBlockedThenAllowed(t *testing.T) {
	now := time.Unix(10*secondsPerDay, 0)
	h := NewConfigHolder([]string{orgPK})
	h.now = func() time.Time { return now }
	h.SetMemberInfo(fakeMember{boundAt: map[string]int64{"newbie": 9 * secondsPerDay}})
	// cc=any so the channel-create rule itself doesn't block; newcomer no-channels does.
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dGov, `{"ncd":5,"nc":true,"cc":"any"}`)); reject {
		t.Fatal("gov event rejected")
	}
	if reject, _ := h.RejectEvent(context.Background(), createGroup("newbie")); !reject {
		t.Fatal("newcomer must be blocked from creating channels")
	}
	// After the window: allowed.
	now = now.Add(5 * 24 * time.Hour)
	if reject, msg := h.RejectEvent(context.Background(), createGroup("newbie")); reject {
		t.Fatalf("channel create should be allowed after the newcomer window: %s", msg)
	}
}

func TestNewcomerModeratorExempt(t *testing.T) {
	now := time.Unix(10*secondsPerDay, 0)
	h := NewConfigHolder([]string{orgPK})
	h.now = func() time.Time { return now }
	h.SetMemberInfo(fakeMember{boundAt: map[string]int64{"mod": 9 * secondsPerDay}})
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dModerators, "", nostr.Tag{"p", "mod"})); reject {
		t.Fatal("roster rejected")
	}
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dGov, `{"ncd":5,"nl":true,"nc":true,"cc":"any"}`)); reject {
		t.Fatal("gov event rejected")
	}
	// A moderator within the window is exempt from both newcomer gates.
	if reject, msg := h.RejectEvent(context.Background(), note("mod", "https://x.com")); reject {
		t.Fatalf("moderator must be exempt from newcomer no-links: %s", msg)
	}
	if reject, msg := h.RejectEvent(context.Background(), createGroup("mod")); reject {
		t.Fatalf("moderator must be exempt from newcomer no-channels: %s", msg)
	}
}

// ── stiq:mod-limits ──────────────────────────────────────────────────────────────────────────

func modAction(pubkey, action string) *nostr.Event {
	tags := nostr.Tags{{"e", "post1"}}
	if action != "" {
		tags = append(tags, nostr.Tag{"stiq-action", action})
	}
	return &nostr.Event{Kind: kindModAction, PubKey: pubkey, Tags: tags}
}

func TestModLimitsParsedAndDailyCap(t *testing.T) {
	now := time.Unix(0, 0)
	h := NewConfigHolder([]string{orgPK})
	h.now = func() time.Time { return now }
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dModerators, "", nostr.Tag{"p", "mod"})); reject {
		t.Fatal("roster rejected")
	}
	body := `{"hide":{"d":2,"w":0},"ban":{"d":0,"w":3}}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dModLimits, body)); reject {
		t.Fatalf("mod-limits event rejected: %s", msg)
	}

	// A bare report (no stiq-action) maps to "hide" → daily cap 2.
	for i := 0; i < 2; i++ {
		if reject, msg := h.RejectEvent(context.Background(), modAction("mod", "")); reject {
			t.Fatalf("hide %d should pass: %s", i, msg)
		}
	}
	if reject, _ := h.RejectEvent(context.Background(), modAction("mod", "")); !reject {
		t.Fatal("3rd hide in a day must hit the daily cap")
	}
	// A different action ("retag") is unlimited (not in the doc).
	for i := 0; i < 10; i++ {
		if reject, _ := h.RejectEvent(context.Background(), modAction("mod", "retag")); reject {
			t.Fatal("unlisted action must be unlimited")
		}
	}
}

func TestModLimitsWeeklyCapAcrossDays(t *testing.T) {
	now := time.Unix(7*secondsPerDay, 0)
	h := NewConfigHolder([]string{orgPK})
	h.now = func() time.Time { return now }
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dModerators, "", nostr.Tag{"p", "mod"})); reject {
		t.Fatal("roster rejected")
	}
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dModLimits, `{"ban":{"d":0,"w":3}}`)); reject {
		t.Fatal("mod-limits event rejected")
	}
	ban := func() (bool, string) { return h.RejectEvent(context.Background(), modAction("mod", "ban")) }
	ban()
	now = now.Add(24 * time.Hour)
	ban()
	now = now.Add(24 * time.Hour)
	ban()
	if reject, _ := ban(); !reject {
		t.Fatal("4th ban within 7 days must hit the weekly cap")
	}
	// Slide the window 7 days past the first ban → admitted again.
	now = now.Add(7 * 24 * time.Hour)
	if reject, msg := ban(); reject {
		t.Fatalf("ban should be admitted after the weekly window slides: %s", msg)
	}
}

// ── rich bodies everywhere: the note cap is the note's alone, the article cap is universal ──────

// TestCommentIsNotANote is the load-bearing one. Every surface writes RICH bodies now, and a comment
// on a plain note has to ride kind-1 (NIP-22 reserves 1111 for non-kind-1 roots). Sharing the kind
// meant it collected the note's own character cap, so a 280-char community hard-rejected any comment
// carrying a table or a collapsible block — content the app's own editor offers on that very screen.
func TestCommentIsNotANote(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	// Notes: 20 chars. Articles (= the universal long-body cap): 50 words.
	body := `{"note":{"mn":0,"mx":20,"mm":1,"lr":false},"article":{"mn":0,"mx":50,"mm":4,"lr":false}}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dPostRules, body)); reject {
		t.Fatalf("post-rules event rejected: %s", msg)
	}

	// A real note still answers to the note cap.
	if reject, _ := h.RejectEvent(context.Background(), note("member", strings.Repeat("x", 21))); !reject {
		t.Fatal("a real feed note must still be held to the note character cap")
	}
	// The same body as a COMMENT is admitted — it is measured in words against the universal cap.
	long := strings.Repeat("x", 400)
	if reject, msg := h.RejectEvent(context.Background(), noteComment("member", long)); reject {
		t.Fatalf("a hybrid kind-1 comment must not inherit the note character cap: %s", msg)
	}
	// A markdown table is the concrete case: far past 20 characters, well under 50 words.
	table := "here you go\n\n| site | url |\n|---|---|\n| Example | somewhere |"
	if reject, msg := h.RejectEvent(context.Background(), noteComment("member", table)); reject {
		t.Fatalf("a comment carrying a table must be accepted: %s", msg)
	}
	// It is not unbounded, though — the universal word cap still applies.
	if reject, msg := h.RejectEvent(context.Background(), noteComment("member", strings.Repeat("word ", 51))); !reject {
		t.Fatal("a comment over the universal word cap must still be rejected")
	} else if !strings.Contains(msg, "["+codeBodyTooLong+"]") {
		t.Fatalf("comment rejection should carry %s, got: %s", codeBodyTooLong, msg)
	}
	// And the note's own media cap is likewise not the comment's — the article one is.
	if reject, msg := h.RejectEvent(context.Background(), noteComment("member", picTok(50)+" "+picTok(50)+" "+picTok(50))); reject {
		t.Fatalf("a comment gets the article media cap (4), not the note's (1): %s", msg)
	}
}

// TestUniversalBodyCapCoversEverySurface: channel broadcasts, group messages and 1111 comments had
// NO length policy at all. They carry rich prose now, so the organizer's long-body number is the one
// ceiling for all of them.
func TestUniversalBodyCapCoversEverySurface(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	body := `{"note":{"mn":0,"mx":20,"mm":1,"lr":false},"article":{"mn":0,"mx":5,"mm":2,"lr":false}}`
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dPostRules, body)); reject {
		t.Fatalf("post-rules event rejected: %s", msg)
	}

	for _, kind := range []int{kindLiveChat, kindGroupChat, kindGroupThread, kindGroupReply, kindComment} {
		if reject, msg := h.RejectEvent(context.Background(), bodyOf(kind, "member", "one two three four five")); reject {
			t.Fatalf("kind %d at the word cap should pass: %s", kind, msg)
		}
		reject, msg := h.RejectEvent(context.Background(), bodyOf(kind, "member", "one two three four five six"))
		if !reject {
			t.Fatalf("kind %d over the universal word cap must be rejected", kind)
		}
		if !strings.Contains(msg, "["+codeBodyTooLong+"]") {
			t.Fatalf("kind %d rejection should carry %s, got: %s", kind, codeBodyTooLong, msg)
		}
		// Worded as a message, never as an article — the client renders this prose verbatim when it
		// doesn't know the code.
		if !strings.Contains(msg, "message is") {
			t.Fatalf("kind %d rejection should read as a message, got: %s", kind, msg)
		}
		// The media cap reaches these surfaces too.
		if reject, _ := h.RejectEvent(context.Background(), bodyOf(kind, "member", picTok(50)+" "+picTok(50)+" "+picTok(50))); !reject {
			t.Fatalf("kind %d over the media cap must be rejected", kind)
		}
	}

	// The long-form article keeps its OWN code + noun, so its copy stays article-specific.
	_, msg := h.RejectEvent(context.Background(), article("member", "one two three four five six"))
	if !strings.Contains(msg, "["+codeArticleTooLong+"]") || !strings.Contains(msg, "article is") {
		t.Fatalf("an article must still reject as an article, got: %s", msg)
	}
	// Organizers stay exempt everywhere.
	if reject, _ := h.RejectEvent(context.Background(), bodyOf(kindLiveChat, orgPK, "one two three four five six seven")); reject {
		t.Fatal("organizer must be exempt from the universal body cap")
	}
	// mx=0 ⇒ unlimited still holds for these kinds.
	h2 := NewConfigHolder([]string{orgPK})
	if reject, _ := h2.RejectEvent(context.Background(), appData(orgPK, dPostRules, `{"note":{"mn":0,"mx":20},"article":{"mn":0,"mx":0}}`)); reject {
		t.Fatal("post-rules event rejected")
	}
	if reject, _ := h2.RejectEvent(context.Background(), bodyOf(kindGroupChat, "member", strings.Repeat("word ", 500))); reject {
		t.Fatal("mx=0 must mean unlimited for the universal cap too")
	}
}

// TestAuthorNoteStillWinsOnComments: the pinned author-note has its own, tighter rule. Routing 1111
// through the universal cap must not have displaced it.
func TestAuthorNoteStillWinsOnComments(t *testing.T) {
	h := NewConfigHolder([]string{orgPK})
	if reject, msg := h.RejectEvent(context.Background(), appData(orgPK, dPostRules, `{"note":{"mn":0,"mx":0},"article":{"mn":0,"mx":0},"anmx":10}`)); reject {
		t.Fatalf("post-rules event rejected: %s", msg)
	}
	pinned := &nostr.Event{
		Kind:    kindComment,
		PubKey:  "member",
		Tags:    nostr.Tags{nostr.Tag{pinMarkerTag, "1"}},
		Content: strings.Repeat("x", 11),
	}
	reject, msg := h.RejectEvent(context.Background(), pinned)
	if !reject {
		t.Fatal("an over-length pinned author-note must still be rejected")
	}
	if !strings.Contains(msg, "["+codeAuthorNoteTooLong+"]") {
		t.Fatalf("author-note rule must win on a pinned comment, got: %s", msg)
	}
}

// TestRejectCodesVersionIsFive pins the machine-readable reject-code vocabulary version at 5 from
// inside the policy package (the NIP-11 advertisement in relayapp is pinned separately). v5 added
// codeBodyTooLong (the universal long-body cap applied to a non-article body); v4 added
// codeSpaceTokenRequired (tokens-everywhere). A client switches on this exact number to decide
// whether it can trust the code-table retryable decision, so an accidental revert/bump must fail
// loudly here.
func TestRejectCodesVersionIsFive(t *testing.T) {
	if RejectCodesVersion != 5 {
		t.Fatalf("RejectCodesVersion = %d, want 5 (v5: body_too_long)", RejectCodesVersion)
	}
}

// noteWithTags builds a kind-1 note carrying arbitrary tags (the note() helper adds none), so a
// tag-scope rejection can be triggered.
func noteWithTags(pubkey, content string, tags ...nostr.Tag) *nostr.Event {
	return &nostr.Event{Kind: kindNote, PubKey: pubkey, Tags: nostr.Tags(tags), Content: content}
}

// TestOrganizerRejectCodes drives representative rejecting events through ConfigHolder.RejectEvent
// and asserts each carries the stable "[code]" prefix (T12). Every path here is reachable with the
// existing test helpers; a handful of organizer codes (too_many_tags, tag_not_permitted,
// article_too_long, article_too_much_media, channel_organizer_only, channel_mods_only,
// newcomer_channels, mod_rate_limited) are exercised for behavior by other tests in this file and
// are intentionally not re-asserted for their prefix here to keep this focused on the 8 the plan
// calls out.
func TestOrganizerRejectCodes(t *testing.T) {
	assertPrefix := func(t *testing.T, code string, reject bool, msg string) {
		t.Helper()
		if !reject {
			t.Fatalf("expected a rejection carrying %q, got accept", code)
		}
		if !strings.HasPrefix(msg, "["+code+"] ") {
			t.Fatalf("reject reason %q must begin with [%s]", msg, code)
		}
	}
	ctx := context.Background()

	// [config_reserved]: a stiq:-prefixed kind-30078 from a non-organizer.
	t.Run("config_reserved", func(t *testing.T) {
		h := NewConfigHolder([]string{orgPK})
		reject, msg := h.RejectEvent(ctx, appData("attacker", dLimits, "{}"))
		assertPrefix(t, "config_reserved", reject, msg)
	})

	// [voice_disabled]: a NIP-A0 voice message from a member while AllowVoice is off (the default).
	t.Run("voice_disabled", func(t *testing.T) {
		h := NewConfigHolder([]string{orgPK})
		reject, msg := h.RejectEvent(ctx, &nostr.Event{Kind: kindVoiceMessage, PubKey: "member"})
		assertPrefix(t, "voice_disabled", reject, msg)
	})

	// [tag_scope]: a note carries a `t` tag mapped (via tsc) to articles only.
	t.Run("tag_scope", func(t *testing.T) {
		h := NewConfigHolder([]string{orgPK})
		if reject, msg := h.RejectEvent(ctx, appData(orgPK, dTagPolicy, `{"tsc":{"deepdive":"article"}}`)); reject {
			t.Fatalf("tag-policy rejected: %s", msg)
		}
		reject, msg := h.RejectEvent(ctx, noteWithTags("member", "hi", nostr.Tag{"t", "deepdive"}))
		assertPrefix(t, "tag_scope", reject, msg)
	})

	// [content_too_long]: a note whose prose exceeds the note max.
	t.Run("content_too_long", func(t *testing.T) {
		h := NewConfigHolder([]string{orgPK})
		if reject, msg := h.RejectEvent(ctx, appData(orgPK, dPostRules, `{"note":{"mx":5}}`)); reject {
			t.Fatalf("post-rules rejected: %s", msg)
		}
		reject, msg := h.RejectEvent(ctx, note("member", "hello world"))
		assertPrefix(t, "content_too_long", reject, msg)
	})

	// [too_much_media]: a note with more inline media than the per-note cap (prose stays unlimited).
	t.Run("too_much_media", func(t *testing.T) {
		h := NewConfigHolder([]string{orgPK})
		if reject, msg := h.RejectEvent(ctx, appData(orgPK, dPostRules, `{"note":{"mx":0,"mm":1}}`)); reject {
			t.Fatalf("post-rules rejected: %s", msg)
		}
		reject, msg := h.RejectEvent(ctx, note("member", picTok(20)+voiceTok(20)))
		assertPrefix(t, "too_much_media", reject, msg)
	})

	// [author_note_too_long]: a pinned kind-1111 author-note longer than the author-note max.
	t.Run("author_note_too_long", func(t *testing.T) {
		h := NewConfigHolder([]string{orgPK})
		if reject, msg := h.RejectEvent(ctx, appData(orgPK, dPostRules, `{"anmx":5}`)); reject {
			t.Fatalf("post-rules rejected: %s", msg)
		}
		pinned := &nostr.Event{Kind: kindComment, PubKey: "member", Tags: nostr.Tags{{pinMarkerTag, "1"}}, Content: "hello world"}
		reject, msg := h.RejectEvent(ctx, pinned)
		assertPrefix(t, "author_note_too_long", reject, msg)
	})

	// [newcomer_links]: a link-bearing post from a member still inside the newcomer window.
	t.Run("newcomer_links", func(t *testing.T) {
		now := time.Unix(10*secondsPerDay, 0)
		h := NewConfigHolder([]string{orgPK})
		h.now = func() time.Time { return now }
		h.SetMemberInfo(fakeMember{boundAt: map[string]int64{"newbie": 9 * secondsPerDay}})
		if reject, msg := h.RejectEvent(ctx, appData(orgPK, dGov, `{"ncd":3,"nl":true}`)); reject {
			t.Fatalf("gov rejected: %s", msg)
		}
		reject, msg := h.RejectEvent(ctx, note("newbie", "check https://x.com"))
		assertPrefix(t, "newcomer_links", reject, msg)
	})

	// [moderator_denied]: a rostered moderator takes an action their (empty) permission scope forbids.
	t.Run("moderator_denied", func(t *testing.T) {
		h := NewConfigHolder([]string{orgPK})
		if reject, msg := h.RejectEvent(ctx, appData(orgPK, dModerators, "", nostr.Tag{"p", "mod"})); reject {
			t.Fatalf("roster rejected: %s", msg)
		}
		// An explicit permissions doc with no default scopes → the mod holds nothing.
		if reject, msg := h.RejectEvent(ctx, appData(orgPK, dPermissions, `{"def":[]}`)); reject {
			t.Fatalf("permissions rejected: %s", msg)
		}
		reject, msg := h.RejectEvent(ctx, modAction("mod", "ban"))
		assertPrefix(t, "moderator_denied", reject, msg)
	})
}

func TestModLimitsOrganizerExemptAndNonModUnaffected(t *testing.T) {
	now := time.Unix(0, 0)
	h := NewConfigHolder([]string{orgPK})
	h.now = func() time.Time { return now }
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dModerators, "", nostr.Tag{"p", "mod"})); reject {
		t.Fatal("roster rejected")
	}
	if reject, _ := h.RejectEvent(context.Background(), appData(orgPK, dModLimits, `{"hide":{"d":1}}`)); reject {
		t.Fatal("mod-limits event rejected")
	}
	// Organizer is exempt — many hides pass.
	for i := 0; i < 5; i++ {
		if reject, _ := h.RejectEvent(context.Background(), modAction(orgPK, "")); reject {
			t.Fatalf("organizer mod-action %d must be exempt", i)
		}
	}
	// A non-moderator's kind-1984 is a member report, not a mod action — unaffected by the cap.
	for i := 0; i < 5; i++ {
		if reject, _ := h.RejectEvent(context.Background(), modAction("member", "")); reject {
			t.Fatalf("non-moderator report %d must not be capped by mod-limits", i)
		}
	}
	// But the moderator IS capped at 1/day.
	if reject, _ := h.RejectEvent(context.Background(), modAction("mod", "")); reject {
		t.Fatal("moderator's first hide should pass")
	}
	if reject, _ := h.RejectEvent(context.Background(), modAction("mod", "")); !reject {
		t.Fatal("moderator's 2nd hide must hit the daily cap of 1")
	}
}
