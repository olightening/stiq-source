package ratelimit

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/policy"
)

type fakeSource struct {
	limits policy.Limits
	mods   map[string]struct{}
	orgs   map[string]struct{}
}

func (f *fakeSource) Limits() policy.Limits { return f.limits }
func (f *fakeSource) IsModerator(pk string) bool {
	_, ok := f.mods[pk]
	return ok
}
func (f *fakeSource) IsOrganizer(pk string) bool {
	_, ok := f.orgs[pk]
	return ok
}

func ev(kind int, pubkey string, tags ...nostr.Tag) *nostr.Event {
	return &nostr.Event{Kind: kind, PubKey: pubkey, Tags: nostr.Tags(tags)}
}

// TestCategorizeNewKinds locks in the finding-#40 (NIP-29 management/creation kinds capped under
// the channel window) and finding-#43 (content-unlock request 9026 capped as mailbox) mappings.
func TestCategorizeNewKinds(t *testing.T) {
	for _, k := range []int{9000, 9001, 9002, 9007, 9008, 9009, 9021, 9022} {
		if got := categorize(ev(k, "x")); got != catChannel {
			t.Errorf("kind %d: categorize = %v, want catChannel (finding #40)", k, got)
		}
	}
	if got := categorize(ev(9026, "x")); got != catMailbox {
		t.Errorf("kind 9026 (content-unlock request): categorize = %v, want catMailbox (finding #43)", got)
	}
	// hardening: the organizer's enroll/draw/unlock RESPONSE kinds used to fall to catNone (uncapped
	// storage-write). They must now be counted so an unauthenticated flood can't exhaust relay disk.
	for _, k := range []int{9023, 9025, 9027} {
		if got := categorize(ev(k, "x")); got != catMailboxResponse {
			t.Errorf("kind %d (mailbox response): categorize = %v, want catMailboxResponse", k, got)
		}
	}
}

// TestMailboxResponseGlobalCap: the organizer RESPONSE kinds (9023/9025/9027) are bounded by the
// global MailboxPerMin window (hardening: mailbox-response DoS). Previously they were catNone and
// stored without any cap.
func TestMailboxResponseGlobalCap(t *testing.T) {
	now := time.Unix(1000, 0)
	src := &fakeSource{limits: policy.Limits{MailboxPerMin: 2}}
	l := New(src)
	l.now = func() time.Time { return now }
	resp := func() (bool, string) { return l.RejectEvent(context.Background(), ev(9027, "ephemeral")) }

	if reject, _ := resp(); reject {
		t.Fatal("1st mailbox response should pass")
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(9023, "ephemeral2")); reject {
		t.Fatal("2nd mailbox response (enroll-response) should pass")
	}
	if reject, _ := resp(); !reject {
		t.Fatal("3rd mailbox response in a minute should hit the global cap")
	}
	// After a minute the window clears.
	now = now.Add(61 * time.Second)
	if reject, _ := resp(); reject {
		t.Fatal("mailbox response should be admitted after the minute window clears")
	}
}

// TestMailboxResponseOrganizerExemption (2026-07-21 incident): the organizer's OWN mailbox responses
// must never be capped by the global MailboxPerMin window — that cap exists to stop an
// unauthenticated forger from flooding storage, not to throttle the community's single legitimate
// issuer replying to its members. A non-organizer signer must still hit the cap unchanged.
func TestMailboxResponseOrganizerExemption(t *testing.T) {
	now := time.Unix(1000, 0)
	src := &fakeSource{
		limits: policy.Limits{MailboxPerMin: 1},
		orgs:   map[string]struct{}{"organizer-pubkey": {}},
	}
	l := New(src)
	l.now = func() time.Time { return now }

	// A non-organizer response saturates the cap=1 global window immediately.
	if reject, _ := l.RejectEvent(context.Background(), ev(9025, "not-the-organizer")); reject {
		t.Fatal("1st non-organizer response should pass")
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(9027, "not-the-organizer")); !reject {
		t.Fatal("2nd non-organizer response should hit the (cap=1) global window")
	}

	// The organizer's own responses bypass the cap entirely — far beyond the saturated window above,
	// and without consuming any of it (each call re-checks the same exhausted window).
	for i := 0; i < 10; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(9023, "organizer-pubkey")); reject {
			t.Fatalf("organizer response %d should bypass the mailbox-response cap: %s", i, msg)
		}
	}

	// The non-organizer window is unaffected by the organizer traffic above: still capped at 1.
	if reject, _ := l.RejectEvent(context.Background(), ev(9025, "still-not-the-organizer")); !reject {
		t.Fatal("a non-organizer response must still hit the global cap after organizer traffic")
	}
}

// TestMailboxResponseSeparateFromRequests: a response flood must not starve the request budget (they
// use separate windows). Fill the response window to its cap, then a REQUEST must still be admitted.
func TestMailboxResponseSeparateFromRequests(t *testing.T) {
	now := time.Unix(1000, 0)
	src := &fakeSource{limits: policy.Limits{MailboxPerMin: 1}}
	l := New(src)
	l.now = func() time.Time { return now }

	if reject, _ := l.RejectEvent(context.Background(), ev(9025, "eph")); reject {
		t.Fatal("1st mailbox response should pass")
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(9025, "eph")); !reject {
		t.Fatal("2nd mailbox response should hit the (cap=1) response window")
	}
	// The request window is independent — a real enroll/draw request still gets through.
	if reject, msg := l.RejectEvent(context.Background(), ev(9024, "eph")); reject {
		t.Fatalf("mailbox REQUEST must not be starved by a response flood: %s", msg)
	}
}

// TestManagementKindsThrottled: a group-management flood from one member is bounded by the channel
// cap (finding #40) — previously these returned catNone and were never counted.
func TestManagementKindsThrottled(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{Channel: policy.Window{Daily: 3}}}
	l := New(src)
	for i := 0; i < 3; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(9002, "admin")); reject {
			t.Fatalf("edit-metadata %d rejected early: %s", i, msg)
		}
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(9002, "admin")); !reject {
		t.Fatal("4th NIP-29 management event should be rejected by the channel daily cap")
	}
}

func TestPostDailyCap(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{Posts: policy.Window{Daily: 2}}}
	l := New(src)
	for i := 0; i < 2; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(1, "alice")); reject {
			t.Fatalf("post %d rejected: %s", i, msg)
		}
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(1, "alice")); !reject {
		t.Fatal("3rd post should be rejected by daily cap")
	}
	// A different user is unaffected.
	if reject, _ := l.RejectEvent(context.Background(), ev(1, "bob")); reject {
		t.Fatal("bob should not be rate-limited by alice's activity")
	}
}

func TestDefaultLimitsBoundBoundNpubButNotBlind(t *testing.T) {
	// A limiter reading a fresh ConfigHolder (no stiq:limits published yet) must apply the non-zero
	// DEFAULT to bound-npub posts, so an unconfigured relay is not wide open — and must still NOT
	// limit blind posts (they carry a token and are bounded by TOKENS_PER_EPOCH instead).
	l := New(policy.NewConfigHolder([]string{"org"}))
	dailyCap := policy.DefaultLimits.Posts.Daily
	for i := 0; i < dailyCap; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(1, "alice")); reject {
			t.Fatalf("bound-npub post %d should be within the default cap: %s", i, msg)
		}
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(1, "alice")); !reject {
		t.Fatal("the post past the default daily cap should be rejected")
	}
	// Blind posts skip the limiter entirely, regardless of the default.
	for i := 0; i < dailyCap*3; i++ {
		if reject, _ := l.RejectEvent(context.Background(), ev(1, "throwaway", nostr.Tag{"stiq_token", "x"})); reject {
			t.Fatal("a blind post (carries stiq_token) must never be rate-limited")
		}
	}
}

// TestSpaceTokenContentStillRateLimited (tokens-everywhere) locks in the fix for the rate-limiter
// bypass: an ATTRIBUTED space event (channel message 1311, DM wrap 1059) that carries a space-write
// stiq_token is NOT a throwaway-signed blind post, so it must STILL flow through the per-channel /
// global-DM windows — the token is an extra spam brake, not a replacement. Only the anonymous blind
// path is exempt from the limiter.
func TestSpaceTokenContentStillRateLimited(t *testing.T) {
	// A channel message (1311) carrying a space token must still be capped by the Channel window.
	l := New(&fakeSource{limits: policy.Limits{Channel: policy.Window{Daily: 3}}})
	tok := nostr.Tag{"stiq_token", "x"}
	for i := 0; i < 3; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(1311, "alice", tok)); reject {
			t.Fatalf("token-tagged channel message %d within the cap must admit: %s", i, msg)
		}
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(1311, "alice", tok)); !reject {
		t.Fatal("a token-tagged channel message PAST the Channel cap must be rejected — the space-write token must not exempt attributed content from the rate window")
	}

	// A DM gift wrap (1059) carrying a space token must still be capped by the global DM/min window.
	l2 := New(&fakeSource{limits: policy.Limits{DMGlobalPerMin: 2}})
	for i := 0; i < 2; i++ {
		if reject, msg := l2.RejectEvent(context.Background(), ev(1059, "wrapkey", tok)); reject {
			t.Fatalf("token-tagged DM wrap %d within the global cap must admit: %s", i, msg)
		}
	}
	if reject, _ := l2.RejectEvent(context.Background(), ev(1059, "wrapkey", tok)); !reject {
		t.Fatal("a token-tagged DM wrap PAST the global DM cap must be rejected")
	}

	// Control: an ANONYMOUS blind post (kind 1, throwaway signer) carrying a token stays EXEMPT.
	l3 := New(&fakeSource{limits: policy.Limits{Posts: policy.Window{Daily: 1}}})
	for i := 0; i < 10; i++ {
		if reject, _ := l3.RejectEvent(context.Background(), ev(1, "throwaway", tok)); reject {
			t.Fatal("an anonymous blind post must remain exempt from the limiter")
		}
	}
}

func TestWeeklyCapAcrossDays(t *testing.T) {
	now := time.Unix(7*secondsPerDay, 0)
	src := &fakeSource{limits: policy.Limits{Posts: policy.Window{Weekly: 3}}}
	l := New(src)
	l.now = func() time.Time { return now }

	post := func() (bool, string) { return l.RejectEvent(context.Background(), ev(1, "alice")) }
	post()
	now = now.Add(24 * time.Hour)
	post()
	now = now.Add(24 * time.Hour)
	post()
	if reject, _ := post(); !reject {
		t.Fatal("4th post within 7 days should hit the weekly cap")
	}
	// Move 7 days past the first post; weekly window slides and admits again.
	now = now.Add(7 * 24 * time.Hour)
	if reject, msg := post(); reject {
		t.Fatalf("post should be admitted after the window slides: %s", msg)
	}
}

func TestCommentDetection(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{Comments: policy.Window{Daily: 1}}}
	l := New(src)
	stiqComment := ev(1, "alice", nostr.Tag{"t", "stiq-comment"})
	if reject, _ := l.RejectEvent(context.Background(), stiqComment); reject {
		t.Fatal("first comment should pass")
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(1111, "alice")); !reject {
		t.Fatal("kind-1111 comment should count against the comment cap and be rejected")
	}
	// Posts are a separate bucket — still allowed.
	if reject, _ := l.RejectEvent(context.Background(), ev(1, "alice")); reject {
		t.Fatal("a real post should not be limited by the comment cap")
	}
}

func TestModeratorExemption(t *testing.T) {
	src := &fakeSource{
		limits: policy.Limits{Posts: policy.Window{Daily: 1}, ExemptModerators: true},
		mods:   map[string]struct{}{"mod": {}},
	}
	l := New(src)
	for i := 0; i < 5; i++ {
		if reject, _ := l.RejectEvent(context.Background(), ev(1, "mod")); reject {
			t.Fatalf("moderator post %d should be exempt", i)
		}
	}
}

func TestDMGlobalCap(t *testing.T) {
	now := time.Unix(1000, 0)
	src := &fakeSource{limits: policy.Limits{DMGlobalPerMin: 2}}
	l := New(src)
	l.now = func() time.Time { return now }
	dm := func() (bool, string) { return l.RejectEvent(context.Background(), ev(1059, "ephemeral")) }
	dm()
	dm()
	if reject, _ := dm(); !reject {
		t.Fatal("3rd DM in a minute should hit the global cap")
	}
	// After a minute the window clears.
	now = now.Add(61 * time.Second)
	if reject, _ := dm(); reject {
		t.Fatal("DM should be admitted after the minute window clears")
	}
}

// connTestKey carries a fake per-connection identity on the context so the per-connection mailbox
// cap can be exercised without a live khatru WebSocket.
type connTestKey struct{}

func connCtx(id string) context.Context {
	return context.WithValue(context.Background(), connTestKey{}, id)
}

// withTestConnKey points the limiter at the context-carried fake connection id.
func withTestConnKey(l *Limiter) {
	l.connKey = func(ctx context.Context) any {
		if v := ctx.Value(connTestKey{}); v != nil {
			return v
		}
		return nil
	}
}

func TestMailboxGlobalCap(t *testing.T) {
	now := time.Unix(1000, 0)
	// Per-connection cap off so this isolates the global window; both draw (9024) and enroll (9020)
	// requests count against the one community-wide bucket.
	src := &fakeSource{limits: policy.Limits{MailboxPerMin: 2}}
	l := New(src)
	l.now = func() time.Time { return now }
	draw := func() (bool, string) { return l.RejectEvent(context.Background(), ev(9024, "ephemeral")) }

	if reject, _ := draw(); reject {
		t.Fatal("1st mailbox request should pass")
	}
	// An enroll request shares the same global bucket.
	if reject, _ := l.RejectEvent(context.Background(), ev(9020, "ephemeral2")); reject {
		t.Fatal("2nd mailbox request (enroll) should pass")
	}
	if reject, _ := draw(); !reject {
		t.Fatal("3rd mailbox request in a minute should hit the global cap")
	}
	// After a minute the window clears.
	now = now.Add(61 * time.Second)
	if reject, _ := draw(); reject {
		t.Fatal("mailbox request should be admitted after the minute window clears")
	}
}

func TestMailboxPerConnectionCap(t *testing.T) {
	now := time.Unix(1000, 0)
	// Global cap high; per-connection cap of 2 is the lever under test.
	src := &fakeSource{limits: policy.Limits{MailboxPerMin: 1000, MailboxPerConnPerMin: 2}}
	l := New(src)
	l.now = func() time.Time { return now }
	withTestConnKey(l)

	drawOn := func(conn string) (bool, string) {
		return l.RejectEvent(connCtx(conn), ev(9024, "ephemeral"))
	}

	// Connection A may send 2, then is throttled.
	if reject, _ := drawOn("A"); reject {
		t.Fatal("A request 1 should pass")
	}
	if reject, _ := drawOn("A"); reject {
		t.Fatal("A request 2 should pass")
	}
	if reject, _ := drawOn("A"); !reject {
		t.Fatal("A request 3 should hit the per-connection cap")
	}
	// A different connection has its own independent budget — a single flooder can't starve others.
	if reject, _ := drawOn("B"); reject {
		t.Fatal("connection B must not be limited by A's flood")
	}
	// After the window clears, A can send again.
	now = now.Add(61 * time.Second)
	if reject, _ := drawOn("A"); reject {
		t.Fatal("A should be admitted after its per-connection window clears")
	}
}

func TestMailboxDisconnectDropsConnectionState(t *testing.T) {
	now := time.Unix(1000, 0)
	src := &fakeSource{limits: policy.Limits{MailboxPerConnPerMin: 2}}
	l := New(src)
	l.now = func() time.Time { return now }
	withTestConnKey(l)

	ctxA := connCtx("A")
	ctxB := connCtx("B")
	if reject, msg := l.RejectEvent(ctxA, ev(9024, "ephemeral-a")); reject {
		t.Fatalf("A request rejected: %s", msg)
	}
	if reject, msg := l.RejectEvent(ctxB, ev(9024, "ephemeral-b")); reject {
		t.Fatalf("B request rejected: %s", msg)
	}
	if got := len(l.mailboxConn); got != 2 {
		t.Fatalf("expected two live connection counters, got %d", got)
	}

	l.ForgetConnection(ctxA)
	if got := len(l.mailboxConn); got != 1 {
		t.Fatalf("disconnect must release A immediately; still tracking %d connections", got)
	}
	if _, ok := l.mailboxConn["A"]; ok {
		t.Fatal("disconnected connection A is still retained")
	}
	if _, ok := l.mailboxConn["B"]; !ok {
		t.Fatal("disconnect cleanup removed unrelated live connection B")
	}

	// Reusing the test id after disconnect represents a fresh connection and gets a fresh window.
	if reject, msg := l.RejectEvent(ctxA, ev(9024, "ephemeral-a2")); reject {
		t.Fatalf("fresh A connection should get a fresh window: %s", msg)
	}
}

func TestMailboxDisconnectCleanupBoundsConnectionChurn(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{MailboxPerConnPerMin: 1_000_000}}
	l := New(src)
	withTestConnKey(l)

	// This models the production failure mode: many one-request sockets that close immediately.
	// The map must stay empty without waiting for the periodic five-minute idle sweep.
	for i := 0; i < 10_000; i++ {
		ctx := connCtx("churn-" + itoa(i))
		if reject, msg := l.RejectEvent(ctx, ev(9024, "ephemeral")); reject {
			t.Fatalf("connection %d rejected: %s", i, msg)
		}
		l.ForgetConnection(ctx)
	}
	if got := len(l.mailboxConn); got != 0 {
		t.Fatalf("closed connection churn retained %d counters", got)
	}
}

func TestMailboxUnlimitedWhenZero(t *testing.T) {
	// Both caps 0 ⇒ mailbox throttling disabled; requests always pass.
	src := &fakeSource{limits: policy.Limits{}}
	l := New(src)
	withTestConnKey(l)
	for i := 0; i < 50; i++ {
		if reject, _ := l.RejectEvent(connCtx("A"), ev(9024, "ephemeral")); reject {
			t.Fatal("mailbox requests must never be limited when both caps are 0")
		}
	}
}

func TestMailboxIdleConnectionsSwept(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	// Per-connection cap high (so no request is rejected for rate) and global off, to isolate the
	// per-connection map's growth + eviction.
	src := &fakeSource{limits: policy.Limits{MailboxPerConnPerMin: 1_000_000}}
	l := New(src)
	l.now = func() time.Time { return now }
	withTestConnKey(l)

	// A burst of distinct connections (above the sweep threshold) each send one request.
	const conns = 600
	for i := 0; i < conns; i++ {
		if reject, _ := l.RejectEvent(connCtx("flood-"+itoa(i)), ev(9024, "ephemeral")); reject {
			t.Fatalf("connection %d should be admitted", i)
		}
	}
	if got := len(l.mailboxConn); got != conns {
		t.Fatalf("expected %d tracked connections, got %d", conns, got)
	}

	// All those connections go idle; advance well past the eviction horizon.
	now = now.Add(6 * time.Minute)
	// One live connection keeps sending; its requests drive the periodic sweep, which evicts the now-
	// idle flood entries. Enough calls to cross a connSweepInterval boundary from the current count.
	for i := 0; i < 2*connSweepInterval; i++ {
		l.RejectEvent(connCtx("live"), ev(9024, "ephemeral"))
	}
	if got := len(l.mailboxConn); got > 2 {
		t.Fatalf("idle connection entries should have been swept; still tracking %d", got)
	}
}

// itoa is a tiny int→string helper so the test needs no extra import.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// TestRetryAfterSuffix pins the machine-readable "(retry_after=60)" suffix and the stable "[code]"
// prefix on the two fixed 60-second-window rejections (DM + mailbox) (T12-S2). A new client parses
// both; a generic client still shows the readable prose.
func TestRetryAfterSuffix(t *testing.T) {
	t.Run("dm", func(t *testing.T) {
		src := &fakeSource{limits: policy.Limits{DMGlobalPerMin: 1}}
		l := New(src)
		if reject, msg := l.RejectEvent(context.Background(), ev(1059, "ephemeral")); reject {
			t.Fatalf("first DM should pass: %s", msg)
		}
		reject, msg := l.RejectEvent(context.Background(), ev(1059, "ephemeral"))
		if !reject {
			t.Fatal("2nd DM in a minute should hit the global cap")
		}
		if !strings.HasPrefix(msg, "[rate_limited_dm] ") {
			t.Errorf("DM reject %q must begin with [rate_limited_dm]", msg)
		}
		if !strings.Contains(msg, "(retry_after=60)") {
			t.Errorf("DM reject %q must carry the (retry_after=60) suffix", msg)
		}
	})

	t.Run("mailbox", func(t *testing.T) {
		src := &fakeSource{limits: policy.Limits{MailboxPerMin: 1}}
		l := New(src)
		if reject, msg := l.RejectEvent(context.Background(), ev(9024, "ephemeral")); reject {
			t.Fatalf("first mailbox request should pass: %s", msg)
		}
		reject, msg := l.RejectEvent(context.Background(), ev(9024, "ephemeral"))
		if !reject {
			t.Fatal("2nd mailbox request in a minute should hit the global cap")
		}
		if !strings.HasPrefix(msg, "[rate_limited_mailbox] ") {
			t.Errorf("mailbox reject %q must begin with [rate_limited_mailbox]", msg)
		}
		if !strings.Contains(msg, "(retry_after=60)") {
			t.Errorf("mailbox reject %q must carry the (retry_after=60) suffix", msg)
		}
	})
}

// TestSecondsToNextUTCDay pins the daily retry_after math against a fixed clock: seconds to the next
// 00:00:00 UTC boundary, clamped to [1, 86400] and never 0/negative.
func TestSecondsToNextUTCDay(t *testing.T) {
	cases := []struct {
		name string
		now  time.Time
		want int64
	}{
		{"thirty-seconds-before-midnight", time.Date(2026, 7, 11, 23, 59, 30, 0, time.UTC), 30},
		{"exactly-midnight", time.Date(2026, 7, 11, 0, 0, 0, 0, time.UTC), 86400},
	}
	for _, c := range cases {
		if got := secondsToNextUTCDay(c.now); got != c.want {
			t.Errorf("%s: secondsToNextUTCDay = %d, want %d", c.name, got, c.want)
		}
	}
}

// TestDailyUserLimitRetryAfter drives the per-user daily post cap and asserts the daily rejection
// carries a machine-readable "(retry_after=" hint (the seconds-to-UTC-midnight value).
func TestDailyUserLimitRetryAfter(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{Posts: policy.Window{Daily: 1}}}
	l := New(src)
	if reject, msg := l.RejectEvent(context.Background(), ev(1, "alice")); reject {
		t.Fatalf("first post should pass: %s", msg)
	}
	reject, msg := l.RejectEvent(context.Background(), ev(1, "alice"))
	if !reject {
		t.Fatal("2nd post should hit the daily cap")
	}
	if !strings.HasPrefix(msg, "[rate_limited] ") {
		t.Errorf("daily reject %q must begin with [rate_limited]", msg)
	}
	if !strings.Contains(msg, "(retry_after=") {
		t.Errorf("daily reject %q must carry a (retry_after=<sec>) hint", msg)
	}
}

func TestUncappedCategoryAndPrune(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{}} // everything unlimited
	l := New(src)
	now := time.Unix(40*secondsPerDay, 0)
	l.now = func() time.Time { return now }
	for i := 0; i < 10; i++ {
		if reject, _ := l.RejectEvent(context.Background(), ev(1, "alice")); reject {
			t.Fatal("uncapped posts must never be rejected")
		}
	}
	// With a cap set and the clock far in the future, old buckets should have been pruned so
	// they don't count toward the monthly window.
	src.limits = policy.Limits{Posts: policy.Window{Monthly: 1}}
	now = now.Add(40 * 24 * time.Hour)
	if reject, msg := l.RejectEvent(context.Background(), ev(1, "alice")); reject {
		t.Fatalf("stale buckets should have been pruned: %s", msg)
	}
}

// Member reports (kind-1984) used to be COMPLETELY unrate-limited: policy.checkModAction returns
// early for a non-moderator and categorize() had no 1984 case, so they fell to catNone. Only the
// per-event size/tag weight gate stood between one bound member and unbounded storage growth
// (audit 2026-07-29, §2.3 / operational risk 2). They are now counted under the channel/management
// window — the same call already made for NIP-29 management and 31923.
func TestReportsAreRateLimitedButModeratorsAreNot(t *testing.T) {
	if got := categorize(ev(1984, "x")); got != catChannel {
		t.Fatalf("kind 1984: categorize = %v, want catChannel (a report flood must be bounded)", got)
	}

	limits := policy.Limits{Channel: policy.Window{Daily: 2}, ExemptModerators: true}
	src := &fakeSource{limits: limits, mods: map[string]struct{}{"themod": {}}}
	l := New(src)
	l.now = func() time.Time { return time.Unix(1000, 0) }

	// A member gets a generous but finite allowance.
	for i := 0; i < 2; i++ {
		if reject, _ := l.RejectEvent(context.Background(), ev(1984, "member")); reject {
			t.Fatalf("report %d from a member should pass", i+1)
		}
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(1984, "member")); !reject {
		t.Fatal("a member's report flood must eventually be rejected")
	}

	// A MODERATOR is exempt, so bulk moderation is untouched — the whole point of picking a category
	// that respects ExemptModerators rather than bolting on an unconditional cap. Their own
	// stiq:mod-limits caps still apply, enforced separately in policy.checkModAction.
	for i := 0; i < 10; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(1984, "themod")); reject {
			t.Fatalf("moderator action %d was rate-limited (%s); bulk moderation must not be capped here", i+1, msg)
		}
	}
}

// --- 2026-07-29 rate-limiter default-deny fix ---------------------------------------------------
//
// categorize()'s default branch used to return catNone (unlimited) for 20 allow-listed kinds it had
// no case for. The tests below cover the new catReaction/catGroupChat/catDefault categories, the two
// fail-closed default branches (categorize()'s and windowFor()'s), and the blind/attributed carve-out
// interactions that make kind 7 tricky (an untagged blind vote must stay exempt; an h-tagged or
// tokened-and-h-tagged reaction must not).

// TestCategorizeReactionAndGroupChat locks in the two new categories added by this fix.
// categorize() itself maps kind 7 to catReaction UNCONDITIONALLY (it does not look at tags) — the
// h-tag/blind-token distinction is resolved earlier, in RejectEvent, before categorize() is ever
// called (see TestBlindUntaggedReactionStillFullyExempt /
// TestAttributedHTaggedReactionCountedEvenWithToken for that layer). Both kind 7 and kinds 9/11/12
// used to fall through to catNone (unlimited) before this fix.
func TestCategorizeReactionAndGroupChat(t *testing.T) {
	if got := categorize(ev(7, "x")); got != catReaction {
		t.Errorf("kind 7: categorize = %v, want catReaction", got)
	}
	for _, k := range []int{9, 11, 12} {
		if got := categorize(ev(k, "x")); got != catGroupChat {
			t.Errorf("kind %d: categorize = %v, want catGroupChat", k, got)
		}
	}
}

// TestCategorizeVoiceMirrorsTextEquivalents: the voice-message kinds (NIP-A0, off by default via
// AllowVoice) must be bounded exactly like their text equivalents, so enabling voice later doesn't
// silently reopen an unlimited path.
func TestCategorizeVoiceMirrorsTextEquivalents(t *testing.T) {
	if got := categorize(ev(1222, "x")); got != catPost {
		t.Errorf("kind 1222 (voice message): categorize = %v, want catPost", got)
	}
	if got := categorize(ev(1244, "x")); got != catComment {
		t.Errorf("kind 1244 (voice comment): categorize = %v, want catComment", got)
	}
}

// TestCategorizeAdministrativeKindsUseDefaultTier covers the bulk of the 2026-07-29 audit's
// unlimited-kinds finding: profile, NIP-51 lists, long-form articles, app data, space-key delivery,
// live-activity docs, media blobs (non-blind path), channel create/metadata, polls, the double-spend
// witness, and the draft-sharing pair (1987/30500, also newly added to config.DefaultAllowedKinds by
// this change) — all legitimately infrequent, so they share the conservative catDefault tier rather
// than each getting a bespoke window.
func TestCategorizeAdministrativeKindsUseDefaultTier(t *testing.T) {
	kinds := []int{0, 10000, 10003, 10009, 30023, 30078, 30079, 30311, 30351, 40, 41, 1018, 1068, 1986, 1987, 30500}
	for _, k := range kinds {
		if got := categorize(ev(k, "x")); got != catDefault {
			t.Errorf("kind %d: categorize = %v, want catDefault", k, got)
		}
	}
}

// TestCategorizeRelayManagedGroupStateExplicit documents that the relay-managed NIP-29 group state
// kinds (39000-39005) — never actually admitted from a client; GroupGuard rejects them first
// (codeGroupStateManaged, groups.go) — still get an explicit catDefault case rather than being left
// to the default: branch, so the omission reads as audited, not missed.
func TestCategorizeRelayManagedGroupStateExplicit(t *testing.T) {
	for k := 39000; k <= 39005; k++ {
		if got := categorize(ev(k, "x")); got != catDefault {
			t.Errorf("kind %d: categorize = %v, want catDefault", k, got)
		}
	}
}

// TestCategorizeUnknownKindFailsClosed is THE pinning test for this fix's core change: an arbitrary
// kind categorize() has never heard of must fail CLOSED onto catDefault, never catNone. This guards
// against a future author reverting the default: branch back to "return catNone" and silently
// reopening the exact hole the 2026-07-29 audit closed.
func TestCategorizeUnknownKindFailsClosed(t *testing.T) {
	if got := categorize(ev(654321, "x")); got != catDefault {
		t.Fatalf("categorize(unknown kind) = %v, want catDefault (fail closed, NOT catNone)", got)
	}
}

// TestCategorizeDeliberateExemptionsStillNone locks in that kind 31925 (event "interested" RSVP) is
// a DELIBERATE, fully-unbounded exemption (catNone), not merely a catDefault kind that happens to
// look unlimited because the policy hasn't set a Default window — those two would be indistinguishable
// under an all-zero Limits{}, so this test uses a NON-zero Default to show the categories genuinely
// behave differently: a catDefault kind (30023) gets capped by it, while 31925 (catNone) never even
// reaches the windowFor/admitUser machinery and sails past the identical cap unconditionally.
func TestCategorizeDeliberateExemptionsStillNone(t *testing.T) {
	if got := categorize(ev(31925, "x")); got != catNone {
		t.Fatalf("kind 31925: categorize = %v, want catNone (deliberate, documented exemption)", got)
	}

	l := New(&fakeSource{limits: policy.Limits{Default: policy.Window{Daily: 2}}})
	for i := 0; i < 2; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(30023, "author")); reject {
			t.Fatalf("article %d within the Default cap should admit: %s", i, msg)
		}
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(30023, "author")); !reject {
		t.Fatal("a catDefault kind (30023) must be capped once a non-zero Default window is configured")
	}
	// kind 31925 sails past the SAME cap unconditionally, any number of times — it is catNone and
	// never reaches windowFor/admitUser at all.
	for i := 0; i < 10; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(31925, "author")); reject {
			t.Fatalf("kind-31925 event %d should be unconditionally admitted regardless of the Default cap: %s", i, msg)
		}
	}
}

// TestWindowForUnknownCategoryFallsBackToDefault pins the second layer of the fail-closed fix:
// windowFor(), called with a category value matching none of its cases (a synthetic out-of-range
// value standing in for a future category constant added without a windowFor case), must return
// limits.Default, never the zero-value policy.Window{} (which admitUser/RejectEvent treat as
// "unlimited").
func TestWindowForUnknownCategoryFallsBackToDefault(t *testing.T) {
	limits := policy.Limits{Default: policy.Window{Daily: 42}}
	if got := windowFor(category(999), limits); got != limits.Default {
		t.Fatalf("windowFor(unknown category) = %+v, want limits.Default %+v", got, limits.Default)
	}
}

// TestReactionCeilingAboveChannelWindow is the regression test that would have caught a naive "just
// reuse catChannel for kind 7" implementation: with Channel capped far below Reaction, 100 h-tagged
// reactions from one pubkey must ALL be admitted — a catChannel-based implementation would start
// rejecting at #51.
func TestReactionCeilingAboveChannelWindow(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{Channel: policy.Window{Daily: 50}, Reaction: policy.Window{Daily: 500}}}
	l := New(src)
	tag := nostr.Tag{"h", "grp"}
	for i := 0; i < 100; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(7, "voter", tag)); reject {
			t.Fatalf("h-tagged reaction %d should be admitted under the Reaction ceiling: %s", i, msg)
		}
	}
}

// TestGroupChatCountedPerUserAndCapped mirrors TestManagementKindsThrottled for the new GroupChat
// window: a single pubkey's kind-9 flood is counted per-user and capped, with the reject message
// naming "group message" (name(catGroupChat)).
func TestGroupChatCountedPerUserAndCapped(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{GroupChat: policy.Window{Daily: 3}}}
	l := New(src)
	for i := 0; i < 3; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(9, "chatty")); reject {
			t.Fatalf("group chat message %d rejected early: %s", i, msg)
		}
	}
	reject, msg := l.RejectEvent(context.Background(), ev(9, "chatty"))
	if !reject {
		t.Fatal("4th group chat message should be rejected by the GroupChat daily cap")
	}
	if !strings.HasPrefix(msg, "[rate_limited] ") {
		t.Errorf("reject message %q should begin with [rate_limited]", msg)
	}
	if !strings.Contains(msg, "group message") {
		t.Errorf("reject message %q should name the category %q", msg, "group message")
	}
}

// TestReactionCountedPerUserAndCapped is the same shape as TestGroupChatCountedPerUserAndCapped for
// h-tagged kind-7 reactions.
func TestReactionCountedPerUserAndCapped(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{Reaction: policy.Window{Daily: 3}}}
	l := New(src)
	tag := nostr.Tag{"h", "grp"}
	for i := 0; i < 3; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(7, "voter", tag)); reject {
			t.Fatalf("reaction %d rejected early: %s", i, msg)
		}
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(7, "voter", tag)); !reject {
		t.Fatal("4th reaction should be rejected by the Reaction daily cap")
	}
}

// TestBlindUntaggedReactionStillFullyExempt is a regression guard for the blind-vote carve-out
// (isBlindPost/isAttributedSpaceContent in RejectEvent): an UNTAGGED kind-7 carrying a stiq_token
// must be admitted unconditionally. The Reaction cap here is intentionally TIGHT (1/day): if the
// blind-vote carve-out did not fire first and this fell through to catReaction's per-user window, the
// 2nd event would be rejected. All 20 admitting proves the exemption runs upstream of catReaction
// entirely, not that the window merely happens to be generous.
func TestBlindUntaggedReactionStillFullyExempt(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{Reaction: policy.Window{Daily: 1}}}
	l := New(src)
	tok := nostr.Tag{"stiq_token", "x"}
	for i := 0; i < 20; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(7, "throwaway", tok)); reject {
			t.Fatalf("untagged blind reaction %d must remain exempt: %s", i, msg)
		}
	}
}

// TestAttributedHTaggedReactionCountedEvenWithToken is the companion to
// TestBlindUntaggedReactionStillFullyExempt: an h-tagged kind-7 carrying BOTH an h tag and a
// stiq_token must still be counted against Reaction (tokens-everywhere) — the token does not
// re-exempt attributed space content, only a truly anonymous blind post.
func TestAttributedHTaggedReactionCountedEvenWithToken(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{Reaction: policy.Window{Daily: 2}}}
	l := New(src)
	h, tok := nostr.Tag{"h", "grp"}, nostr.Tag{"stiq_token", "x"}
	for i := 0; i < 2; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(7, "voter", h, tok)); reject {
			t.Fatalf("h-tagged+tokened reaction %d within the cap should admit: %s", i, msg)
		}
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(7, "voter", h, tok)); !reject {
		t.Fatal("h-tagged+tokened reaction PAST the Reaction cap must still be rejected — the token must not re-exempt attributed content")
	}
}

// TestDefaultTierCountedPerUserAndCapped proves the catDefault tier is a REAL per-user cap, not just
// a category label: a catDefault-mapped kind (30023, long-form article) is counted and capped like
// any other attributed category.
func TestDefaultTierCountedPerUserAndCapped(t *testing.T) {
	src := &fakeSource{limits: policy.Limits{Default: policy.Window{Daily: 2}}}
	l := New(src)
	for i := 0; i < 2; i++ {
		if reject, msg := l.RejectEvent(context.Background(), ev(30023, "writer")); reject {
			t.Fatalf("article %d within the Default cap should admit: %s", i, msg)
		}
	}
	if reject, _ := l.RejectEvent(context.Background(), ev(30023, "writer")); !reject {
		t.Fatal("3rd article should be rejected by the Default daily cap")
	}
}
