package policy

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// KindAppData is the NIP-78 application-specific data event (addressable/replaceable by `d`
// tag). The organizer publishes the moderation root of trust here, signed by the organizer
// key (PLAN.md §3.4):
//
//	d="stiq:moderators"  → current moderator roster (`p` tags)
//	d="stiq:limits"      → rate-limit policy (JSON content), enforced by ratelimit.
//	d="stiq:tag-policy"  → community tag policy (JSON content); when it disallows member tags,
//	                       the relay rejects posts carrying `t` tags outside the community set.
const KindAppData = 30078

const (
	dModerators = "stiq:moderators"
	dLimits     = "stiq:limits"
	dTagPolicy  = "stiq:tag-policy"
	// dPostRules carries per-post-type length rules (note/article). The relay hard-rejects
	// over-max-length posts; min-length + label-required are client-side only.
	dPostRules = "stiq:post-rules"
	// dGov carries community governance: the channel-create rule + newcomer restrictions.
	dGov = "stiq:gov"
	// dModLimits carries per-action daily/weekly caps on a moderator's kind-1984 actions.
	dModLimits = "stiq:mod-limits"
	// dPermissions carries per-moderator action scopes (separation of powers). The relay hard-enforces
	// that a rostered moderator may only take an action its granted scope set includes.
	dPermissions = "stiq:permissions"
	// stiqConfigPrefix scopes the organizer-only `d` tags. Any kind-30078 event whose `d`
	// starts with this is reserved to the organizer key; bound members may still publish
	// their own app data under other `d` tags.
	stiqConfigPrefix = "stiq:"
)

// Post kinds whose `t` (flair) tags are subject to the organizer's tag policy: kind-1 notes
// and kind-30023 long-form articles (both created from the composer).
const (
	kindNote     = 1
	kindLongform = 30023
	// kindComment is a NIP-22 comment (1111). An author-note pinned comment carries the pinMarkerTag
	// and is subject to the organizer's author-note max-length rule.
	kindComment = 1111
)

// The other member-authored body kinds. Every surface writes RICH bodies now (the feed's full editor
// is the editor everywhere), so these carry real prose and are subject to the organizer's universal
// length policy — see checkPostRules. Previously they had no length rule at all.
//
// NOT listed, and unenforceable by design: NIP-17 DMs. They arrive gift-wrapped (KindGiftWrap), so
// the relay never sees a body to measure — the client-side cap is the only one there.
const (
	kindLiveChat    = 1311 // NIP-53 channel broadcast
	kindGroupChat   = 9    // NIP-29 group message
	kindGroupThread = 11   // NIP-29 group thread root
	kindGroupReply  = 12   // NIP-29 group thread reply
)

// pinMarkerTag flags a kind-1111 comment as the post author's pinned author-note (see client
// feed/pinned.ts). Only these comments are length-checked against the author-note rule.
const pinMarkerTag = "stiq-pin"

// stiqCommentMarker is the `t` tag that marks a kind-1 event as a COMMENT rather than a feed note.
//
// NIP-22 reserves kind-1111 for comments on non-kind-1 roots, so a comment on a plain note cannot be
// a 1111 and is published as a hybrid kind-1 carrying this marker (client feed/comments.ts
// buildNoteComment). Sharing the kind is what made it collect the note's own character cap, and a
// 280-character cap hard-rejects any comment with a table or a collapsible block. Mirrors the
// client's STIQ_COMMENT_MARKER.
const stiqCommentMarker = "stiq-comment"

// isStiqComment reports whether a kind-1 event is really a comment (see stiqCommentMarker).
func isStiqComment(event *nostr.Event) bool {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "t" && tag[1] == stiqCommentMarker {
			return true
		}
	}
	return false
}

// kindModAction is a NIP-56 report (1984); a moderator's report is a moderation action whose
// rate the organizer can cap. kindCreateGroup is the NIP-29 group/channel-create event (9007).
// kindChannelCreate (NIP-28, 40) and kindLiveActivity (NIP-53, 30311) are the OTHER channel-creation
// paths the app supports; all three are gated by the same gov channel-create rule (finding #72).
const (
	kindModAction     = 1984
	kindCreateGroup   = 9007
	kindChannelCreate = 40
	kindLiveActivity  = 30311
)

// secondsPerDay is used to bucket the moderator-action windowed counters by day index.
const secondsPerDay = 86400

// linkRe matches an http(s) URL anywhere in a post body — the newcomer no-links gate.
var linkRe = regexp.MustCompile(`https?://`)

// MemberInfo lets the holder read a member's bind age for newcomer enforcement. membership.Store
// satisfies it. When nil (newcomer rules unconfigured / not wired), newcomer checks are skipped.
type MemberInfo interface {
	BoundAt(pubkey string) (int64, bool)
}

// Voice-message kinds (NIP-A0). Off by default; admitted only when the organizer's limits
// policy sets allow_voice=true. The organizer controls whether the community has voice at all.
const (
	kindVoiceMessage = 1222
	kindVoiceComment = 1244
)

// Stable reject codes for the organizer content/permission path (organizer.go). Codes are
// lowercase snake_case and MUST stay stable across releases (bump RejectCodesVersion in
// membership.go on any change). reason() and codeTooManyTags live in membership.go/weight.go and
// are reused directly here. Added in RejectCodesVersion 3.
const (
	codeConfigReserved             = "config_reserved"
	codeVoiceDisabled              = "voice_disabled"
	codeTagScope                   = "tag_scope"
	codeTagNotPermitted            = "tag_not_permitted"
	codeAuthorNoteTooLong          = "author_note_too_long"
	codeContentTooLong             = "content_too_long"
	codeTooMuchMedia               = "too_much_media"
	codeArticleTooLong             = "article_too_long"
	codeArticleTooMuchMedia        = "article_too_much_media"
	// codeBodyTooLong is the UNIVERSAL length rejection: it carries the article word cap applied to
	// a body that is not itself a long-form article (a channel broadcast, a group message, a
	// comment). Distinct from codeArticleTooLong purely so the client can word it correctly —
	// "This message is too long" rather than "This article is too long". Added in
	// RejectCodesVersion 5. An older client simply doesn't know the code and falls back to the raw
	// human sentence, which already says the right thing.
	codeBodyTooLong                = "body_too_long"
	codeNewcomerLinks              = "newcomer_links"
	codeChannelCreateOrganizerOnly = "channel_organizer_only"
	codeChannelCreateModsOnly      = "channel_mods_only"
	codeNewcomerChannels           = "newcomer_channels"
	codeModeratorDenied            = "moderator_denied"
	codeModRateLimited             = "mod_rate_limited"
)

// Window is a per-window cap. 0 = unlimited.
type Window struct {
	Daily   int
	Weekly  int
	Monthly int
}

// Limits is the rate-limit policy, mirrored from the organizer's stiq:limits event.
type Limits struct {
	Posts            Window
	Comments         Window
	Channel          Window
	DMGlobalPerMin   int
	ExemptModerators bool
	// AllowVoice gates NIP-A0 voice messages community-wide. Default false — voice is off until
	// the organizer enables it.
	AllowVoice bool
	// MailboxPerMin caps how many credential-exchange mailbox REQUESTS (kind 9020 enroll + 9024
	// draw) the relay admits community-wide per minute. These are ephemeral-signed and can't be
	// attributed to a member (exactly like DMs), so — like DMGlobalPerMin — the only workable
	// throttle is a global one. It exists to protect the single-threaded organizer mailbox
	// downstream from a flood of forwarded requests. 0 = unlimited.
	MailboxPerMin int
	// MailboxPerConnPerMin caps mailbox requests per WebSocket connection per minute. Over Tor
	// every connection shares 127.0.0.1, so the relay keys this on the connection itself, not the
	// IP. This is the primary lever: a legitimate client sends ~1 request per connection, so a
	// tight per-connection cap throttles a single flooding circuit hard while barely touching real
	// members (who each ride their own circuit). 0 = unlimited.
	MailboxPerConnPerMin int
}

// DefaultLimits is the fallback rate-limit policy for a relay whose organizer has not yet published
// a stiq:limits event. Without it a fresh/unconfigured relay is the Go zero value Limits{} = every
// window unlimited, so the bound-npub path is wide open until the organizer clicks Save. These
// numbers mirror the organizer dashboard's DEFAULT_LIMITS (issuer/organizer-server.mjs) so relay
// and organizer agree. They bound the BOUND-NPUB path (config/channel/legacy content) and the
// global DM cap; BLIND posts skip the limiter entirely (ratelimit.isBlindPost) and are bounded by
// TOKENS_PER_EPOCH instead. A published stiq:limits fully REPLACES this (an explicit 0 there still
// means unlimited for that category), so the organizer can still raise or remove any cap.
var DefaultLimits = Limits{
	Posts:            Window{Daily: 20, Weekly: 100, Monthly: 300},
	Comments:         Window{Daily: 100, Weekly: 500, Monthly: 1500},
	Channel:          Window{Daily: 50, Weekly: 250, Monthly: 750},
	DMGlobalPerMin:   60,
	ExemptModerators: true,
	// Mailbox flood caps default ON (a fresh/unconfigured relay is protected from the start). A
	// global 240/min sits far above any real community's refill traffic — draws are staggered and
	// idempotent — while a per-connection 12/min is generous for a client that normally sends one
	// request per socket, yet forces a single-circuit flooder to keep opening fresh Tor circuits.
	MailboxPerMin:        240,
	MailboxPerConnPerMin: 12,
}

// ConfigHolder holds the organizer-published moderation config (roster + limits). It is the
// relay's trust root: kind-30078 events with a `stiq:` `d` tag are accepted only from the
// configured organizer key(s), and applied here so the rate limiter can read the latest
// policy. Safe for concurrent use.
type ConfigHolder struct {
	mu sync.RWMutex
	// applyMu serializes the whole compare-record-apply sequence in applyIfNewer so that the ORDER in
	// which two concurrent distinct-newer configs for the same `d` are recorded in `applied` matches the
	// order their apply() lands on live policy. Without it, `mu` is dropped between recording the version
	// and running apply(), so E1→E2 could be recorded while E2→E1 applies, leaving live policy stale
	// relative to `applied`. It is a coarser lock than `mu` and is NEVER taken by apply()/its callees
	// (which re-take `mu`), so the ordering is always applyMu→mu and cannot deadlock. (finding S7)
	applyMu    sync.Mutex
	organizers map[string]struct{}
	moderators map[string]struct{}
	limits     Limits
	// Tag policy (from the organizer's stiq:tag-policy event). tagAllowMember defaults to true
	// (permissive) until an organizer event sets it false, so posts are never blocked by an
	// unconfigured relay.
	tagCommunity   map[string]struct{}
	tagAllowMember bool
	// tagMax caps the number of `t` tags on a post. 0 = unlimited.
	tagMax int
	// tagScopes maps a `t` tag to the post type it may appear on ("note" or "article"), from the
	// tag-policy `tsc` field. A tag absent here is allowed on any type (backward compatible).
	tagScopes map[string]string
	// postRules holds per-post-type length rules (from stiq:post-rules). Only max length is
	// hard-enforced here; nil ⇒ unconfigured (no length enforcement).
	postRules *postRules
	// gov holds governance rules (from stiq:gov): the channel-create rule + newcomer window.
	gov govRules
	// modLimits holds per-action caps on a moderator's kind-1984 actions (from stiq:mod-limits).
	modLimits map[string]Window
	// permissions (from stiq:permissions): per-moderator action scopes. permsSet is false until a
	// permissions doc is applied; while false every rostered moderator holds every scope (backward-
	// compatible with the flat roster / client ALL_MOD_SCOPES fallback). permDefault is the scope set
	// for a moderator not listed in permMods; permMods holds per-hexpubkey overrides. Guarded by mu.
	permsSet    bool
	permDefault map[string]struct{}
	permMods    map[string]map[string]struct{}
	// member reads bind age for newcomer enforcement; nil disables newcomer checks.
	member MemberInfo
	// modActions tracks each moderator's per-day action counts for mod-limit enforcement.
	modActions map[string]*modActionCounter
	// applied records the CreatedAt + id of the last config APPLIED to live policy for each `stiq:`
	// `d` tag, so a replayed older (or equal-but-superseded) organizer config event is ignored rather
	// than reverting the live policy root. Mirrors the replaceable-event ordering the store uses
	// (greater CreatedAt wins; ties broken by lower id). Guarded by mu. (finding #17)
	applied map[string]appliedVersion
	now     func() time.Time
}

// appliedVersion is the ordering key of the last-applied config for a `d` tag.
type appliedVersion struct {
	createdAt nostr.Timestamp
	id        string
}

// postRules is the parsed per-post-type length policy. mx == 0 ⇒ unlimited.
type postRules struct {
	noteMax         int // kind-1: max characters (of PROSE — inline media is stripped first)
	articleMax      int // kind-30023: max words (of PROSE)
	noteMediaMax    int // kind-1: max inline media (pictures + voice). 0 ⇒ unlimited
	articleMediaMax int // kind-30023: max inline media. 0 ⇒ unlimited
	authorNoteMax   int // kind-1111 pinned author-note: max characters (runes); 0 ⇒ unlimited
}

// Inline media token grammars — MUST match the client's INLINE_PIC_RE / INLINE_VOICE_RE
// (client/src/feed/picture.ts, voice.ts) byte-for-byte so the relay measures a post's prose length
// and media count exactly as the composer does. A picture/voice clip rides in the body as a
// self-delimited base64 token; it is EXEMPT from the length limit and counted only against the
// per-type media cap.
var (
	inlinePicRe   = regexp.MustCompile(`\[\[pic:(\d+);(\d+)(?:;l=[^;\]]*)?;[A-Za-z0-9+/=]+\]\]`)
	inlineVoiceRe = regexp.MustCompile(`\[\[voice:audio/[a-z0-9.+-]+;(\d+)(?:;wf=[\d.,]+)?;[A-Za-z0-9+/=]+\]\]`)
)

// stripInlineMedia removes every inline picture/voice token so the remainder can be measured as
// prose — the base64 payload must never count toward a note's character / an article's word limit.
//
// STRIP ORDER MUST MATCH THE CLIENT: voice first, THEN pictures — the exact order of the client's
// bodyForMeasure (client/src/feed/inlineMedia.ts). A media token can be nested inside the OTHER
// type's frame (the outer frame is invalid — its base64 field starts with '[' — until the inner
// token is stripped), so the strip order changes the residue for such a body. Running the identical
// two-pass order on both sides guarantees the relay measures a post's prose length byte-for-byte as
// the composer does, so a note/article the composer accepts is never rejected here on length. (A
// differential test pins this; see organizer_test.go TestInlineMediaStripMatchesClient.)
func stripInlineMedia(content string) string {
	return inlinePicRe.ReplaceAllString(inlineVoiceRe.ReplaceAllString(content, ""), "")
}

// countInlineMedia counts the inline media tokens (pictures + voice) in a body — the value checked
// against a post type's media cap. Mirrors the client's countInlineMedia.
func countInlineMedia(content string) int {
	return len(inlinePicRe.FindAllStringIndex(content, -1)) +
		len(inlineVoiceRe.FindAllStringIndex(content, -1))
}

// Embed/reference token grammars — MUST match the client's feed/embedTokens.ts. An embed is a
// machine payload (a base64url card snapshot, or a bech32 id) that every renderer replaces with a
// CARD, so the reader never sees it as text; like inline media it is EXEMPT from the length limit.
// Without this a note carrying one event card (~2 KB of base64) always exceeds a 280-character
// noteMax and is hard-rejected, even though the composer — which stops counting it — accepted it.
var (
	stiqEmbedRe = regexp.MustCompile(`stiq:(?:event|space|msg|draft):[A-Za-z0-9_-]+`)
	nostrRefRe  = regexp.MustCompile(`(?i)nostr:(?:nevent1|note1|naddr1)[a-z0-9]+`)
)

// stripEmbedTokens removes every embed/reference token. The two passes are independent (a `stiq:`
// payload is base64url so it cannot contain a bech32 ref, and vice versa), so their order does not
// change the residue; the order against inline media does, and is fixed in bodyForMeasure.
func stripEmbedTokens(content string) string {
	return nostrRefRe.ReplaceAllString(stiqEmbedRe.ReplaceAllString(content, ""), "")
}

// bodyForMeasure reduces a body to the prose a reader actually sees — inline media FIRST, then
// embed/reference tokens — which is what the community's length rule applies to. Named for, and
// byte-for-byte identical to, the client's bodyForMeasure (client/src/feed/inlineMedia.ts).
//
// STRIP ORDER IS LOAD-BEARING both times: a media token can be nested inside the other type's frame,
// and an embed token nested inside a media frame invalidates that frame (its base64 field would
// contain a ':'), so media-then-embeds and embeds-then-media leave DIFFERENT residues for an
// adversarial body. Running the client's exact order here is what guarantees a post the composer
// accepted is never rejected on length. (TestInlineMediaStripMatchesClient pins both orders.)
func bodyForMeasure(content string) string {
	return stripEmbedTokens(stripInlineMedia(content))
}

// govRules is the parsed governance policy. channelCreate ∈ {"", "any", "mods", "org"}.
type govRules struct {
	newcomerDays       int // bind age (days) below which a member is a "newcomer"; 0 ⇒ disabled
	newcomerNoLinks    bool
	newcomerNoChannels bool
	channelCreate      string
}

// modActionCounter holds a moderator's per-day, per-action counts (day index → action → count).
type modActionCounter struct {
	days map[int64]map[string]int
}

// NewConfigHolder builds a holder trusting the given organizer hex pubkeys.
func NewConfigHolder(organizerPubkeys []string) *ConfigHolder {
	h := &ConfigHolder{
		organizers:     make(map[string]struct{}, len(organizerPubkeys)),
		moderators:     make(map[string]struct{}),
		limits:         DefaultLimits, // bounded, not unlimited, until the organizer publishes stiq:limits
		tagCommunity:   make(map[string]struct{}),
		tagAllowMember: true,
		modActions:     make(map[string]*modActionCounter),
		applied:        make(map[string]appliedVersion),
		now:            time.Now,
	}
	for _, pk := range organizerPubkeys {
		if pk != "" {
			h.organizers[pk] = struct{}{}
		}
	}
	return h
}

// SetMemberInfo wires the membership store so newcomer rules can read a member's bind age.
// Safe to leave unset (newcomer enforcement is then skipped).
func (h *ConfigHolder) SetMemberInfo(m MemberInfo) {
	h.mu.Lock()
	h.member = m
	h.mu.Unlock()
}

// Organizers returns the configured organizer hex pubkeys (for membership exemption).
func (h *ConfigHolder) Organizers() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]string, 0, len(h.organizers))
	for pk := range h.organizers {
		out = append(out, pk)
	}
	return out
}

// IsOrganizer reports whether pubkey is a configured organizer.
func (h *ConfigHolder) IsOrganizer(pubkey string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.organizers[pubkey]
	return ok
}

// UpdateOrganizers atomically replaces the set of trusted organizer pubkeys.
// Called on SIGHUP to apply a hot-reloaded config without restarting the relay.
func (h *ConfigHolder) UpdateOrganizers(pubkeys []string) {
	next := make(map[string]struct{}, len(pubkeys))
	for _, pk := range pubkeys {
		if pk != "" {
			next[pk] = struct{}{}
		}
	}
	h.mu.Lock()
	h.organizers = next
	h.mu.Unlock()
}

// IsModerator reports whether pubkey is in the current organizer-published roster.
func (h *ConfigHolder) IsModerator(pubkey string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.moderators[pubkey]
	return ok
}

// Limits returns a copy of the current rate-limit policy.
func (h *ConfigHolder) Limits() Limits {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.limits
}

// RejectEvent is a khatru RejectEvent hook. It (1) reserves `stiq:`-prefixed kind-30078 `d`
// tags to the organizer key (rejecting impostors) and applies accepted organizer config so the
// rate limiter sees the latest roster + limits, and (2) enforces the organizer's tag policy on
// posts when member-authored tags are disallowed.
func (h *ConfigHolder) RejectEvent(_ context.Context, event *nostr.Event) (reject bool, msg string) {
	if event.Kind == KindAppData {
		d := dTag(event)
		if !strings.HasPrefix(d, stiqConfigPrefix) {
			return false, "" // some other app's data under a non-reserved d tag
		}
		if !h.IsOrganizer(event.PubKey) {
			return true, reason(codeConfigReserved, "blocked: stiq config is reserved to the organizer key")
		}
		// Apply to live policy ONLY if this event is strictly newer than the last applied config for
		// this `d` tag. A replayed older organizer-signed event (captured from relay traffic — no
		// private key needed) must not revert rate limits / roster / gov to a stale version. The event
		// is still admitted for storage (ReplaceEvent keeps the newest); we only refuse the live
		// mutation. (finding #17)
		h.applyIfNewer(event, d)
		return false, ""
	}
	if event.Kind == kindNote || event.Kind == kindLongform {
		if reject, msg := h.checkTags(event); reject {
			return true, msg
		}
		if reject, msg := h.checkPostRules(event); reject {
			return true, msg
		}
		if reject, msg := h.checkNewcomerLinks(event); reject {
			return true, msg
		}
		return false, ""
	}
	// A kind-1111 comment carrying the pin marker is the post author's author-note; enforce its own
	// max length FIRST (it is the tighter, more specific rule), then the universal body cap that now
	// covers ordinary comments too.
	if event.Kind == kindComment {
		if reject, msg := h.checkAuthorNote(event); reject {
			return true, msg
		}
		return h.checkPostRules(event)
	}
	// The remaining member-authored bodies — channel broadcasts and group messages. They carry rich
	// prose now, so they answer to the same universal length cap as everything else (see
	// checkPostRules). No tag policy or newcomer-link rule here: those are feed-post concerns.
	if event.Kind == kindLiveChat || event.Kind == kindGroupChat || event.Kind == kindGroupThread || event.Kind == kindGroupReply {
		return h.checkPostRules(event)
	}
	// Every channel-creation path the app supports is subject to the gov channel-create rule: NIP-29
	// group create (9007), NIP-28 channel create (40), and NIP-53 live-activity create (30311). Gating
	// only 9007 let a member bypass "only org/mods may create channels" via kind 40 / 30311. (#72)
	if event.Kind == kindCreateGroup || event.Kind == kindChannelCreate || event.Kind == kindLiveActivity {
		return h.checkChannelCreate(event)
	}
	if event.Kind == kindModAction {
		return h.checkModAction(event)
	}
	if event.Kind == kindVoiceMessage || event.Kind == kindVoiceComment {
		if h.IsOrganizer(event.PubKey) {
			return false, ""
		}
		h.mu.RLock()
		allow := h.limits.AllowVoice
		h.mu.RUnlock()
		if !allow {
			return true, reason(codeVoiceDisabled, "blocked: voice messages are disabled in this community")
		}
	}
	return false, ""
}

// checkTags enforces the organizer's tag policy: when member tags are disallowed, a post may
// carry only `t` (flair) tags drawn from the community tag set. Organizers themselves are
// exempt (they curate the set). No-op while member tags are allowed (the default).
func (h *ConfigHolder) checkTags(event *nostr.Event) (reject bool, msg string) {
	h.mu.RLock()
	allowMember := h.tagAllowMember
	community := h.tagCommunity
	maxTags := h.tagMax
	tagScopes := h.tagScopes
	h.mu.RUnlock()
	// Organizers curate the policy and are exempt from it.
	if h.IsOrganizer(event.PubKey) {
		return false, ""
	}
	// Cap the number of `t` (flair) tags, regardless of whether member tags are allowed.
	if maxTags > 0 {
		count := 0
		for _, tag := range event.Tags {
			if len(tag) >= 2 && tag[0] == "t" {
				count++
			}
		}
		if count > maxTags {
			return true, reason(codeTooManyTags, fmt.Sprintf("blocked: too many tags (%d); this community allows at most %d", count, maxTags))
		}
	}
	// Per-tag post-type scope (tsc): a tag mapped to a scope may appear only on the matching post
	// type — "note" on kind-1, "article" on kind-30023. A tag with no mapping is allowed on any type,
	// so an absent/empty tsc is fully backward-compatible. Enforced independently of member-tag policy.
	if len(tagScopes) > 0 {
		postType := "note"
		if event.Kind == kindLongform {
			postType = "article"
		}
		for _, tag := range event.Tags {
			if len(tag) >= 2 && tag[0] == "t" {
				if sc, ok := tagScopes[tag[1]]; ok && sc != "" && sc != postType {
					return true, reason(codeTagScope, fmt.Sprintf("blocked: tag %q is only allowed on %s posts", tag[1], sc))
				}
			}
		}
	}
	if allowMember {
		return false, ""
	}
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "t" {
			if _, ok := community[tag[1]]; !ok {
				return true, reason(codeTagNotPermitted, fmt.Sprintf("blocked: tag %q is not permitted in this community", tag[1]))
			}
		}
	}
	return false, ""
}

// checkAuthorNote enforces the organizer's author-note max length on a kind-1111 pinned author-note
// (a comment carrying the pin marker). Measured in runes, matching the client composer. Organizers
// are exempt; an unconfigured rule (nil postRules or anmx == 0) is unenforced. Ordinary comments
// (no pin marker) are never length-checked here.
func (h *ConfigHolder) checkAuthorNote(event *nostr.Event) (reject bool, msg string) {
	if h.IsOrganizer(event.PubKey) {
		return false, ""
	}
	if _, ok := tagValue(event, pinMarkerTag); !ok {
		return false, ""
	}
	h.mu.RLock()
	rules := h.postRules
	h.mu.RUnlock()
	if rules == nil || rules.authorNoteMax <= 0 {
		return false, ""
	}
	if n := len([]rune(event.Content)); n > rules.authorNoteMax {
		return true, reason(codeAuthorNoteTooLong, fmt.Sprintf("blocked: author note is %d characters; this community allows at most %d", n, rules.authorNoteMax))
	}
	return false, ""
}

// checkPostRules hard-rejects an over-max-length body. mx == 0 ⇒ unlimited. Organizers are exempt;
// min length and label-required are enforced client-side only.
//
// There are two rules here, and which one applies is NOT simply "one per kind":
//
//   - The NOTE rule (characters + media) is the feed note's own cap, and applies to a real feed note
//     ONLY. In particular it does NOT apply to a hybrid kind-1 COMMENT (see stiqCommentMarker): a
//     comment merely borrows the kind because NIP-22 forbids 1111 on a kind-1 root. Leaving it under
//     the note rule meant a 280-character cap hard-rejected any comment carrying a table or a
//     collapsible block — which every surface can now write, since the feed's full editor is the
//     editor everywhere.
//
//   - The ARTICLE rule (words + media) is UNIVERSAL. It applies to the long-form article and to every
//     other body the relay can read: channel broadcasts, group chat/threads/replies, and comments in
//     both wire shapes. Those surfaces previously had NO length policy at all, so the organizer's
//     single "how big may a long body be" number is now the one ceiling for all of them.
//
// Measured on PROSE only: inline media (pictures + voice) and embed cards (event/space/private-post/
// draft + nostr refs) are EXEMPT, matching the client's bodyForMeasure. Without that a single
// picture, voice note, or embedded card (base64 is thousands of runes) would always exceed the cap
// and be rejected, even though the composer accepts it.
//
// A caveat worth stating rather than discovering: when content_encryption is on, a note/article body
// arrives SEALED, so `prose` measures ciphertext rather than words. The length rule degrades to a
// rough byte proxy there; the real ceiling on a sealed body is its weight-priced token cost (see
// weight.go). This function is not the place to fix that.
func (h *ConfigHolder) checkPostRules(event *nostr.Event) (reject bool, msg string) {
	if h.IsOrganizer(event.PubKey) {
		return false, ""
	}
	h.mu.RLock()
	rules := h.postRules
	h.mu.RUnlock()
	if rules == nil {
		return false, ""
	}
	prose := bodyForMeasure(event.Content)
	media := countInlineMedia(event.Content)

	// A real feed note: kind-1 that is not a comment riding the same kind.
	if event.Kind == kindNote && !isStiqComment(event) {
		if rules.noteMax > 0 {
			if n := len([]rune(prose)); n > rules.noteMax {
				return true, reason(codeContentTooLong, fmt.Sprintf("blocked: post is %d characters; this community allows at most %d", n, rules.noteMax))
			}
		}
		if rules.noteMediaMax > 0 && media > rules.noteMediaMax {
			return true, reason(codeTooMuchMedia, fmt.Sprintf("blocked: post has %d media items; this community allows at most %d per post", media, rules.noteMediaMax))
		}
		return false, ""
	}

	// Everything else measurable — the article itself, plus every other rich body. Only the reject
	// CODE and the noun differ between the two, so the client can say "article" or "message" without
	// the cap itself ever forking.
	isArticle := event.Kind == kindLongform
	lenCode, mediaCode, noun := codeBodyTooLong, codeTooMuchMedia, "message"
	if isArticle {
		lenCode, mediaCode, noun = codeArticleTooLong, codeArticleTooMuchMedia, "article"
	}
	if rules.articleMax > 0 {
		if n := len(strings.Fields(prose)); n > rules.articleMax {
			return true, reason(lenCode, fmt.Sprintf("blocked: %s is %d words; this community allows at most %d", noun, n, rules.articleMax))
		}
	}
	if rules.articleMediaMax > 0 && media > rules.articleMediaMax {
		return true, reason(mediaCode, fmt.Sprintf("blocked: %s has %d media items; this community allows at most %d", noun, media, rules.articleMediaMax))
	}
	return false, ""
}

// checkNewcomerLinks rejects a link-bearing post from a member still inside the newcomer window
// when the gov policy sets newcomer-no-links. Organizers and moderators are exempt; so is anyone
// past the window or with no recorded bind time (never lock out existing members).
func (h *ConfigHolder) checkNewcomerLinks(event *nostr.Event) (reject bool, msg string) {
	h.mu.RLock()
	gov := h.gov
	h.mu.RUnlock()
	if gov.newcomerDays <= 0 || !gov.newcomerNoLinks {
		return false, ""
	}
	// Organizers and moderators are exempt from newcomer restrictions.
	if h.IsOrganizer(event.PubKey) || h.IsModerator(event.PubKey) {
		return false, ""
	}
	if !h.isNewcomer(event.PubKey, gov.newcomerDays) {
		return false, ""
	}
	if linkRe.MatchString(event.Content) {
		return true, reason(codeNewcomerLinks, "blocked: new members can't post links yet")
	}
	return false, ""
}

// checkChannelCreate enforces the gov channel-create rule on a channel-creation event (NIP-29
// kind 9007, NIP-28 kind 40, or NIP-53 kind 30311), then (if the actor is within the newcomer
// window) the newcomer no-channels rule. Organizers are always allowed; moderators are allowed
// under "mods" and exempt from the newcomer rule.
func (h *ConfigHolder) checkChannelCreate(event *nostr.Event) (reject bool, msg string) {
	h.mu.RLock()
	gov := h.gov
	h.mu.RUnlock()

	if h.IsOrganizer(event.PubKey) {
		return false, ""
	}
	switch gov.channelCreate {
	case "org":
		return true, reason(codeChannelCreateOrganizerOnly, "blocked: only the organizer can create channels in this community")
	case "mods":
		if !h.IsModerator(event.PubKey) {
			return true, reason(codeChannelCreateModsOnly, "blocked: only moderators can create channels in this community")
		}
	}
	// Newcomer no-channels: a member inside the window can't create channels. Moderators exempt.
	if gov.newcomerDays > 0 && gov.newcomerNoChannels && !h.IsModerator(event.PubKey) {
		if h.isNewcomer(event.PubKey, gov.newcomerDays) {
			return true, reason(codeNewcomerChannels, "blocked: new members can't create channels yet")
		}
	}
	return false, ""
}

// isNewcomer reports whether pubkey's bind age is below days. A member with no recorded bind
// time (or no member reader wired) is treated as old enough — never a newcomer.
func (h *ConfigHolder) isNewcomer(pubkey string, days int) bool {
	h.mu.RLock()
	member := h.member
	nowFn := h.now
	h.mu.RUnlock()
	if member == nil {
		return false
	}
	boundAt, ok := member.BoundAt(pubkey)
	if !ok {
		return false // unknown bind time ⇒ treat as an existing member, never locked out
	}
	ageSeconds := nowFn().Unix() - boundAt
	return ageSeconds < int64(days)*secondsPerDay
}

// checkModAction rate-limits a moderator's kind-1984 actions per the stiq:mod-limits policy. The
// action is the `stiq-action` tag value, or "hide" when absent. Organizers are exempt; a
// kind-1984 from a non-moderator is unaffected (those are member reports, gated elsewhere).
func (h *ConfigHolder) checkModAction(event *nostr.Event) (reject bool, msg string) {
	if h.IsOrganizer(event.PubKey) {
		return false, ""
	}
	if !h.IsModerator(event.PubKey) {
		return false, "" // ordinary member report, not a moderator action
	}
	action := modActionName(event)
	// Separation of powers: a rostered moderator may take an action only if its granted scope set (from
	// stiq:permissions) includes it. Checked BEFORE the rate-limit counters so a scope-denied action
	// never consumes quota. Defaults permissive when no permissions doc is published. (T7)
	if !h.modActionPermitted(event.PubKey, action) {
		return true, reason(codeModeratorDenied, "blocked: your moderator role does not permit this action")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	win, ok := h.modLimits[action]
	if !ok || win == (Window{}) {
		return false, "" // this action is unlimited
	}
	today := h.now().Unix() / secondsPerDay
	mc := h.modActions[event.PubKey]
	if mc == nil {
		mc = &modActionCounter{days: make(map[int64]map[string]int)}
		h.modActions[event.PubKey] = mc
	}
	mc.prune(today)
	daily, weekly := mc.sums(action, today)
	if win.Daily > 0 && daily+1 > win.Daily {
		return true, reason(codeModRateLimited, "blocked: daily "+action+" limit reached")
	}
	if win.Weekly > 0 && weekly+1 > win.Weekly {
		return true, reason(codeModRateLimited, "blocked: weekly "+action+" limit reached")
	}
	bucket := mc.days[today]
	if bucket == nil {
		bucket = make(map[string]int)
		mc.days[today] = bucket
	}
	bucket[action]++
	return false, ""
}

// modActionName maps a kind-1984 to a mod-action: the `stiq-action` tag value, or "hide" when
// absent (a bare report is a hide).
func modActionName(event *nostr.Event) string {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "stiq-action" && tag[1] != "" {
			return tag[1]
		}
	}
	return "hide"
}

// hasModScope reports whether moderator pubkey holds scope under the organizer's stiq:permissions
// doc. When no permissions doc has been published (permsSet == false), every rostered moderator holds
// every scope — backward-compatible with the flat roster and the client's ALL_MOD_SCOPES fallback.
func (h *ConfigHolder) hasModScope(pubkey, scope string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if !h.permsSet {
		return true
	}
	set, ok := h.permMods[pubkey]
	if !ok {
		set = h.permDefault
	}
	_, has := set[scope]
	return has
}

// modActionPermitted maps a moderator action (the stiq-action value; "hide" when absent) to the
// scope it requires and reports whether pubkey holds it. A "hide" may target a post OR a comment and
// the relay can't resolve the target's type in this hook, so it admits a hide when the moderator holds
// EITHER hide scope (the client enforces the finer hide-post/hide-comment split). Genuine advisory
// log directives are ungated; any UNKNOWN stiq-action is treated as a hide — clients render an
// unrecognized value as a hide (stiqActionOf → null → hide), so gating only the literal "hide" would
// let a mod without hide scope hide content via a bogus action string. (T7)
func (h *ConfigHolder) modActionPermitted(pubkey, action string) bool {
	switch action {
	case "ban", "unban":
		return h.hasModScope(pubkey, "ban")
	case "restore":
		return h.hasModScope(pubkey, "restore")
	case "lock", "unlock":
		return h.hasModScope(pubkey, "lock")
	case "retag":
		return h.hasModScope(pubkey, "retag")
	case "pin", "unpin":
		return h.hasModScope(pubkey, "pin")
	case "log", "log-user", "unlog-user", "log-batch":
		// Advisory log directives only route content into the mod log; they don't hide or ban,
		// so they are deliberately not scope-gated.
		return true
	default:
		// "hide" and every unrecognized value (which clients render as a hide) require hide scope.
		return h.hasModScope(pubkey, "hide-post") || h.hasModScope(pubkey, "hide-comment")
	}
}

// sums returns the daily (today) and weekly (7-day) counts for an action.
func (mc *modActionCounter) sums(action string, today int64) (daily, weekly int) {
	for day, bucket := range mc.days {
		age := today - day
		if age < 0 {
			continue
		}
		c := bucket[action]
		if age == 0 {
			daily += c
		}
		if age < 7 {
			weekly += c
		}
	}
	return
}

// prune drops day buckets older than the weekly window needs (keep a little slack).
func (mc *modActionCounter) prune(today int64) {
	for day := range mc.days {
		if today-day >= 8 {
			delete(mc.days, day)
		}
	}
}

// LoadFrom replays the latest organizer config already in storage at startup, so a restarted
// relay enforces the current policy without waiting for a republish.
func (h *ConfigHolder) LoadFrom(ctx context.Context, query func(context.Context, nostr.Filter) (chan *nostr.Event, error)) {
	if len(h.organizers) == 0 {
		return
	}
	authors := h.Organizers()
	for _, d := range []string{dModerators, dLimits, dTagPolicy, dPostRules, dGov, dModLimits, dPermissions} {
		ch, err := query(ctx, nostr.Filter{
			Kinds:   []int{KindAppData},
			Authors: authors,
			Tags:    nostr.TagMap{"d": []string{d}},
		})
		if err != nil {
			continue
		}
		var latest *nostr.Event
		for ev := range ch {
			if latest == nil || ev.CreatedAt > latest.CreatedAt {
				latest = ev
			}
		}
		if latest != nil {
			h.applyIfNewer(latest, d)
		}
	}
}

// applyIfNewer applies the config to live policy only when event is strictly newer than the
// last-applied config for `d` (greater CreatedAt, ties broken by lexicographically lower id, matching
// the store's replaceable ordering). A stale or exact-replay event is a no-op, so a captured older
// organizer config can't be rebroadcast to downgrade enforcement. (finding #17)
func (h *ConfigHolder) applyIfNewer(event *nostr.Event, d string) {
	// Hold applyMu across the compare, the version record, AND the apply so a concurrent
	// applyIfNewer for the same `d` cannot interleave and apply an older config after a newer one has
	// already been recorded. mu is still taken briefly for the fast reads/writes of `applied`; apply()
	// re-takes mu internally, which is safe because we release mu before calling it (we only hold the
	// coarser applyMu, which apply() never touches). (finding S7)
	h.applyMu.Lock()
	defer h.applyMu.Unlock()
	h.mu.Lock()
	prev, ok := h.applied[d]
	if ok && !configIsNewer(event.CreatedAt, event.ID, prev) {
		h.mu.Unlock()
		return
	}
	h.applied[d] = appliedVersion{createdAt: event.CreatedAt, id: event.ID}
	h.mu.Unlock()
	h.apply(event, d)
}

// configIsNewer reports whether (createdAt,id) supersedes prev under the replaceable-event ordering:
// a strictly greater CreatedAt wins; on a tie the lexicographically LOWER id wins (matching
// go-nostr's CompareEvent). An identical event (same id, same time) is NOT newer, so a plain replay
// is ignored.
func configIsNewer(createdAt nostr.Timestamp, id string, prev appliedVersion) bool {
	if createdAt != prev.createdAt {
		return createdAt > prev.createdAt
	}
	return id < prev.id
}

func (h *ConfigHolder) apply(event *nostr.Event, d string) {
	switch d {
	case dModerators:
		mods := make(map[string]struct{})
		for _, tag := range event.Tags {
			if len(tag) >= 2 && tag[0] == "p" && tag[1] != "" {
				mods[tag[1]] = struct{}{}
			}
		}
		h.mu.Lock()
		h.moderators = mods
		h.mu.Unlock()
	case dLimits:
		var raw limitsJSON
		if err := json.Unmarshal([]byte(event.Content), &raw); err != nil {
			return
		}
		h.mu.Lock()
		h.limits = raw.toLimits()
		h.mu.Unlock()
	case dTagPolicy:
		var raw tagPolicyJSON
		if err := json.Unmarshal([]byte(event.Content), &raw); err != nil {
			return
		}
		community := make(map[string]struct{}, len(raw.CT))
		for _, t := range raw.CT {
			if t != "" {
				community[t] = struct{}{}
			}
		}
		maxTags := 0
		if raw.Max != nil && *raw.Max > 0 {
			maxTags = *raw.Max
		}
		var scopes map[string]string
		if len(raw.Tsc) > 0 {
			scopes = make(map[string]string, len(raw.Tsc))
			for t, sc := range raw.Tsc {
				if t != "" && (sc == "note" || sc == "article") {
					scopes[t] = sc
				}
			}
		}
		h.mu.Lock()
		h.tagCommunity = community
		h.tagAllowMember = raw.Mem == nil || *raw.Mem // absent ⇒ permissive
		h.tagMax = maxTags
		h.tagScopes = scopes
		h.mu.Unlock()
	case dPostRules:
		var raw postRulesJSON
		if err := json.Unmarshal([]byte(event.Content), &raw); err != nil {
			return
		}
		pr := &postRules{
			noteMax:         raw.Note.max(),
			articleMax:      raw.Article.max(),
			noteMediaMax:    raw.Note.mediaMax(),
			articleMediaMax: raw.Article.mediaMax(),
			authorNoteMax:   nonNeg(raw.Anmx),
		}
		h.mu.Lock()
		h.postRules = pr
		h.mu.Unlock()
	case dGov:
		var raw govJSON
		if err := json.Unmarshal([]byte(event.Content), &raw); err != nil {
			return
		}
		g := govRules{
			newcomerDays:       nonNeg(raw.NCD),
			newcomerNoLinks:    raw.NL,
			newcomerNoChannels: raw.NC,
			channelCreate:      raw.CC,
		}
		h.mu.Lock()
		h.gov = g
		h.mu.Unlock()
	case dModLimits:
		var raw modLimitsJSON
		if err := json.Unmarshal([]byte(event.Content), &raw); err != nil {
			return
		}
		h.mu.Lock()
		h.modLimits = raw.toMap()
		h.mu.Unlock()
	case dPermissions:
		var raw permissionsJSON
		if err := json.Unmarshal([]byte(event.Content), &raw); err != nil {
			return
		}
		def := scopeSet(raw.Def)
		mods := make(map[string]map[string]struct{}, len(raw.Mods))
		for pk, sc := range raw.Mods {
			if pk != "" {
				mods[pk] = scopeSet(sc)
			}
		}
		h.mu.Lock()
		h.permsSet = true
		h.permDefault = def
		h.permMods = mods
		h.mu.Unlock()
	}
}

func nonNeg(v int) int {
	if v < 0 {
		return 0
	}
	return v
}

// tagPolicyJSON is the compact wire form of the organizer's tag policy (shared with the client
// and join code): ct = community tags, pin = pin-first (UX only, relay ignores), mem = whether
// members may author their own tags.
type tagPolicyJSON struct {
	CT  []string `json:"ct"`
	Pin *bool    `json:"pin"`
	Mem *bool    `json:"mem"`
	Max *int     `json:"max"`
	// Tsc maps a community tag to the post type it may appear on ("note" or "article"). Absent ⇒ the
	// tag is allowed on any type (relay previously ignored this field; now enforced, T8).
	Tsc map[string]string `json:"tsc"`
}

// postRulesJSON is the compact wire form of stiq:post-rules. Only max length (mx) is
// hard-enforced by the relay; mn (min length) + lr (label-required) are client-side.
type postRulesJSON struct {
	Note    typeRuleJSON `json:"note"`
	Article typeRuleJSON `json:"article"`
	// Anmx is the author-note (pinned comment) max length in runes. 0/absent ⇒ unenforced (T8).
	Anmx int `json:"anmx"`
}

type typeRuleJSON struct {
	MN int  `json:"mn"`
	MX int  `json:"mx"`
	MM int  `json:"mm"` // media cap (pictures + voice notes) per post; 0 ⇒ unlimited
	LR bool `json:"lr"`
}

// max returns the non-negative max length (0 ⇒ unlimited; a negative wire value clamps to 0).
func (t typeRuleJSON) max() int { return nonNeg(t.MX) }

// mediaMax returns the non-negative inline-media cap (0 ⇒ unlimited). An older organizer's doc omits
// `mm` → 0 (unlimited); the relay only enforces a media cap the organizer explicitly published.
func (t typeRuleJSON) mediaMax() int { return nonNeg(t.MM) }

// govJSON is the compact wire form of stiq:gov: newcomer-days, newcomer-no-links,
// newcomer-no-channels, and the channel-create rule ("any"|"mods"|"org").
type govJSON struct {
	NCD int    `json:"ncd"`
	NL  bool   `json:"nl"`
	NC  bool   `json:"nc"`
	CC  string `json:"cc"`
}

// modLimitsJSON is the compact wire form of stiq:mod-limits: per-action daily/weekly caps.
// Any subset of actions may be present; an absent action (or 0) is unlimited.
type modLimitsJSON struct {
	Hide    *modWindowJSON `json:"hide"`
	Ban     *modWindowJSON `json:"ban"`
	Restore *modWindowJSON `json:"restore"`
	Lock    *modWindowJSON `json:"lock"`
	Unlock  *modWindowJSON `json:"unlock"`
	Retag   *modWindowJSON `json:"retag"`
	Pin     *modWindowJSON `json:"pin"`
	Unpin   *modWindowJSON `json:"unpin"`
}

type modWindowJSON struct {
	D int `json:"d"` // daily cap
	W int `json:"w"` // weekly cap
}

// toMap converts the doc to action→Window, keyed by the same action names checkModAction
// derives from a kind-1984's `stiq-action` tag (with "hide" for a bare report).
func (m modLimitsJSON) toMap() map[string]Window {
	out := make(map[string]Window, 8)
	add := func(name string, w *modWindowJSON) {
		if w == nil {
			return
		}
		win := Window{Daily: nonNeg(w.D), Weekly: nonNeg(w.W)}
		if win != (Window{}) {
			out[name] = win
		}
	}
	add("hide", m.Hide)
	add("ban", m.Ban)
	add("restore", m.Restore)
	add("lock", m.Lock)
	add("unlock", m.Unlock)
	add("retag", m.Retag)
	add("pin", m.Pin)
	add("unpin", m.Unpin)
	return out
}

// permissionsJSON is the compact wire form of stiq:permissions (shared with the client + dashboard):
// def = scopes for any moderator not explicitly listed; mods = per-hexpubkey scope overrides. Scopes
// are a subset of {hide-post, hide-comment, ban, retag, pin, lock, restore}.
type permissionsJSON struct {
	Def  []string            `json:"def"`
	Mods map[string][]string `json:"mods"`
}

// scopeSet builds a set from a scope list, dropping empties. Unknown scope strings are kept as-is
// (harmless: membership is only ever tested against the known action→scope mapping).
func scopeSet(scopes []string) map[string]struct{} {
	set := make(map[string]struct{}, len(scopes))
	for _, s := range scopes {
		if s != "" {
			set[s] = struct{}{}
		}
	}
	return set
}

func dTag(event *nostr.Event) string {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == "d" {
			return tag[1]
		}
	}
	return ""
}

type windowJSON struct {
	Daily   int `json:"daily"`
	Weekly  int `json:"weekly"`
	Monthly int `json:"monthly"`
}

func (w windowJSON) toWindow() Window {
	return Window{Daily: w.Daily, Weekly: w.Weekly, Monthly: w.Monthly}
}

type limitsJSON struct {
	Posts            windowJSON `json:"posts"`
	Comments         windowJSON `json:"comments"`
	Channel          windowJSON `json:"channel"`
	DMGlobalPerMin   int        `json:"dm_global_per_min"`
	ExemptModerators bool       `json:"exempt_moderators"`
	AllowVoice       bool       `json:"allow_voice"`
	// Mailbox caps are pointers so an OLD stiq:limits event (published before these existed) leaves
	// them nil and falls back to the protective DefaultLimits, rather than parsing an absent field as
	// 0 (= unlimited) and silently disabling the flood cap. An organizer who genuinely wants them off
	// publishes an explicit 0.
	MailboxPerMin        *int `json:"mailbox_per_min"`
	MailboxPerConnPerMin *int `json:"mailbox_per_conn_per_min"`
}

func (l limitsJSON) toLimits() Limits {
	lim := Limits{
		Posts:            l.Posts.toWindow(),
		Comments:         l.Comments.toWindow(),
		Channel:          l.Channel.toWindow(),
		DMGlobalPerMin:   l.DMGlobalPerMin,
		ExemptModerators: l.ExemptModerators,
		AllowVoice:       l.AllowVoice,
		// Absent (nil) ⇒ keep the protective default; present ⇒ honor it (explicit 0 = unlimited).
		MailboxPerMin:        DefaultLimits.MailboxPerMin,
		MailboxPerConnPerMin: DefaultLimits.MailboxPerConnPerMin,
	}
	if l.MailboxPerMin != nil {
		lim.MailboxPerMin = nonNeg(*l.MailboxPerMin)
	}
	if l.MailboxPerConnPerMin != nil {
		lim.MailboxPerConnPerMin = nonNeg(*l.MailboxPerConnPerMin)
	}
	return lim
}
