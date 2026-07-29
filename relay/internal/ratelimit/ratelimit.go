// Package ratelimit bounds how much each member can write so the relay can't grow without
// limit (PLAN.md §3.4, objective: prevent spam + preserve relay storage/cost).
//
// Per-user caps apply to posts / comments / channel messages — all signed by bound npubs, so
// the relay can attribute them. DMs (kind-1059 gift wraps) are ephemeral-signed to hide the
// sender, so they cannot be attributed to a user; they get a single GLOBAL per-minute cap
// instead. The caps themselves come live from the organizer's policy (policy.ConfigHolder).
package ratelimit

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/policy"
)

const (
	stiqCommentMarker = "stiq-comment"
	secondsPerDay     = 86400
	// retainDays bounds per-user memory: monthly windows need 30 days, keep a little slack.
	retainDays = 31
	// mailboxRequestKinds are the credential-exchange REQUEST kinds the relay throttles (enroll,
	// draw, content-unlock). All are ephemeral-signed / unattributable exactly like DMs, so the same
	// global + per-connection mailbox caps must protect the single-threaded organizer mailbox from a
	// forwarded-request flood on ANY of them. (finding #43 adds 9026)
	kindEnrollRequest = 9020
	kindDrawRequest   = 9024
	kindUnlockRequest = 9026
	// mailboxResponseKinds are the organizer's credential-exchange RESPONSE kinds. A signer that is NOT
	// a configured organizer cannot be told apart from a forger by this hook alone, and leaving them
	// uncapped (they used to fall to catNone) made them an unauthenticated, 12-bit-PoW-only
	// storage-write path: an attacker could flood 64KiB blobs to exhaust relay disk and inject forged
	// "organizer responses" into members' mailboxes. They are throttled by a GLOBAL-only window
	// (admitMailboxResponse) — a per-connection cap would throttle the single legitimate organizer
	// connection under enrollment load. A response signed by a CONFIGURED organizer pubkey is exempt
	// from that cap entirely: RequireValidSignature runs before every RejectEvent hook (relay.go), so
	// by the time this hook sees the event its signature is already verified against event.PubKey —
	// an attacker cannot forge a response bearing the organizer's pubkey without its secret key, so
	// the pubkey match is a sound authenticity check. Capping the organizer's own replies was the
	// 2026-07-21 incident: the community's single issuer got rate-limited by its own relay, burning
	// members' enroll/draw/unlock requests all night with no response ever landing. (hardening:
	// mailbox-response DoS)
	kindEnrollResponse = 9023
	kindDrawResponse   = 9025
	kindUnlockResponse = 9027
	// connIdleEvict drops a per-connection counter after this long with no mailbox traffic, so
	// closed/idle connections don't accumulate. Longer than the 1-minute window so an active
	// connection is never evicted mid-use.
	connIdleEvict = 5 * time.Minute
	// connSweepThreshold skips the sweep entirely while the map is small (nothing worth iterating).
	connSweepThreshold = 512
	// connSweepInterval runs the idle-connection sweep once every N mailbox requests, regardless of
	// whether they were admitted or rejected — so a flood that saturates the GLOBAL cap (and thus
	// never reaches the record path) still gets its per-connection map pruned.
	connSweepInterval = 256
)

// Stable machine-readable reject codes for the rate-limit path, carried as a bracketed "[code]"
// prefix on the reject prose (mirrors policy.reason / policy.RejectCodesVersion — the vocabulary is
// versioned there and advertised in NIP-11 stiq-capabilities.reject_codes_version). The period
// (daily/weekly/monthly) rides in the prose after the code. A new client switches on the code; the
// existing/generic client still shows the unchanged prose.
const (
	codeRateLimited        = "rate_limited"
	codeRateLimitedDM      = "rate_limited_dm"
	codeRateLimitedMailbox = "rate_limited_mailbox"
)

// reason formats a reject reason with a stable code prefix: "[code] prose". Kept byte-for-byte
// compatible with the pre-code prose (the code is a pure prefix) so Contains-based tests and the
// current client's prose display are unaffected.
func reason(code, msg string) string { return "[" + code + "] " + msg }

// secondsToNextUTCDay returns the number of seconds from now to the next 00:00:00 UTC boundary,
// clamped to [1, 86400]. It is the retry_after hint for the per-user DAILY window, which resets at
// UTC midnight (unlike the DM/mailbox windows, which are fixed 60-second sliding windows). Never
// returns 0 or negative, so a client never sees "retry_after=0" at the instant of the boundary.
func secondsToNextUTCDay(now time.Time) int64 {
	y, m, d := now.UTC().Date()
	next := time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Add(24 * time.Hour)
	s := int64(next.Sub(now) / time.Second)
	if s < 1 {
		s = 1
	}
	return s
}

// Source supplies the live policy the limiter enforces.
type Source interface {
	Limits() policy.Limits
	IsModerator(pubkey string) bool
	// IsOrganizer reports whether pubkey is a configured, trusted organizer (policy.ConfigHolder's
	// organizer_pubkeys set). Consulted by admitMailboxResponse to exempt the community's own issuer
	// from the mailbox-response cap.
	IsOrganizer(pubkey string) bool
}

type category int

const (
	catNone category = iota
	catPost
	catComment
	catChannel
	catDM
	// catMailbox is enroll/draw/unlock REQUESTS. Like catDM it is ephemeral-signed and unattributable,
	// so it is handled by global + per-connection windows, never the per-user counters — it must stay
	// out of the userCounters array (sized by catChannel).
	catMailbox
	// catMailboxResponse is the organizer's enroll/draw/unlock RESPONSE kinds. Ephemeral-signed by an
	// unverifiable mailbox key, so — like catMailbox — never per-user counted. Bounded by a GLOBAL-only
	// window (admitMailboxResponse) so a flood can't exhaust disk, without throttling the single
	// legitimate organizer connection with a per-connection cap.
	catMailboxResponse
)

// userCounters holds per-day event counts per category for one pubkey.
type userCounters struct {
	// days maps a day index (unix/86400) to per-category counts.
	days map[int64]*[catChannel + 1]int
}

// connWindow is one connection's recent mailbox-request timestamps plus a last-seen stamp used to
// evict idle/closed connections.
type connWindow struct {
	hits     []int64
	lastSeen int64
}

// Snapshot contains limiter cardinalities only; it is safe to expose on the loopback diagnostics
// endpoint because it contains no pubkeys, event IDs, timestamps, or tokens.
type Snapshot struct {
	Users               int `json:"users"`
	DMHits              int `json:"dm_hits"`
	MailboxHits         int `json:"mailbox_hits"`
	MailboxResponseHits int `json:"mailbox_response_hits"`
	MailboxConnections  int `json:"mailbox_connections"`
}

// Limiter is a khatru RejectEvent hook enforcing the organizer's rate-limit policy.
type Limiter struct {
	src Source
	now func() time.Time
	// connKey extracts a per-connection key from the request context (the khatru *WebSocket, unique
	// per connection). Pluggable so tests can simulate distinct connections without a live relay; the
	// default returns nil for a context with no connection (e.g. internal calls), skipping the
	// per-connection cap.
	connKey func(ctx context.Context) any

	mu      sync.Mutex
	users   map[string]*userCounters
	dm      []int64 // unix-second timestamps of recent DM gift wraps (global sliding window)
	mailbox []int64 // unix-second timestamps of recent mailbox requests (global sliding window)
	// mailboxResp is the global sliding window for organizer credential-exchange RESPONSE kinds
	// (9023/9025/9027). Kept separate from `mailbox` so a response flood can't starve the request
	// budget (and vice-versa); both are capped by limits.MailboxPerMin. (hardening: mailbox-response DoS)
	mailboxResp []int64
	// mailboxConn holds each connection's recent mailbox-request window, keyed on the connection
	// object. ForgetConnection removes it as soon as Khatru closes the socket; the idle sweep is a
	// fallback for callers that do not wire the disconnect hook.
	mailboxConn map[any]*connWindow
	// mailboxCalls counts admitMailbox invocations to drive the periodic idle-connection sweep.
	mailboxCalls int
}

// New builds a limiter reading its caps from src.
func New(src Source) *Limiter {
	return &Limiter{
		src:         src,
		now:         time.Now,
		connKey:     khatruConnKey,
		users:       make(map[string]*userCounters),
		mailboxConn: make(map[any]*connWindow),
	}
}

// khatruConnKey returns the per-connection key for a live relay: the *khatru.WebSocket, which is
// unique per connection and stable for its lifetime. Returns nil when there is no connection on the
// context (internal calls / tests), so the per-connection cap is simply skipped there.
func khatruConnKey(ctx context.Context) any {
	if c := khatru.GetConnection(ctx); c != nil {
		return c
	}
	return nil
}

// ForgetConnection releases the rate-limit state for a closed WebSocket immediately. Khatru's
// *WebSocket owns the underlying connection, request, cancellation tree, and negentropy sessions,
// so retaining it as a map key for the five-minute idle fallback can retain far more than this
// limiter's tiny timestamp slice. The relay wires this method into OnDisconnect.
func (l *Limiter) ForgetConnection(ctx context.Context) {
	key := l.connKey(ctx)
	if key == nil {
		return
	}
	l.mu.Lock()
	delete(l.mailboxConn, key)
	l.mu.Unlock()
}

// Diagnostics returns current in-memory cardinalities for leak diagnosis.
func (l *Limiter) Diagnostics() Snapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	return Snapshot{
		Users:               len(l.users),
		DMHits:              len(l.dm),
		MailboxHits:         len(l.mailbox),
		MailboxResponseHits: len(l.mailboxResp),
		MailboxConnections:  len(l.mailboxConn),
	}
}

// RejectEvent admits an event only if it stays within the configured caps. It is the last
// admission hook, so a non-reject here means the event is stored — we count it on admit.
func (l *Limiter) RejectEvent(ctx context.Context, event *nostr.Event) (reject bool, msg string) {
	// Blind posts carry a per-post token and are signed by a THROWAWAY key: the token gate already
	// bounded them, and per-pubkey counting here would be useless (a fresh key per post never
	// repeats) and a slow memory leak (one map entry per throwaway key). Skip them.
	//
	// Tokens-everywhere carve-out: a space-write token rides ATTRIBUTED content (channel/group
	// messages, DM wraps — signed by a real npub, not a throwaway). Those must STILL flow through
	// categorize()/admitUser()/admitDM() so the organizer's per-channel + global-DM windows keep
	// applying — the token is an ADDITIONAL spam brake, never a replacement for the rate window (the
	// shared per-credential token quota is far larger than the Channel/DM caps). Only the anonymous
	// blind path is exempt. Before this feature, token-tagged space kinds were rejected at the
	// membership gate and never reached here, so bare `isBlindPost` was safe; now that they're
	// admitted, the exemption must exclude them explicitly.
	if isBlindPost(event) && !isAttributedSpaceContent(event) {
		return false, ""
	}
	cat := categorize(event)
	if cat == catNone {
		return false, ""
	}
	limits := l.src.Limits()
	now := l.now()

	// Mailbox requests (enroll/draw) are unattributable, so they get global + per-connection caps —
	// the backstop that protects the single-threaded organizer mailbox from a forwarded-request flood.
	if cat == catMailbox {
		return l.admitMailbox(ctx, now, limits)
	}

	// Mailbox RESPONSES (organizer enroll/draw/unlock answers) get a GLOBAL-only cap: enough to stop
	// an unauthenticated flood from storing unbounded 64KiB blobs, but no per-connection cap that
	// would throttle the single legitimate organizer. A response whose signer IS the configured
	// organizer is exempt entirely (see admitMailboxResponse) — it is the community's own issuer
	// replying to its members, not a flood.
	if cat == catMailboxResponse {
		return l.admitMailboxResponse(event.PubKey, now, limits)
	}

	if cat == catDM {
		return l.admitDM(now, limits)
	}

	if limits.ExemptModerators && l.src.IsModerator(event.PubKey) {
		return false, ""
	}
	win := windowFor(cat, limits)
	if win == (policy.Window{}) {
		return false, "" // category unlimited
	}
	return l.admitUser(event.PubKey, cat, now, win)
}

func (l *Limiter) admitUser(pubkey string, cat category, now time.Time, win policy.Window) (bool, string) {
	today := now.Unix() / secondsPerDay
	l.mu.Lock()
	defer l.mu.Unlock()

	uc := l.users[pubkey]
	if uc == nil {
		uc = &userCounters{days: make(map[int64]*[catChannel + 1]int)}
		l.users[pubkey] = uc
	}
	uc.prune(today)

	daily, weekly, monthly := uc.sums(cat, today)
	if exceeds(win.Daily, daily) {
		return true, reason(codeRateLimited, fmt.Sprintf("blocked: daily %s limit reached (retry_after=%d)", name(cat), secondsToNextUTCDay(now)))
	}
	if exceeds(win.Weekly, weekly) {
		return true, reason(codeRateLimited, "blocked: weekly "+name(cat)+" limit reached")
	}
	if exceeds(win.Monthly, monthly) {
		return true, reason(codeRateLimited, "blocked: monthly "+name(cat)+" limit reached")
	}

	bucket := uc.days[today]
	if bucket == nil {
		bucket = &[catChannel + 1]int{}
		uc.days[today] = bucket
	}
	bucket[cat]++
	return false, ""
}

func (l *Limiter) admitDM(now time.Time, limits policy.Limits) (bool, string) {
	if limits.DMGlobalPerMin <= 0 {
		return false, "" // no global DM cap configured
	}
	cutoff := now.Add(-time.Minute).Unix()
	l.mu.Lock()
	defer l.mu.Unlock()
	// drop timestamps older than a minute
	kept := l.dm[:0]
	for _, ts := range l.dm {
		if ts >= cutoff {
			kept = append(kept, ts)
		}
	}
	l.dm = kept
	if len(l.dm) >= limits.DMGlobalPerMin {
		return true, reason(codeRateLimitedDM, "blocked: community DM rate limit reached, try again shortly (retry_after=60)")
	}
	l.dm = append(l.dm, now.Unix())
	return false, ""
}

// admitMailbox enforces the per-connection then global mailbox-request caps. It checks both
// windows WITHOUT recording a hit first, and only records once BOTH pass — so a request rejected by
// one cap doesn't inflate the other. A nil connection key (internal call / test) skips the
// per-connection cap. 0 for either cap disables it.
func (l *Limiter) admitMailbox(ctx context.Context, now time.Time, limits policy.Limits) (bool, string) {
	perConn := limits.MailboxPerConnPerMin
	global := limits.MailboxPerMin
	if perConn <= 0 && global <= 0 {
		return false, "" // mailbox throttling disabled
	}

	var key any
	if perConn > 0 {
		key = l.connKey(ctx)
	}

	nowSec := now.Unix()
	cutoff := now.Add(-time.Minute).Unix()

	l.mu.Lock()
	defer l.mu.Unlock()

	// Periodic idle-connection sweep, driven by a call counter so it runs on EVERY request — even one
	// rejected by the global cap below (a saturating flood would otherwise never reach the record path
	// where the map is pruned).
	l.mailboxCalls++
	if l.mailboxCalls%connSweepInterval == 0 {
		l.sweepConns(nowSec)
	}

	// Per-connection window (the primary lever). Keyed on the connection object; a nil key means we
	// couldn't identify the connection, so only the global cap applies. We only LOOK UP an existing
	// entry here to test its cap — we do NOT create one for a brand-new connection — so a fresh
	// connection that the GLOBAL cap below is about to reject never allocates a map entry that would
	// then linger until the idle sweep. The entry is created lazily only once the request is admitted.
	var cw *connWindow
	if perConn > 0 && key != nil {
		if cw = l.mailboxConn[key]; cw != nil {
			cw.lastSeen = nowSec // stamp so an active connection is never swept mid-use
			cw.hits = pruneTimestamps(cw.hits, cutoff)
			if len(cw.hits) >= perConn {
				return true, reason(codeRateLimitedMailbox, "blocked: mailbox request rate limit reached on this connection, try again shortly (retry_after=60)")
			}
		}
	}

	// Global window (community-wide backstop).
	if global > 0 {
		l.mailbox = pruneTimestamps(l.mailbox, cutoff)
		if len(l.mailbox) >= global {
			return true, reason(codeRateLimitedMailbox, "blocked: community mailbox rate limit reached, try again shortly (retry_after=60)")
		}
	}

	// Admitted — record the hit, creating the per-connection entry lazily now that we know the request
	// passed BOTH caps (so a globally-rejected fresh connection leaves nothing behind to sweep).
	if perConn > 0 && key != nil {
		if cw == nil {
			cw = &connWindow{}
			l.mailboxConn[key] = cw
		}
		cw.lastSeen = nowSec
		cw.hits = append(cw.hits, nowSec)
	}
	if global > 0 {
		l.mailbox = append(l.mailbox, nowSec)
	}
	return false, ""
}

// admitMailboxResponse bounds the organizer's credential-exchange RESPONSE kinds (9023/9025/9027). A
// per-connection cap would throttle the single legitimate organizer connection under enrollment
// load, so a non-organizer response gets the GLOBAL window ONLY — bounded by the same MailboxPerMin
// cap as requests but on a SEPARATE sliding window so neither can starve the other. This stops an
// unauthenticated flood from storing unbounded 64KiB blobs (the disk-exhaustion vector) and from
// injecting forged organizer responses faster than the cap. A global cap of 0 disables mailbox
// throttling (mirrors admitMailbox). (hardening: mailbox-response DoS)
//
// A response signed by a TRUSTED organizer pubkey bypasses this cap entirely and is never counted
// against the shared window: it is the community's own issuer replying to members, and capping it
// burns tokens the member already paid for (the 2026-07-21 mailbox-response incident — the organizer's
// replies got silently rate-limited by its own relay all night). This is safe because
// RequireValidSignature (relay.go) verifies event.PubKey's signature before ANY RejectEvent hook,
// including this one, runs — a forger cannot produce a valid signature under the organizer's pubkey
// without its secret key.
func (l *Limiter) admitMailboxResponse(pubkey string, now time.Time, limits policy.Limits) (bool, string) {
	if l.src.IsOrganizer(pubkey) {
		return false, ""
	}
	global := limits.MailboxPerMin
	if global <= 0 {
		return false, "" // mailbox throttling disabled
	}
	nowSec := now.Unix()
	cutoff := now.Add(-time.Minute).Unix()

	l.mu.Lock()
	defer l.mu.Unlock()

	l.mailboxResp = pruneTimestamps(l.mailboxResp, cutoff)
	if len(l.mailboxResp) >= global {
		return true, reason(codeRateLimitedMailbox, "blocked: community mailbox rate limit reached, try again shortly (retry_after=60)")
	}
	l.mailboxResp = append(l.mailboxResp, nowSec)
	return false, ""
}

// pruneTimestamps returns ts with all entries older than cutoff removed, reusing the backing array.
func pruneTimestamps(ts []int64, cutoff int64) []int64 {
	kept := ts[:0]
	for _, t := range ts {
		if t >= cutoff {
			kept = append(kept, t)
		}
	}
	return kept
}

// sweepConns evicts per-connection counters idle longer than connIdleEvict (closed or quiet
// connections), keeping the map bounded. Runs only once the map is large enough to matter, so the
// O(n) sweep can't dominate under a many-connection flood. Caller holds l.mu.
func (l *Limiter) sweepConns(nowSec int64) {
	if len(l.mailboxConn) < connSweepThreshold {
		return
	}
	evictBefore := nowSec - int64(connIdleEvict/time.Second)
	for key, cw := range l.mailboxConn {
		if cw.lastSeen < evictBefore {
			delete(l.mailboxConn, key)
		}
	}
}

// exceeds reports whether admitting one more (count+1) would break a cap. limit 0 = unlimited.
func exceeds(limit, count int) bool { return limit > 0 && count+1 > limit }

// sums returns the daily, weekly (7d), and monthly (30d) counts for a category.
func (uc *userCounters) sums(cat category, today int64) (daily, weekly, monthly int) {
	for day, bucket := range uc.days {
		age := today - day
		if age < 0 {
			continue
		}
		c := bucket[cat]
		if age == 0 {
			daily += c
		}
		if age < 7 {
			weekly += c
		}
		if age < 30 {
			monthly += c
		}
	}
	return
}

func (uc *userCounters) prune(today int64) {
	for day := range uc.days {
		if today-day >= retainDays {
			delete(uc.days, day)
		}
	}
}

func windowFor(cat category, l policy.Limits) policy.Window {
	switch cat {
	case catPost:
		return l.Posts
	case catComment:
		return l.Comments
	case catChannel:
		return l.Channel
	default:
		return policy.Window{}
	}
}

func name(cat category) string {
	switch cat {
	case catPost:
		return "post"
	case catComment:
		return "comment"
	case catChannel:
		return "channel"
	default:
		return "event"
	}
}

// categorize maps an event to a rate-limit category, mirroring the client's comment detection
// (a kind-1 note carrying the 'stiq-comment' marker is a comment, not a feed post).
func categorize(event *nostr.Event) category {
	switch event.Kind {
	case 1:
		if hasTag(event, "t", stiqCommentMarker) {
			return catComment
		}
		return catPost
	case 1111:
		return catComment
	case 42, 1311:
		return catChannel
	// 1984 (reports + every moderator stiq-action). A MEMBER report used to be completely
	// unrate-limited: policy.checkModAction returns early for a non-moderator, and this switch had
	// no 1984 case, so it fell to catNone = unlimited. Only the per-event size/tag weight gate stood
	// between one bound member and unbounded storage growth (audit 2026-07-29, §2.3 / risk 2).
	//
	// Deliberately the CHANNEL/management window rather than a new one — the same call already made
	// for NIP-29 management and 31923 above, for the same reason. At the 50/day default it is far
	// above anything a real member does (who reports fifty posts a day?) while bounding a flood, and
	// MODERATORS are exempt by default (limits.ExemptModerators, checked in RejectEvent before the
	// per-user windows), so bulk moderation is untouched. Their own separate stiq:mod-limits caps
	// still apply. Note this bounds STORAGE only: the report THRESHOLD counts distinct reporters, so
	// a single-npub flood could never move a moderation verdict either way.
	case 1984:
		return catChannel
	// NIP-29 group management + creation (9000-9009, 9021/9022): each accepted event rewrites the
	// whole groups.json (marshal + fsync) and re-signs group state, yet none were rate-limited (they
	// returned catNone). Cap them with the per-user channel window so a single bound member can't
	// spam edit-metadata / join-leave / group-create to starve disk I/O or grow state unbounded.
	// These are signed by bound npubs, so per-user attribution applies. (finding #40)
	case 9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009, 9021, 9022:
		return catChannel
	// 31923 (event doc): bound-npub, host-signed, and republished on every edit / cancel / approval
	// (the host-authoritative going count lives in its tags), so a busy event legitimately rewrites
	// it dozens of times a day. The channel/management window (50/day default) fits that cadence;
	// the posts window (20/day) would choke approvals. Registered explicitly because an
	// uncategorized kind is silently unlimited (finding #40's lesson).
	case 31923:
		return catChannel
	// 31925 (event interested RSVP) is deliberately catNone, mirroring kind 7 reactions: on a blind
	// community it rides the token path (priced per publish, limiter-exempt like every blind post);
	// on a non-blind community it is addressable per (pubkey, d), so repeat toggles replace rather
	// than accumulate. Listed here so the omission reads as a decision, not a gap.
	case 31925:
		return catNone
	case 1059:
		return catDM
	case kindEnrollRequest, kindDrawRequest, kindUnlockRequest:
		return catMailbox
	case kindEnrollResponse, kindDrawResponse, kindUnlockResponse:
		return catMailboxResponse
	default:
		return catNone
	}
}

// isBlindPost reports whether the event carries a per-post anti-spam token (the stiq_token tag),
// i.e. it was admitted by the membership token gate rather than as a bound-npub post.
func isBlindPost(event *nostr.Event) bool {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "stiq_token" {
			return true
		}
	}
	return false
}

// isAttributedSpaceContent reports whether a token-bearing event is ATTRIBUTED space content — a
// channel/group message, DM gift wrap, or h-tagged group reaction, all signed by a real npub
// (tokens-everywhere). Unlike an anonymous blind post (throwaway signer), these stay subject to the
// per-npub / global rate windows even while carrying a space-write token, so the rate-limit
// exemption for blind posts must NOT cover them. MUST match policy.spaceContentKinds + the
// h-tagged-kind-7 rule (the relay's membership gate routes exactly these to the space-token chain).
func isAttributedSpaceContent(event *nostr.Event) bool {
	switch event.Kind {
	case 42, 1311, 9, 11, 12, 1059:
		return true
	case 7:
		// An h-tagged kind-7 is a group reaction (attributed); an untagged kind-7 is a blind feed vote.
		for _, tag := range event.Tags {
			if len(tag) >= 1 && tag[0] == "h" {
				return true
			}
		}
		return false
	default:
		return false
	}
}

func hasTag(event *nostr.Event, name, value string) bool {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == name && tag[1] == value {
			return true
		}
	}
	return false
}
