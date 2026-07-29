package policy

import (
	"bytes"
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"sync"

	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/membership"
)

// KindMembershipBinding is the event a new member publishes once to bind their
// (on-device, organizer-unknown) npub to a blind-signed credential (PLAN.md §3.3).
// It is a regular (stored) kind — not ephemeral — so the relay returns OK:true on a
// successful bind. Clients never subscribe to it, so it does not appear in any feed.
const KindMembershipBinding = 9011

// KindGiftWrap is the NIP-17 sealed-DM envelope (PLAN.md §4.1). Its outer signer is an
// ephemeral key, so membership can't gate it; NIP-13 proof-of-work does instead.
const KindGiftWrap = 1059

// KindComment is a NIP-22 comment. Anonymous comments (PLAN.md §3.6) are signed by an
// ephemeral key (not a bound member), so they are admitted via PoW like gift wraps.
const KindComment = 1111

// KindEnrollRequest / KindEnrollResponse are the credential-exchange mailbox events
// (PLAN.md §3.3, smoother-onboarding). A *not-yet-bound* member drops a blinded-token
// request addressed to the organizer; the organizer drops a blind-signature response
// addressed to the member's ephemeral reply key. Both are signed by ephemeral keys (the
// member is unbound by definition during enrollment, and the organizer uses a dedicated
// mailbox key), so — exactly like gift wraps — membership can't gate them and NIP-13
// proof-of-work does instead. They are store-and-forward (the relay holds them until the
// other side picks them up) and carry a NIP-40 expiration so the mailbox self-purges.
//
// NOTE: the response is 9023 (not 9022/9021) to avoid colliding with NIP-29's group
// join/leave-request kinds (9021/9022), which the group guard handles.
const (
	KindEnrollRequest  = 9020
	KindEnrollResponse = 9023
)

// KindDrawRequest / KindDrawResponse are the epoch-token-draw mailbox events (PLAN.md §3.6). A
// member drops a draw request carrying their (blind, unlinkable) membership credential plus a
// batch of blinded tokens, addressed to the organizer; the organizer drops the blind signatures
// addressed to the member's ephemeral reply key. Both are ephemeral-signed and store-and-forward,
// so — exactly like the enrollment mailbox — membership can't gate them and NIP-13 proof-of-work
// does instead. The credential itself (not the relay) authenticates the draw at the organizer.
const (
	KindDrawRequest  = 9024
	KindDrawResponse = 9025
)

// KindUnlockRequest / KindUnlockResponse are the encrypted-content read-meter mailbox events
// (content-encryption + read-token metering). A member drops an unlock request (blind read-token,
// unlinkable) addressed to the organizer; the organizer drops the unlock response (the rotating
// content key K_E, or a per-epoch grant) addressed to the member's ephemeral reply key. Both are
// ephemeral-signed store-and-forward, so — exactly like the enroll/draw mailbox — membership can't
// gate them and NIP-13 proof-of-work does instead. Without an admission branch, 9026 would fall to
// "not a member" and 9027 to "kind not permitted", so the read-meter could never complete.
const (
	KindUnlockRequest  = 9026
	KindUnlockResponse = 9027
)

const (
	tagToken = "stiq_token"
	tagSig   = "stiq_sig"
	// tagSpend carries a P3 holder-bound-token spend proof: a positional BIP-340 signature (token
	// i>=1, base64-standard, 64 bytes) over spendMessage(event.pubkey), proving control of that
	// token's secret q_i without a per-token ledger. Token 0 needs none — it IS the event's own
	// signer, already proven by RequireValidSignature (see the hook-order invariant, §2.6 of the
	// synthesis). MUST match the client's blind/protocol.ts TAG_SPEND exactly.
	tagSpend = "stiq_spend"
	tagNonce = "nonce"
	// tagDomain is the relay-visible media-domain claim on a blind post (asks #3/#4): its value routes
	// posting-token verification to the matching per-media write-issuer key set (see
	// postingKeysForDomain). MUST match the client's blind stiq_dom tag. Absent ⇒ the general posting
	// key set, byte-identical to today.
	tagDomain = "stiq_dom"
)

// Media write domains carried by tagDomain. MUST match the client's MediaPurpose write values'
// domain component ("picture" / "audio").
const (
	domainPicture = "picture"
	domainAudio   = "audio"
)

// spendDomain is the domain-separation prefix hashed into the P3 holder-bound spend-proof digest
// (see spendMessage). MUST be byte-identical to the client's blind/protocol.ts SPEND_DOMAIN — the
// two sides don't share a file, so this exact string is the contract between them.
const spendDomain = "stiq-spend-v1"

// RejectCodesVersion is the version of the stable machine-readable reject-code vocabulary carried
// as a bracketed "[code]" prefix on the relay's publish-path reject reasons (see reason() and the
// Code* constants below). It is advertised in NIP-11 stiq-capabilities.reject_codes_version so a
// client knows which code set to switch on. Bump it whenever a code is added, removed, or its
// meaning changes. The human-readable prose after the prefix is unchanged and remains the display
// string for a generic/legacy client.
//
// v2 (P3): added codeHolderProofInvalid for the holder-bound-token spend-proof gate
// (holderProofRequired).
// v3: organizer content/permission codes (organizer.go) + group codes (groups.go).
// v4 (tokens-everywhere): added codeSpaceTokenRequired for the space-write token gate
// (spaceTokensRequired).
// v5 (rich bodies everywhere): added codeBodyTooLong — the organizer's long-body word cap applied to
// a body that is not itself a long-form article (channel broadcast, group message, comment), so the
// client can word it as a message rather than an article.
const RejectCodesVersion = 5

// reason formats a reject reason with a stable machine-readable code prefix: "[code] prose". A new
// client switches on the code; the existing client (and any generic Nostr client) still shows the
// unchanged prose after it. Keep the prose byte-identical to the pre-code message so existing
// behaviour and Contains-based tests are preserved.
func reason(code, msg string) string { return "[" + code + "] " + msg }

// Stable reject codes for the publish/enroll/draw path (membership.go + weight.go). Codes are
// lowercase snake_case and MUST stay stable across releases (bump RejectCodesVersion on any change).
const (
	codeNotAMember               = "not_a_member"
	codeTokenRequired            = "token_required"
	codeKindNotPermitted         = "kind_not_permitted"
	codePoWDisabled              = "pow_disabled"
	codePoWInsufficientCommitted = "pow_insufficient_committed"
	codePoWInsufficient          = "pow_insufficient"
	codeTokenMalformed           = "token_malformed"
	codeTooManyTokens            = "too_many_tokens"
	codeTokenInvalid             = "token_invalid"
	codeTokenInsufficient        = "token_insufficient"
	codeTokenSpent               = "token_spent"
	codeBindingMalformed         = "binding_malformed"
	codeCredentialInvalid        = "credential_invalid"
	codeCredentialUsed           = "credential_used"
	codeRecordTokenError         = "record_token_error"
	codeRecordMembershipError    = "record_membership_error"
	// P3 holder-bound token (RejectCodesVersion 2): the positional stiq_spend proof chain failed —
	// token 0 didn't equal event.pubkey, a proof was missing/malformed, or a schnorr verify failed.
	codeHolderProofInvalid = "holder_proof_invalid"
	// Tokens-everywhere (RejectCodesVersion 4): member space content (channel/group messages, DM
	// wraps) published without space-write tokens while the community requires them.
	codeSpaceTokenRequired = "space_token_required"
	// weight.go
	codeTooManyTags   = "too_many_tags"
	codeEventTooLarge = "event_too_large"
)

// blindContentKinds are the content kinds that, once a community is blind (BlindRequired), MUST
// ride the blind token path — a throwaway signature plus an unspent per-post token — rather than a
// bound npub. This is exactly the set the current client always blind-posts (client protocol.ts /
// BlindSigner): notes, reactions, comments, articles, polls, voice, and media blobs (30351).
//
// It deliberately EXCLUDES the NIP-28/53 channel + live-chat kinds (42, 1311) and every NIP-29
// group kind: those are signed by the bound npub ON PURPOSE and gated on role by GroupGuard, so
// requiring a token there would break channels/groups. Profiles, reports, NIP-51 lists, and E2E
// key delivery are likewise author-scoped and stay on their existing (bound-npub) path.
var blindContentKinds = map[int]struct{}{
	1:     {}, // note / feed post
	7:     {}, // reaction / vote
	1111:  {}, // NIP-22 comment
	1018:  {}, // poll response
	1068:  {}, // poll
	1222:  {}, // voice message
	1244:  {}, // voice comment
	30023: {}, // NIP-23 long-form article
	// 30351 (media blob): the base64 payload of ONE picture / voice clip, split out of a note's body
	// so it is fetched by id ON TAP instead of riding the feed firehose (bug round 2026-07-15). It is
	// on this path for the same reason its carrier note is — and NOT merely to be permitted: the blind
	// path is what mints a blob its own throwaway key (a blind event is signed by its spent token's
	// secret, and a token is spent once). That per-blob key is LOAD-BEARING: kind 30351 is in the
	// addressable range (30000-39999) and a blob carries no `d` tag, so two blobs sharing a key would
	// silently ReplaceEvent each other and a 2-picture post would lose a picture. Allow-listing 30351
	// in config.DefaultAllowedKinds is NOT sufficient on its own — without this entry every blob is
	// refused here with codeKindNotPermitted, and pictures stop posting entirely.
	30351: {}, // media blob (picture / voice payload)
	// 31925 (event "interested" RSVP): the events surface's reaction. On the blind path for the
	// same privacy reason as kind 7 — a bound-npub RSVP would hand the relay a per-member map of
	// who is interested in which gathering, the exact roster-shaped metadata this community model
	// exists to withhold. Each blind RSVP is signed by its spent token's throwaway key, so (like
	// 30351) the addressable range's ReplaceEvent semantics can never collapse two members'
	// RSVPs; clients fold latest-per-real-author via the attribution layer. The event DOC kind
	// (31923) is deliberately NOT here — it stays bound-npub because host attribution is the point.
	31925: {}, // event interested RSVP
}

func isBlindContentKind(kind int) bool {
	_, ok := blindContentKinds[kind]
	return ok
}

// spaceContentKinds (tokens-everywhere) are the MEMBER-CONTENT kinds of channels and groups — the
// bound-npub half of the content surface, deliberately excluded from blindContentKinds because role
// gating + attribution need the real npub. Under spaceTokensRequired these must ALSO spend blind
// SPACE-WRITE tokens (an all-proofs stiq_spend chain — see gateSpaceTokens), so every form of
// content shares the feed's token economics while staying attributed:
//   - 42:   NIP-28 channel message (defensive — this client publishes NIP-53 only)
//   - 1311: NIP-53 live chat message (+ edits; the client's actual channel-message kind)
//   - 9/11/12: NIP-29 group chat / thread / reply (11 defensive — no client builder today)
//
// Kind 7 (reaction) is dual-natured: an h-tagged kind-7 is a GROUP reaction (bound-npub, handled
// here via isSpaceContentKind); an untagged kind-7 is a blind feed vote and stays on the blind
// path. DM gift wraps (1059) are gated separately in RejectEvent (ephemeral-signed, PoW branch).
// DISJOINT from blindContentKinds (42/1311/9/11/12 appear in neither), so token routing between
// the two chains is unambiguous by construction.
//
// Deliberately EXCLUDED (never token-taxed): every control-plane kind — 30311 channel create/edit,
// 9007/9002/9008/9009 group management, 9021 join request (a joiner has no wallet yet — taxing it
// would brick enrollment into spaces), 9022 leave, 9000/9001 add/remove, 30079 key delivery,
// 30078 settings/invite docs, profiles/reports/lists, and the 9011 binding.
var spaceContentKinds = map[int]struct{}{
	42:   {}, // NIP-28 channel message (defensive)
	1311: {}, // NIP-53 live chat message
	9:    {}, // NIP-29 group chat
	11:   {}, // NIP-29 group thread (defensive)
	12:   {}, // NIP-29 group reply
}

// isSpaceContentKind reports whether the event is member SPACE content: one of the channel/group
// message kinds, or an h-tagged kind-7 (a group reaction — the h tag scopes it to a group, which is
// also what GroupGuard keys on). An untagged kind-7 is a blind feed vote, NOT space content.
func isSpaceContentKind(event *nostr.Event) bool {
	if _, ok := spaceContentKinds[event.Kind]; ok {
		return true
	}
	if event.Kind == 7 {
		_, hasH := tagValue(event, "h")
		return hasH
	}
	return false
}

// maxTokenPairsPerEvent caps how many DISTINCT per-post tokens the relay will verify for one blind
// post, bounding RSA-verification CPU per event (finding #73). It sits above any realistic weight-
// priced cost (an event is already bounded to MaxEventBytes / MaxTagsPerEvent) yet blocks an event
// that packs the tag budget with distinct tokens purely to burn verifications. Combined with the
// dedup-before-verify below, a repeated token is verified at most once. (findings #36/#73)
const maxTokenPairsPerEvent = 256

// Membership replaces the static allow list: a pubkey is accepted only after it binds a
// valid, unspent credential. The relay never learns which member is behind an npub.
type Membership struct {
	issuers []*rsa.PublicKey
	// bindingIssuers, when non-empty, is the ONLY key set accepted for a kind-9011 membership
	// binding, enforcing token domain separation (finding #16). Empty ⇒ handleBinding falls back to
	// issuers (backward compatible). Mutex-guarded (m.mu): hot-reloadable on SIGHUP via
	// UpdateBindingIssuers (T1.1) so the enforced key set can never lag a config-file key rotation —
	// before T1.1 this was "set once at construction, never mutated" (finding F5), the same
	// advertise-vs-enforce shape that originally bricked space-write.
	bindingIssuers []*rsa.PublicKey
	// postingIssuers, when non-empty, is the ONLY key set accepted for a per-post blind token
	// (handleBlindPost) — the posting half of token domain separation (finding #16), symmetric to
	// bindingIssuers. Empty ⇒ handleBlindPost falls back to issuers (backward compatible). Mutex-
	// guarded (m.mu): hot-reloadable on SIGHUP via UpdatePostingIssuers (T1.1) — see bindingIssuers.
	postingIssuers []*rsa.PublicKey
	// pictureWriteIssuers / audioWriteIssuers extend posting-token domain separation to media (asks
	// #3/#4): when non-empty, a blind post whose stiq_dom tag claims that domain must verify against
	// THIS key set. Empty ⇒ that domain falls back to postingIssuers/issuers. Mutex-guarded (m.mu):
	// hot-reloadable on SIGHUP via UpdatePictureWriteIssuers/UpdateAudioWriteIssuers (T1.1) — see
	// bindingIssuers.
	pictureWriteIssuers []*rsa.PublicKey
	audioWriteIssuers   []*rsa.PublicKey
	// spaceWriteIssuers (tokens-everywhere): the ONLY key set accepted for SPACE-WRITE tokens — the
	// blind tokens attached to bound-npub space content (see spaceContentKinds) and DM gift wraps.
	// Deliberately NO fallback to postingIssuers/issuers: a space token is a distinct domain, and a
	// token-tagged space event with this unset is rejected exactly as today (the client never
	// attaches without the advertised capability). Mutex-guarded (m.mu): hot-reloadable on SIGHUP via
	// UpdateSpaceWriteIssuers so the enforced key set tracks the reloadable space_tokens_required flag.
	spaceWriteIssuers []*rsa.PublicKey
	store             membership.Store
	kinds             map[int]struct{}
	minPoW            int // NIP-13 difficulty required on gift wraps; 0 disables DMs
	enrollPoW         int // NIP-13 difficulty for enroll-mailbox kinds; 0 falls back to minPoW

	mu         sync.RWMutex
	organizers map[string]struct{} // privileged keys exempt from the membership gate; guarded by mu
	// bytesPerToken drives weight-priced tokens (0 = disabled, one token per event). Guarded by mu
	// so it can be hot-reloaded (SetBytesPerToken) alongside the organizer set.
	bytesPerToken int
	// blindRequired, when true, forces every blindContentKind onto the token path: a bound npub (or
	// organizer) may no longer publish those kinds tokenless. Ships DARK (false) so the change
	// deploys with zero behaviour change; flip on only once the community's clients blind-post all
	// content (the current client already does). Guarded by mu for hot-reload.
	blindRequired bool
	// holderProofRequired gates the P3 holder-bound-token verification in handleBlindPost: token 0
	// must equal event.pubkey and every further token must carry a valid positional stiq_spend
	// proof. Ships DARK (false): a false value ignores stiq_spend tags entirely and admits pre-P3
	// bearer-token events exactly as before (token 0 need not equal event.pubkey), so this is a
	// deliberate, clients-first migration flip — mirrors blindRequired. Guarded by mu for hot-reload.
	holderProofRequired bool
	// spaceTokensRequired (tokens-everywhere): when true, member space content (spaceContentKinds +
	// DM gift wraps) MUST carry space-write tokens, closing the last unmetered write surfaces —
	// group chat (9/11/12) has NO per-npub rate window at all today, and channel/DM windows are
	// coarse. Control-plane kinds (join/leave/add/remove/metadata/key-delivery/settings) are never
	// token-taxed. Ships DARK (false): tokenless space content admits exactly as before. Guarded by
	// mu for hot-reload; a clients-first flip like blindRequired.
	spaceTokensRequired bool
}

func NewMembership(issuers []*rsa.PublicKey, store membership.Store, kinds []int, minPoW, enrollPoW int) *Membership {
	m := &Membership{
		issuers:   issuers,
		store:     store,
		kinds:     make(map[int]struct{}, len(kinds)),
		minPoW:    minPoW,
		enrollPoW: enrollPoW,
	}
	for _, k := range kinds {
		m.kinds[k] = struct{}{}
	}
	return m
}

// SetBindingIssuers restricts kind-9011 membership-binding verification to a DISTINCT key set,
// separate from the per-post/read/draw token issuers, so a plentiful posting token can no longer be
// presented as a scarce membership-binding credential (finding #16). An empty/nil set leaves the
// legacy behaviour (binding verifies against the general issuers). Safe at construction and on
// hot-reload (mutex-guarded, mirroring SetSpaceWriteIssuers) so the enforced key set can track a
// SIGHUP config reload (T1.1).
func (m *Membership) SetBindingIssuers(issuers []*rsa.PublicKey) {
	m.mu.Lock()
	m.bindingIssuers = issuers
	m.mu.Unlock()
}

// UpdateBindingIssuers re-supplies the binding-issuer key set on SIGHUP hot-reload (T1.1, finding
// F5), so the ENFORCED kind-9011 verification key never diverges from whatever the operator has
// configured in binding_issuer_public_keys — mirrors UpdateSpaceWriteIssuers. Before this, binding
// was "construction-only": a SIGHUP that rotated the config-file key left enforcement on the STALE
// key in memory while any advertised fingerprint (T1.3) reflected the fresh config.
func (m *Membership) UpdateBindingIssuers(issuers []*rsa.PublicKey) {
	m.SetBindingIssuers(issuers)
}

// BindingIssuers returns the currently ENFORCED kind-9011 binding-issuer key set (raw, pre-fallback
// — empty when no dedicated binding issuer is configured). Exported so the capabilities regression
// test (T1.2) can assert the advertised NIP-11 `issuer_key_fingerprints.binding` never drifts from
// what Membership actually enforces, both at construction and after a SIGHUP reload. Safe to call
// concurrently with UpdateBindingIssuers.
func (m *Membership) BindingIssuers() []*rsa.PublicKey {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.bindingIssuers
}

// bindingKeys returns the key set to verify a kind-9011 binding against: the dedicated binding
// issuers when configured, else the general issuers (backward compatible).
func (m *Membership) bindingKeys() []*rsa.PublicKey {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if len(m.bindingIssuers) > 0 {
		return m.bindingIssuers
	}
	return m.issuers
}

// SetPostingIssuers restricts per-post blind-token verification (handleBlindPost) to a DISTINCT key
// set, separate from the membership-binding issuers, so a scarce enrollment credential can no longer
// be presented as a plentiful posting token and vice-versa (finding #16). An empty/nil set leaves the
// legacy behaviour (posting verifies against the general issuers). Safe at construction and on
// hot-reload (mutex-guarded, mirroring SetSpaceWriteIssuers) so the enforced key set can track a
// SIGHUP config reload (T1.1).
func (m *Membership) SetPostingIssuers(issuers []*rsa.PublicKey) {
	m.mu.Lock()
	m.postingIssuers = issuers
	m.mu.Unlock()
}

// UpdatePostingIssuers re-supplies the posting-issuer key set on SIGHUP hot-reload (T1.1, finding
// F5), so the ENFORCED per-post token verification key never diverges from whatever the operator has
// configured in posting_issuer_public_keys — mirrors UpdateSpaceWriteIssuers. Before this, posting
// was "construction-only": a SIGHUP that rotated the config-file key left enforcement on the STALE
// key in memory while any advertised fingerprint (T1.3) reflected the fresh config.
func (m *Membership) UpdatePostingIssuers(issuers []*rsa.PublicKey) {
	m.SetPostingIssuers(issuers)
}

// PostingIssuers returns the currently ENFORCED per-post token issuer key set (raw, pre-fallback —
// empty when no dedicated posting issuer is configured). Exported so the capabilities regression
// test (T1.2) can assert the advertised NIP-11 `issuer_key_fingerprints.posting` never drifts from
// what Membership actually enforces, both at construction and after a SIGHUP reload. Safe to call
// concurrently with UpdatePostingIssuers.
func (m *Membership) PostingIssuers() []*rsa.PublicKey {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.postingIssuers
}

// postingKeys returns the key set to verify a per-post blind token against: the dedicated posting
// issuers when configured, else the general issuers (backward compatible).
func (m *Membership) postingKeys() []*rsa.PublicKey {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if len(m.postingIssuers) > 0 {
		return m.postingIssuers
	}
	return m.issuers
}

// SetPictureWriteIssuers / SetAudioWriteIssuers restrict a blind post that CLAIMS the picture/audio
// media domain (via its stiq_dom tag) to a DISTINCT posting-token key set (asks #3/#4). An empty/nil
// set leaves that domain on the general posting keys. Safe at construction and on hot-reload
// (mutex-guarded, mirroring SetSpaceWriteIssuers) so the enforced key set can track a SIGHUP config
// reload (T1.1).
func (m *Membership) SetPictureWriteIssuers(issuers []*rsa.PublicKey) {
	m.mu.Lock()
	m.pictureWriteIssuers = issuers
	m.mu.Unlock()
}

// UpdatePictureWriteIssuers re-supplies the picture-write issuer key set on SIGHUP hot-reload (T1.1,
// finding F5) — mirrors UpdateSpaceWriteIssuers. Before this, the media domains were
// "construction-only": activating media via a SIGHUP-only config+capability flip left enforcement
// with zero (or stale) keys in memory while capabilities advertised the domain from live config.
func (m *Membership) UpdatePictureWriteIssuers(issuers []*rsa.PublicKey) {
	m.SetPictureWriteIssuers(issuers)
}

// PictureWriteIssuers returns the currently ENFORCED picture-write issuer key set (raw, pre-fallback
// — empty when unconfigured). Exported so the capabilities regression test (T1.2) can assert the
// advertised NIP-11 `issuer_key_fingerprints.picture` never drifts from what Membership actually
// enforces, both at construction and after a SIGHUP reload. Safe to call concurrently with
// UpdatePictureWriteIssuers.
func (m *Membership) PictureWriteIssuers() []*rsa.PublicKey {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.pictureWriteIssuers
}

func (m *Membership) SetAudioWriteIssuers(issuers []*rsa.PublicKey) {
	m.mu.Lock()
	m.audioWriteIssuers = issuers
	m.mu.Unlock()
}

// UpdateAudioWriteIssuers re-supplies the audio-write issuer key set on SIGHUP hot-reload (T1.1,
// finding F5) — see UpdatePictureWriteIssuers.
func (m *Membership) UpdateAudioWriteIssuers(issuers []*rsa.PublicKey) {
	m.SetAudioWriteIssuers(issuers)
}

// AudioWriteIssuers returns the currently ENFORCED audio-write issuer key set (raw, pre-fallback —
// empty when unconfigured). Exported so the capabilities regression test (T1.2) can assert the
// advertised NIP-11 `issuer_key_fingerprints.audio` never drifts from what Membership actually
// enforces, both at construction and after a SIGHUP reload. Safe to call concurrently with
// UpdateAudioWriteIssuers.
func (m *Membership) AudioWriteIssuers() []*rsa.PublicKey {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.audioWriteIssuers
}

// SetSpaceWriteIssuers supplies the SPACE-WRITE token key set (tokens-everywhere): the domain that
// meters bound-npub space content + DM wraps. An empty/nil set keeps token-tagged space events
// rejected (no fallback — see the field doc). Safe at construction and on hot-reload (mutex-guarded,
// mirroring SetSpaceTokensRequired) so the enforced key set can track the SIGHUP-reloadable flag.
func (m *Membership) SetSpaceWriteIssuers(issuers []*rsa.PublicKey) {
	m.mu.Lock()
	m.spaceWriteIssuers = issuers
	m.mu.Unlock()
}

// UpdateSpaceWriteIssuers re-supplies the space-write key set on SIGHUP hot-reload, so the ENFORCED
// verification key never diverges from the ADVERTISED space_tokens_required capability (which reads
// the fresh config). Without this, a SIGHUP-only activation left enforcement with zero keys in memory
// while the NIP-11 doc claimed space tokens were required.
func (m *Membership) UpdateSpaceWriteIssuers(issuers []*rsa.PublicKey) {
	m.SetSpaceWriteIssuers(issuers)
}

// SpaceWriteIssuers returns the currently ENFORCED space-write issuer key set. Exported so the
// capabilities regression test (T1.2) can assert the advertised NIP-11
// `issuer_key_fingerprints.space_write` never drifts from what Membership actually enforces, both
// at construction and after a SIGHUP reload. Safe to call concurrently with UpdateSpaceWriteIssuers.
func (m *Membership) SpaceWriteIssuers() []*rsa.PublicKey {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.spaceWriteIssuers
}

// EnrollIssuers returns the general enrollment/draw issuer key set — the fallback key set for
// posting/binding when their own dedicated lists are empty. It is construction-only: unlike the
// four domain-separated sets above, general issuer_public_keys are NOT part of T1.1's hot-reload
// table (see relay.go's Reloader.Apply and main.go's restart-only field list) — this getter exists
// purely so the T1.2 capabilities regression test can cover the "enroll" domain with the same
// advertised-equals-enforced comparison as the reloadable domains. Never mutated after
// NewMembership, so no lock is needed.
func (m *Membership) EnrollIssuers() []*rsa.PublicKey { return m.issuers }

// SetSpaceTokensRequired toggles the space-write token requirement (tokens-everywhere): when true,
// member space content must pay space-write tokens. false (the default) ships dark — tokenless
// space content admits exactly as before. A deliberate clients-first flip, mirroring
// SetBlindRequired: enable only once the community's clients attach space tokens (they do when the
// NIP-11 capability advertises it). Safe at construction and on hot-reload.
func (m *Membership) SetSpaceTokensRequired(v bool) {
	m.mu.Lock()
	m.spaceTokensRequired = v
	m.mu.Unlock()
}

// UpdateSpaceTokensRequired is an alias used on SIGHUP hot-reload.
func (m *Membership) UpdateSpaceTokensRequired(v bool) { m.SetSpaceTokensRequired(v) }

// postingKeysForDomain returns the key set to verify a blind post against, routed by its relay-visible
// stiq_dom claim: the per-media write issuers for `picture`/`audio` when configured, else the general
// posting keys. A post with no domain tag (or a domain whose media issuers aren't configured) verifies
// exactly as today — so this is byte-identical until an operator supplies the media write keys.
//
// Snapshots pictureWriteIssuers/audioWriteIssuers under ONE RLock/RUnlock, then falls through to
// postingKeys() (which takes its own separate RLock) — never nesting two RLock acquisitions in the
// same call, which sync.RWMutex does not guarantee is safe against a concurrent writer.
func (m *Membership) postingKeysForDomain(dom string) []*rsa.PublicKey {
	m.mu.RLock()
	pictureWriteIssuers := m.pictureWriteIssuers
	audioWriteIssuers := m.audioWriteIssuers
	m.mu.RUnlock()
	switch dom {
	case domainPicture:
		if len(pictureWriteIssuers) > 0 {
			return pictureWriteIssuers
		}
	case domainAudio:
		if len(audioWriteIssuers) > 0 {
			return audioWriteIssuers
		}
	}
	return m.postingKeys()
}

// blindDomain returns the media-domain claim (stiq_dom) on a blind post: "picture", "audio", or ""
// (no claim / unrecognized). Only the first recognized value is honored, so a padded set of stiq_dom
// tags can't confuse routing.
func blindDomain(event *nostr.Event) string {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == tagDomain {
			if tag[1] == domainPicture || tag[1] == domainAudio {
				return tag[1]
			}
		}
	}
	return ""
}

// SetOrganizers marks the given hex pubkeys as privileged: their (permitted-kind) events are
// admitted without a bound membership credential, so the organizer can publish the moderation
// config (kind 30078) without first binding a credential. See ConfigHolder.
func (m *Membership) SetOrganizers(pubkeys []string) {
	next := make(map[string]struct{}, len(pubkeys))
	for _, pk := range pubkeys {
		if pk != "" {
			next[pk] = struct{}{}
		}
	}
	m.mu.Lock()
	m.organizers = next
	m.mu.Unlock()
}

// UpdateOrganizers is an alias for SetOrganizers used on SIGHUP hot-reload.
func (m *Membership) UpdateOrganizers(pubkeys []string) { m.SetOrganizers(pubkeys) }

// SetBytesPerToken sets the weight-pricing rate (see config.BytesPerToken): a blind post must carry
// one token per bytesPerToken of chargeable weight, floored at one. 0 disables weight-pricing (one
// token per event). Safe to call at construction and on hot-reload.
func (m *Membership) SetBytesPerToken(n int) {
	m.mu.Lock()
	m.bytesPerToken = n
	m.mu.Unlock()
}

// UpdateBytesPerToken is an alias used on SIGHUP hot-reload.
func (m *Membership) UpdateBytesPerToken(n int) { m.SetBytesPerToken(n) }

// SetBlindRequired toggles whether blind-eligible content kinds (see blindContentKinds) must carry
// a per-post token. false (the default) preserves the legacy bound-npub content path; true closes
// the bound-npub bypass. Safe at construction and on hot-reload.
func (m *Membership) SetBlindRequired(v bool) {
	m.mu.Lock()
	m.blindRequired = v
	m.mu.Unlock()
}

// UpdateBlindRequired is an alias used on SIGHUP hot-reload.
func (m *Membership) UpdateBlindRequired(v bool) { m.SetBlindRequired(v) }

// SetHolderProofRequired toggles the P3 holder-bound-token spend-proof gate (see the
// holderProofRequired field doc). false (the default) ships dark: stiq_spend tags are ignored and
// token 0 need not equal event.pubkey, so pre-P3 bearer-token clients keep working unchanged.
// Flip true only once the community's clients mint holder-bound tokens (Q = schnorr pubkey) — a
// deliberate, clients-first migration, mirroring SetBlindRequired. Safe at construction and reload.
func (m *Membership) SetHolderProofRequired(v bool) {
	m.mu.Lock()
	m.holderProofRequired = v
	m.mu.Unlock()
}

// UpdateHolderProofRequired is an alias used on SIGHUP hot-reload.
func (m *Membership) UpdateHolderProofRequired(v bool) { m.SetHolderProofRequired(v) }

// enrollDifficulty is the PoW required on the credential-exchange mailbox kinds. A typically
// lower bar than DMs so a phone can mine an enrollment request in pure JS; falls back to the
// gift-wrap difficulty when unset.
func (m *Membership) enrollDifficulty() int {
	if m.enrollPoW > 0 {
		return m.enrollPoW
	}
	return m.minPoW
}

// VerifyEvent is the membership VERIFY hook (wired into the relay's `membership` slot). It admits a
// one-time binding event carrying a valid credential, admits normal events only from already-bound
// npubs, and — for token-bearing content — VERIFIES the blind/space token chain (issuer signatures,
// holder proofs, weight-priced count) WITHOUT committing the spend. The spend is deferred to
// CommitSpend, the FINAL reject hook, so a later organizer/ratelimit/group/admitAttributed reject can
// no longer burn a token for an event that is then never stored (finding F1).
//
// The one exception is the kind-9011 binding: its credential is spent HERE (handleBinding → store.Bind)
// because a binding is never rejected by any later hook (organizer/ratelimit/group all pass 9011), so
// it has no F1 exposure and needs no deferral.
//
// For any non-khatru caller that wants the whole gate (verify + spend) in one call, use RejectEvent,
// which chains VerifyEvent then CommitSpend and preserves the pre-split single-call semantics.
func (m *Membership) VerifyEvent(ctx context.Context, event *nostr.Event) (reject bool, msg string) {
	if event.Kind == KindMembershipBinding {
		return m.handleBinding(event)
	}
	// Gift wraps are ephemeral-signed — admit via PoW regardless of membership. Tokens-everywhere:
	// the wrap may ADDITIONALLY carry space-write tokens (proofs bound to the wrap's own ephemeral
	// pubkey), and must when spaceTokensRequired — the tokens prove a member's spam budget paid for
	// the DM without identifying the sender, closing the "PoW alone meters DMs" gap. PoW is checked
	// FIRST (cheap, and it must not SPEND tokens for a wrap that then fails PoW — that would burn an
	// honest retry's budget), then the token gate; both are required. Membership still can't gate a
	// wrap, by design.
	if event.Kind == KindGiftWrap {
		if reject, msg := m.handlePoW(event, m.minPoW); reject {
			return true, msg
		}
		return m.gateSpaceTokens(event)
	}
	// Credential-exchange mailbox events are likewise ephemeral-signed (the sender is unbound
	// during enrollment), admitted via a typically-lower enroll PoW.
	if event.Kind == KindEnrollRequest || event.Kind == KindEnrollResponse {
		return m.handlePoW(event, m.enrollDifficulty())
	}
	// Epoch-token-draw mailbox: same PoW-gated store-and-forward as enrollment.
	if event.Kind == KindDrawRequest || event.Kind == KindDrawResponse {
		return m.handlePoW(event, m.enrollDifficulty())
	}
	// Read-meter unlock mailbox: same PoW-gated store-and-forward as the enroll/draw mailbox. The
	// request (9026) and the response (9027) are both ephemeral-signed (the organizer answers from a
	// dedicated mailbox key, not its config key), so membership can't gate them — enroll-PoW does.
	// Without this branch 9026 fell to "not a member" and 9027 to "kind not permitted", so the
	// read-meter could never complete end-to-end.
	if event.Kind == KindUnlockRequest || event.Kind == KindUnlockResponse {
		return m.handlePoW(event, m.enrollDifficulty())
	}
	// Space content (tokens-everywhere): member channel/group content stays bound-npub-signed (role
	// gating + attribution) but must ALSO pay blind space-write tokens once the community requires
	// them. Routed BEFORE the blind-token branch below: a token-tagged space kind verifies via the
	// all-proofs space chain (its shape — npub signer, N proofs for N tokens — is structurally
	// incompatible with handleBlindPost's token-0-signs-the-event chain), then falls through to the
	// normal organizer/bound-npub admission, which still applies (tokens are additive, never a
	// membership bypass). Tokenless space content with the requirement OFF admits exactly as today.
	// Kind 7 is dual-natured (blind feed vote vs h-tagged group reaction) and kind 7 IS a blind
	// content kind, so an h-tagged kind-7 keeps its LEGACY routing (blind path / blindRequired)
	// until space tokens are actually enforced. Without this guard, a bound member in any group
	// could h-tag feed votes to slip past blindRequired + the token budget + the rate limiter
	// (kind 7 → catNone) while the feature is dark — a vote-inflation channel. Once enforcement is
	// on, an h-tagged reaction pays space tokens instead: metered either way, never free.
	if isSpaceContentKind(event) && (event.Kind != 7 || m.spaceTokensEnforced()) {
		if reject, msg := m.gateSpaceTokens(event); reject {
			return true, msg
		}
		return m.admitAttributed(event)
	}
	// Blind post (PLAN.md §3.6 generalized to all content): an allow-listed content kind signed
	// by a throwaway key and carrying a per-post anti-spam token. Admit iff the token verifies
	// and is unspent, then spend it. The relay never learns the author (that rides encrypted in
	// the stiq_attr tag, which the relay ignores). This is the primary posting path; the
	// organizer + bound-npub paths below remain for organizer config and migration.
	if hasToken(event) {
		return m.handleBlindPost(event)
	}
	// Once the community is blind, a blind-eligible content kind MUST carry a token (handled just
	// above). A tokenless one reaching here is a patched client trying to post under a re-linkable
	// bound npub and skip the per-post anti-spam budget — reject it. This runs BEFORE the organizer
	// and bound-npub branches, so config kinds (30078), reports, lists, profiles, DMs, the one-time
	// binding, and all channel/group kinds (deliberately excluded from blindContentKinds) still flow
	// through unchanged. Organizers are NOT exempt: an organizer's own note blind-posts like any
	// member — only their non-content config kinds pass. Ships dark (blindRequired defaults false).
	m.mu.RLock()
	blindReq := m.blindRequired
	m.mu.RUnlock()
	if blindReq && isBlindContentKind(event.Kind) {
		return true, reason(codeTokenRequired, "blocked: this community requires a posting token for this content")
	}
	return m.admitAttributed(event)
}

// RejectEvent runs the FULL membership gate in one call: the verify phase (VerifyEvent), then — when
// it passes — the commit phase (CommitSpend). The relay itself does NOT call this: it wires
// VerifyEvent as the membership hook and CommitSpend as the FINAL reject hook, so a token is
// committed only after every reject hook has passed (finding F1). This single-call form is retained
// for tests and any non-khatru caller that wants the whole gate at once; it preserves the pre-split
// semantics — one call verifies AND spends — including the double-spend and idempotent-retry contract.
func (m *Membership) RejectEvent(ctx context.Context, event *nostr.Event) (reject bool, msg string) {
	if reject, msg := m.VerifyEvent(ctx, event); reject {
		return reject, msg
	}
	return m.CommitSpend(ctx, event)
}

// CommitSpend is the FINAL RejectEvent hook (wired after signature / weight / membership-verify /
// organizer / ratelimit / group in relay.go). It commits the token spend for a token-bearing event
// that has passed EVERY prior reject hook. Splitting the commit out of the membership verify hook is
// the finding-F1 fix: tokens are verified early (in the membership hook, so a bad token still rejects
// before the costly organizer/group disk writes) but burned only here, after the whole chain has
// accepted the event — so a later organizer / ratelimit / group / admitAttributed reject can no longer
// leave a spent-but-abandoned token on an event that is never stored.
//
// It RECOMPUTES the spend plan from the event rather than stashing state between hooks: khatru
// short-circuits on the first reject (adding.go / ephemeral.go), so a middle-hook reject skips this
// hook entirely — a stashed pending spend would then leak per rejected event (a DoS vector). The
// recomputation is cheap (sha256 + dedup, no RSA — already verified) and deterministic, so it burns
// EXACTLY the ids[:need] the verify phase validated. SpendAllForEvent is atomic and idempotent by
// event ID (membership/store.go): two concurrent DISTINCT events sharing a token serialize here —
// exactly one wins, the loser gets ErrTokenSpent and is rejected pre-store (double-spend authority
// preserved) — while the SAME event retried re-commits idempotently (never double-charged).
//
// Invariant: a token is committed to the spent-set only after ALL reject hooks pass. Two pre-existing,
// non-blocking caveats survive unchanged (this fix narrows the abandonment window to them, widens
// neither): (a) khatru's post-reject deleted-by-ID check runs AFTER this hook, so an author who
// pre-published a matching kind-5 can still self-drop their own just-paid event; (b) a StoreEvent
// failure after this commit yields a paid-but-unstored token, identical to the old membership-hook spend.
func (m *Membership) CommitSpend(_ context.Context, event *nostr.Event) (reject bool, msg string) {
	ids, need, ok := m.plannedSpend(event)
	if !ok {
		return false, "" // not a token-spending event — nothing to commit
	}
	if need > len(ids) {
		// Unreachable on a single pass: VerifyEvent already rejected len(distinct) < need. Only a
		// bytes_per_token SIGHUP racing between verify and commit could raise need; fail clean rather
		// than slice out of range or partial-spend.
		return true, reason(codeTokenInsufficient, fmt.Sprintf("blocked: event needs %d tokens, has %d", need, len(ids)))
	}
	if err := m.store.SpendAllForEvent(ids[:need], event.ID); err != nil {
		if errors.Is(err, membership.ErrTokenSpent) {
			return true, reason(codeTokenSpent, "blocked: token already spent")
		}
		return true, reason(codeRecordTokenError, "error: could not record token")
	}
	return false, ""
}

// plannedSpend recomputes the token-spend plan for an event that has passed the verify phase:
// (ids, need, ok) where ids are the deduplicated token IDs in first-seen order and need is the
// weight-priced count. ok is false for events carrying no committed spend — tokenless content, the
// kind-9011 binding (its credential is spent via store.Bind in the verify phase, never here, and a
// binding is never rejected by a later hook), and the ephemeral credential-exchange mailbox kinds
// (PoW-gated store-and-forward, never token-spending). Every OTHER token-bearing event that reaches
// the commit hook was routed through gateSpaceTokens or handleBlindPost and validated there, so it
// spends its distinct tokens — the commit needs no space-vs-blind routing because a mis-routed or
// unverified token would already have been rejected in the verify phase and never reach here. No RSA
// (already verified); bytesPerToken is re-snapshotted so weight-pricing stays consistent with verify.
func (m *Membership) plannedSpend(event *nostr.Event) (ids []string, need int, ok bool) {
	if !hasToken(event) {
		return nil, 0, false
	}
	switch event.Kind {
	case KindMembershipBinding:
		return nil, 0, false
	case KindEnrollRequest, KindEnrollResponse, KindDrawRequest, KindDrawResponse,
		KindUnlockRequest, KindUnlockResponse:
		return nil, 0, false
	}
	m.mu.RLock()
	bytesPerToken := m.bytesPerToken
	m.mu.RUnlock()
	return distinctTokenIDs(event), TokenCost(event, bytesPerToken), true
}

// admitAttributed is the bound-npub admission tail shared by ordinary attributed kinds and
// (post-token-gate) space content: organizer keys are privileged — admitted without a bound
// credential so the organizer can publish moderation config (roster, limits, tag policy), still
// subject to the kind allow-list (the ConfigHolder gate further restricts `stiq:` config `d`
// tags); bound members are admitted for allow-listed kinds; everyone else is refused.
func (m *Membership) admitAttributed(event *nostr.Event) (reject bool, msg string) {
	m.mu.RLock()
	_, isOrg := m.organizers[event.PubKey]
	m.mu.RUnlock()
	if isOrg {
		if _, ok := m.kinds[event.Kind]; !ok {
			return true, reason(codeKindNotPermitted, fmt.Sprintf("blocked: event kind %d not permitted", event.Kind))
		}
		return false, ""
	}
	if m.store.IsBound(event.PubKey) {
		if _, ok := m.kinds[event.Kind]; !ok {
			return true, reason(codeKindNotPermitted, fmt.Sprintf("blocked: event kind %d not permitted", event.Kind))
		}
		// Tag policy (organizer's allow-member-tags=false) is enforced by ConfigHolder, which
		// holds the live policy from the organizer's kind-30078 event.
		return false, ""
	}
	// Not a bound member: nothing else is admissible. Anonymous comments were removed —
	// all comments are now signed by bound members. (Gift wraps were handled above via PoW.)
	return true, reason(codeNotAMember, "blocked: not a member (no bound credential)")
}

// handlePoW admits an ephemeral-signed event (DM gift wrap or anonymous comment) if it
// carries enough NIP-13 proof-of-work. The committed target (3rd element of the nonce tag)
// must also meet the minimum, so a sender can't get lucky with a low-effort id.
func (m *Membership) handlePoW(event *nostr.Event, difficulty int) (reject bool, msg string) {
	if difficulty <= 0 {
		return true, reason(codePoWDisabled, "blocked: proof-of-work content is disabled")
	}
	if committedDifficulty(event) < difficulty {
		return true, reason(codePoWInsufficientCommitted, "blocked: insufficient committed proof-of-work")
	}
	if membership.LeadingZeroBits(event.ID) < difficulty {
		return true, reason(codePoWInsufficient, "blocked: insufficient proof-of-work")
	}
	return false, ""
}

// committedDifficulty reads the target from the nonce tag: ["nonce", "<n>", "<target>"].
func committedDifficulty(event *nostr.Event) int {
	for _, tag := range event.Tags {
		if len(tag) >= 3 && tag[0] == tagNonce {
			if target, err := strconv.Atoi(tag[2]); err == nil {
				return target
			}
		}
	}
	return 0
}

// handleBlindPost VERIFIES a per-post blind token: it checks the issuer signature, the weight-priced
// count, and (when enabled) the holder-proof chain — but does NOT spend. The spend is committed later
// in CommitSpend (the final reject hook), so a token survives a subsequent organizer/ratelimit/group
// reject (finding F1). Unlike handleBinding it binds no npub — each post spends its own token and is
// signed by a throwaway key, so posting cannot be rate-limited per-identity (the token count is the
// limit) and the relay stays blind to the author.
func (m *Membership) handleBlindPost(event *nostr.Event) (reject bool, msg string) {
	if _, ok := m.kinds[event.Kind]; !ok {
		return true, reason(codeKindNotPermitted, fmt.Sprintf("blocked: event kind %d not permitted", event.Kind))
	}
	// Confine the token/blind path to the kinds meant to be anonymous. A client can voluntarily attach
	// a token to an ATTRIBUTABLE allow-listed kind — the NIP-28/53 channel + live-chat kinds (42, 1311)
	// or a NIP-29 group kind — to slip it past the per-npub rate limiter (ratelimit.go short-circuits
	// ANY token-bearing event before categorize) and client-side moderation (both key on a stable bound
	// npub), while staying unattributable. Only blindContentKinds are legitimately tokenized — exactly
	// what the client blind-signs — so anything else on this path is a patched client; reject it back to
	// the bound-npub path where the channel/group rate windows + GroupGuard apply. (hardening: token-kind
	// rate-limit/moderation evasion)
	if !isBlindContentKind(event.Kind) {
		return true, reason(codeKindNotPermitted, fmt.Sprintf("blocked: event kind %d not permitted on the blind-post token path", event.Kind))
	}
	m.mu.RLock()
	bytesPerToken := m.bytesPerToken
	m.mu.RUnlock()
	need := TokenCost(event, bytesPerToken)

	creds := extractCredentials(event)
	if len(creds) == 0 {
		return true, reason(codeTokenMalformed, "blocked: malformed blind-post token")
	}
	// De-duplicate by TokenID BEFORE any RSA verification (findings #36/#73). TokenID is a cheap
	// sha256 of the token bytes and needs no signature, so a token repeated N times (to fake the
	// count, or purely to force N expensive RSA-PSS verifications of an already-spent token) collapses
	// to a single distinct pair here and is verified at most ONCE. Without this, an attacker holding
	// one valid token could pack ~150 identical copies into each of arbitrarily many distinct events
	// and burn a full verification per copy before the post-verify spent-set check ever runs.
	// CommitSpend recomputes the identical dedup (distinctTokenIDs) so it burns exactly these tokens.
	distinct := dedupeCredentials(creds)
	// Hard ceiling on distinct tokens verified per event: bounds RSA-verification CPU even for an
	// attacker with a large real token supply, and sits well above any legitimate weight-priced cost.
	if len(distinct) > maxTokenPairsPerEvent {
		return true, reason(codeTooManyTokens, fmt.Sprintf("blocked: too many distinct tokens (%d, max %d)", len(distinct), maxTokenPairsPerEvent))
	}
	// Verify each DISTINCT (token, sig) pair once — a forged pair ANYWHERE is a hard reject, so an
	// attacker can't pad `need` with junk. The all-or-nothing commit (CommitSpend) plus this dedup is
	// what makes "pay by size" un-gameable. Route the key set by the post's media-domain claim
	// (stiq_dom): a post claiming `picture`/`audio` must carry tokens signed under that domain's write
	// key (asks #3/#4). Falls back to the general posting keys for an unclaimed post or an unconfigured
	// domain, so this is byte-identical until the operator supplies media write keys.
	postingKeys := m.postingKeysForDomain(blindDomain(event))
	for _, cred := range distinct {
		if !membership.VerifyAny(postingKeys, cred) {
			return true, reason(codeTokenInvalid, "blocked: invalid blind-post token")
		}
	}
	if len(distinct) < need {
		return true, reason(codeTokenInsufficient, fmt.Sprintf("blocked: event needs %d tokens, has %d", need, len(distinct)))
	}
	// Bound the number of stiq_spend tags UNCONDITIONALLY — even in dark mode where the full holder
	// proof below is skipped. stiq_spend tags are weight-exempt (weight.go chargeableSize), so an
	// unbounded count is a free, unpriced payload channel: a member with one token could pad
	// max_event_bytes of junk into stiq_spend tags for a TokenCost of 1, defeating weight-pricing.
	// Count RAW tags by name (spendTagCount), NOT decoded proofs — weight exemption keys on the tag
	// NAME, so undecodable-base64 padding is weight-exempt too and must be bounded here. A conformant
	// client emits at most one proof per token beyond token 0; a pre-P3 bearer client emits zero
	// (still passes). Excess ⇒ reject, independent of holderProofRequired.
	if spendTagCount(event) > len(creds)-1 {
		return true, reason(codeHolderProofInvalid, "blocked: too many holder proofs")
	}
	// P3 holder-bound-token proof (ships dark, gated on holderProofRequired): runs AFTER the RSA
	// issuer-signature loop above and BEFORE SpendAllForEvent below, so a failed proof never spends
	// a token. Uses the POSITIONAL (non-deduped) creds so stiq_spend[i-1] pairs with the i-th
	// stiq_token exactly as the client emitted them — see checkHolderProof.
	m.mu.RLock()
	holderProofReq := m.holderProofRequired
	m.mu.RUnlock()
	if holderProofReq {
		if reject, hpMsg := m.checkHolderProof(event, creds); reject {
			return true, hpMsg
		}
	}
	// VERIFY ONLY: exactly `need` distinct tokens are committed later, all-or-nothing, by CommitSpend
	// (the final reject hook) — never here — so a subsequent organizer/ratelimit/group reject can't
	// abandon a spent token on an event that is never stored (F1). Spend semantics are unchanged: a
	// retry of the exact signed event is idempotent; a different event reusing any token is rejected;
	// extra tokens beyond `need` stay unspent.
	return false, ""
}

// extractCredentials returns every (stiq_token, stiq_sig) pair carried by the event, paired
// positionally (the i-th token with the i-th sig). A weight-priced event carries N pairs; a plain
// post carries one. Each pair is verified in handleBlindPost — a wrong pairing simply fails
// verification, so positional pairing needs no cross-check here.
func extractCredentials(event *nostr.Event) []membership.Credential {
	var tokens, sigs [][]byte
	for _, tag := range event.Tags {
		if len(tag) < 2 {
			continue
		}
		switch tag[0] {
		case tagToken:
			if b, err := base64.StdEncoding.DecodeString(tag[1]); err == nil {
				tokens = append(tokens, b)
			}
		case tagSig:
			if b, err := base64.StdEncoding.DecodeString(tag[1]); err == nil {
				sigs = append(sigs, b)
			}
		}
	}
	n := len(tokens)
	if len(sigs) < n {
		n = len(sigs)
	}
	creds := make([]membership.Credential, 0, n)
	for i := 0; i < n; i++ {
		creds = append(creds, membership.Credential{Token: tokens[i], Signature: sigs[i]})
	}
	return creds
}

// dedupeCredentials returns creds with duplicate tokens removed, in first-seen order — the exact set
// the verify phase RSA-checks (gateSpaceTokens / handleBlindPost) and the commit phase spends
// (distinctTokenIDs). TokenID is a cheap sha256, so a token repeated to fake the weight-priced count
// (or to force N RSA verifications) collapses to one entry here and is counted / verified once
// (findings #36/#73). Both phases route through THIS one helper so their dedup can never diverge.
func dedupeCredentials(creds []membership.Credential) []membership.Credential {
	distinct := make([]membership.Credential, 0, len(creds))
	seen := make(map[string]struct{}, len(creds))
	for _, cred := range creds {
		id := membership.TokenID(cred.Token)
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		distinct = append(distinct, cred)
	}
	return distinct
}

// distinctTokenIDs returns the deduplicated token IDs the event carries, first-seen order — the same
// list (and order) the verify phase validated, so CommitSpend can burn ids[:need] without re-running
// RSA verification. Deterministic: rebuilt purely from the event's tags, matching the verify phase's
// `distinct` slice element-for-element.
func distinctTokenIDs(event *nostr.Event) []string {
	distinct := dedupeCredentials(extractCredentials(event))
	ids := make([]string, len(distinct))
	for i, cred := range distinct {
		ids[i] = membership.TokenID(cred.Token)
	}
	return ids
}

// extractSpendProofs returns every stiq_spend proof carried by the event, in tag order — a
// weight-priced holder-bound post carries N-1 proofs (one per token after token 0). Mirrors the
// extractCredentials decode-and-skip idiom: an undecodable base64 entry is silently dropped rather
// than aborting, so the positional pairing check below simply fails closed on it.
func extractSpendProofs(event *nostr.Event) [][]byte {
	var proofs [][]byte
	for _, tag := range event.Tags {
		if len(tag) < 2 || tag[0] != tagSpend {
			continue
		}
		if b, err := base64.StdEncoding.DecodeString(tag[1]); err == nil {
			proofs = append(proofs, b)
		}
	}
	return proofs
}

// spendTagCount counts EVERY stiq_spend tag by NAME — including undecodable-base64 ones that
// extractSpendProofs silently drops. The weight exemption (weight.go chargeableSize) keys on the tag
// name, so the free-byte bound in handleBlindPost must too: otherwise an attacker could pad
// garbage-base64 stiq_spend tags that are weight-exempt yet invisible to the decoded-proof count.
func spendTagCount(event *nostr.Event) int {
	n := 0
	for _, tag := range event.Tags {
		if len(tag) >= 1 && tag[0] == tagSpend {
			n++
		}
	}
	return n
}

// spendMessage computes the 32-byte digest a P3 holder-bound spend proof (token i>=1) signs:
// sha256(spendDomain || evPub), where evPub is the 32 RAW bytes of event.pubkey (NOT hex). Bound to
// the event's own pubkey (fixed before any stiq_spend tag exists), never event.id, avoiding a
// tag-in-preimage circularity. MUST be byte-identical to the client's blind/holderProof.ts
// spendMessage — see the shared spend-message contract (both sides independently compute this;
// they share no file).
func spendMessage(evPub []byte) [32]byte {
	return sha256.Sum256(append([]byte(spendDomain), evPub...))
}

// checkHolderProof verifies the P3 positional holder-bound-token proof chain for a blind post.
// creds is the FULL positional (non-deduped) credential list from extractCredentials, in the exact
// tag order the client emitted stiq_token/stiq_sig pairs — pairing must use this, not the
// de-duplicated `distinct` slice, or a legitimate proof would land on the wrong token.
//
//   - Token 0 (creds[0]) MUST equal event.pubkey (raw bytes): this is the event's own signer, so its
//     holder-proof is the event's own BIP-340 signature, already verified by RequireValidSignature —
//     which the hook-order regression test pins as running BEFORE membership, so this shortcut can
//     never be forged by an invalid-signature event reaching here (crypto red-team mustFix #3).
//   - Each further token i>=1 must carry a stiq_spend proof at proofs[i-1] that verifies over
//     spendMessage(event.pubkey) under that token's x-only pubkey.
//
// O(n): one schnorr verify per token beyond the first — deliberately NOT an any-proof-matches-
// any-token search, which would be a pre-ratelimit CPU-DoS (crypto red-team mustFix #2).
func (m *Membership) checkHolderProof(event *nostr.Event, creds []membership.Credential) (reject bool, msg string) {
	proofs := extractSpendProofs(event)
	if len(creds) > maxTokenPairsPerEvent || len(proofs) > maxTokenPairsPerEvent {
		return true, reason(codeHolderProofInvalid, "blocked: too many holder proofs")
	}
	// A conformant client emits EXACTLY one stiq_spend per token i>=1 (single-token posts carry
	// none). Requiring strict equality closes a free-byte channel: stiq_spend tags are weight-exempt
	// (weight.go), so extra/unpaired proofs would otherwise be unpriced, unverified payload.
	if len(proofs) != len(creds)-1 {
		return true, reason(codeHolderProofInvalid, "blocked: holder proof count mismatch")
	}
	evPub, err := hex.DecodeString(event.PubKey)
	if err != nil || len(evPub) != 32 {
		return true, reason(codeHolderProofInvalid, "blocked: malformed event pubkey")
	}
	digest := spendMessage(evPub)
	for i, cred := range creds {
		if i == 0 {
			// Token 0 must BE the event's own signer — proven for free by RequireValidSignature.
			if !bytes.Equal(cred.Token, evPub) {
				return true, reason(codeHolderProofInvalid, "blocked: token 0 must sign the event")
			}
			continue
		}
		if i-1 >= len(proofs) {
			return true, reason(codeHolderProofInvalid, "blocked: missing holder proof")
		}
		pub, err := schnorr.ParsePubKey(cred.Token)
		if err != nil {
			return true, reason(codeHolderProofInvalid, "blocked: invalid token holder pubkey")
		}
		sig, err := schnorr.ParseSignature(proofs[i-1])
		if err != nil || !sig.Verify(digest[:], pub) {
			return true, reason(codeHolderProofInvalid, "blocked: invalid token holder proof")
		}
	}
	return false, ""
}

// hasToken reports whether the event carries a per-post anti-spam token tag. The kind-9011
// binding event also carries this tag but is handled earlier in RejectEvent, so this only ever
// classifies content events as blind posts.
func hasToken(event *nostr.Event) bool {
	_, ok := tagValue(event, tagToken)
	return ok
}

// spaceTokensEnforced reports whether the space-write token requirement is live: the operator
// flipped spaceTokensRequired AND supplied the space-write issuer keys. Both are needed — the flag
// without keys could never be satisfied and would brick every space.
func (m *Membership) spaceTokensEnforced() bool {
	m.mu.RLock()
	required := m.spaceTokensRequired
	haveKeys := len(m.spaceWriteIssuers) > 0
	m.mu.RUnlock()
	return required && haveKeys
}

// gateSpaceTokens is the tokens-everywhere admission gate for member space content (channel/group
// messages, h-tagged group reactions, DM gift wraps). It is ADDITIVE: the caller still runs the
// normal admission for the event's shape afterwards (bound-npub tail, or the gift-wrap PoW gate).
//
//   - No tokens attached: admit when enforcement is off (dark — byte-identical to today); reject
//     with codeSpaceTokenRequired when on.
//   - Tokens attached: they MUST verify against the space-write issuer keys and carry a FULL
//     all-proofs stiq_spend chain, then be spent — junk tokens are never a free rider (a token-
//     tagged event short-circuits the per-npub rate limiter, so unverified tokens would otherwise
//     be a rate-limit bypass). With no space keys configured a token-tagged space event is
//     rejected, mirroring how handleBlindPost's kind gate rejected these before this feature.
//
// The space chain differs from the blind chain in exactly one structural rule: the event is signed
// by the member's npub (or the wrap's ephemeral key) — NO token equals event.pubkey — so EVERY
// token carries an explicit proof (len(proofs) == len(tokens)), each a BIP-340 signature over
// spendMessage(event.pubkey) under that token's x-only pubkey. There is no dark/bearer mode for
// this chain: it is born holder-bound (no legacy clients exist to migrate).
//
// NOTE on spend timing (finding F1 fix): this gate now VERIFIES ONLY — it never spends. The token
// is committed to the spent-set later, in CommitSpend (the final reject hook), AFTER the organizer /
// ratelimit / GroupGuard hooks have all passed. So an event refused by a later hook (e.g. GroupGuard
// on a mid-flight kick/close race the client can't see) no longer leaves a paid-but-abandoned token.
func (m *Membership) gateSpaceTokens(event *nostr.Event) (reject bool, msg string) {
	if !hasToken(event) {
		if m.spaceTokensEnforced() {
			return true, reason(codeSpaceTokenRequired, "blocked: this community requires a space token for this content")
		}
		return false, ""
	}
	// Snapshot the hot-reloadable space-write key set + weight price together under one RLock. The
	// slice header is copied, so a concurrent SIGHUP reload (UpdateSpaceWriteIssuers swaps the whole
	// slice, never mutates in place) can't race this verification.
	m.mu.RLock()
	issuers := m.spaceWriteIssuers
	bytesPerToken := m.bytesPerToken
	m.mu.RUnlock()
	if len(issuers) == 0 {
		return true, reason(codeKindNotPermitted, fmt.Sprintf("blocked: event kind %d does not accept tokens here", event.Kind))
	}
	need := TokenCost(event, bytesPerToken)

	creds := extractCredentials(event)
	if len(creds) == 0 {
		return true, reason(codeTokenMalformed, "blocked: malformed space token")
	}
	// De-duplicate by TokenID BEFORE any RSA verification, exactly like handleBlindPost (findings
	// #36/#73): a token repeated N times counts once and is verified once. CommitSpend recomputes the
	// identical dedup (distinctTokenIDs, same first-seen order), so the tokens it later burns are
	// exactly the ones verified here.
	distinct := dedupeCredentials(creds)
	if len(distinct) > maxTokenPairsPerEvent {
		return true, reason(codeTooManyTokens, fmt.Sprintf("blocked: too many distinct tokens (%d, max %d)", len(distinct), maxTokenPairsPerEvent))
	}
	for _, cred := range distinct {
		if !membership.VerifyAny(issuers, cred) {
			return true, reason(codeTokenInvalid, "blocked: invalid space token")
		}
	}
	if len(distinct) < need {
		return true, reason(codeTokenInsufficient, fmt.Sprintf("blocked: event needs %d tokens, has %d", need, len(distinct)))
	}
	// The all-proofs holder chain — verified here (in the membership hook) so a bad proof rejects
	// early, before the costly organizer/group hooks.
	if reject, msg := checkAllSpendProofs(event, creds); reject {
		return true, msg
	}
	// VERIFY ONLY: the spend is committed by CommitSpend (the FINAL reject hook), never here — so a
	// later organizer/ratelimit/group reject can't abandon a spent token on an unstored event (F1).
	return false, ""
}

// checkAllSpendProofs verifies the tokens-everywhere spend-proof chain: EVERY positional token i
// must carry a stiq_spend proof at proofs[i] — a BIP-340 signature over spendMessage(event.pubkey)
// under that token's x-only pubkey — because the event's signer is the member's npub (or a DM
// wrap's ephemeral key), never a token. Contrast checkHolderProof (blind path), where token 0 IS
// the signer and is proof-free. Strict counting closes the free-byte channel exactly as there:
// stiq_spend tags are weight-exempt, so the RAW tag count (spendTagCount — including undecodable
// base64 padding) must equal the token count, and every proof must decode and verify. O(n): one
// schnorr verify per token, positionally paired — never an any-proof-matches-any-token search.
func checkAllSpendProofs(event *nostr.Event, creds []membership.Credential) (reject bool, msg string) {
	if len(creds) > maxTokenPairsPerEvent {
		return true, reason(codeHolderProofInvalid, "blocked: too many holder proofs")
	}
	proofs := extractSpendProofs(event)
	if spendTagCount(event) != len(creds) || len(proofs) != len(creds) {
		return true, reason(codeHolderProofInvalid, "blocked: space proof count mismatch")
	}
	evPub, err := hex.DecodeString(event.PubKey)
	if err != nil || len(evPub) != 32 {
		return true, reason(codeHolderProofInvalid, "blocked: malformed event pubkey")
	}
	digest := spendMessage(evPub)
	for i, cred := range creds {
		pub, err := schnorr.ParsePubKey(cred.Token)
		if err != nil {
			return true, reason(codeHolderProofInvalid, "blocked: invalid token holder pubkey")
		}
		sig, err := schnorr.ParseSignature(proofs[i])
		if err != nil || !sig.Verify(digest[:], pub) {
			return true, reason(codeHolderProofInvalid, "blocked: invalid token holder proof")
		}
	}
	return false, ""
}

func (m *Membership) handleBinding(event *nostr.Event) (reject bool, msg string) {
	cred, ok := extractCredential(event)
	if !ok {
		return true, reason(codeBindingMalformed, "blocked: malformed membership binding")
	}
	// Verify against the DEDICATED binding issuers when configured (domain separation, finding #16):
	// a per-post/read/draw token — signed by the general issuer key — must NOT satisfy a binding.
	if !membership.VerifyAny(m.bindingKeys(), cred) {
		return true, reason(codeCredentialInvalid, "blocked: invalid membership credential")
	}
	id := membership.TokenID(cred.Token)
	// Idempotent fast-path: this device already completed its binding (e.g. an earlier attempt whose OK
	// frame was lost in transit). It is already a member, so the event changes nothing — but the
	// credential it presents must still be BURNED (R2c). Returning here without spending left a member
	// holding a SECOND invite able to bind once, re-present the spare, have it accepted, and keep it
	// fully usable to mint ANOTHER npub later — which is exactly the scarcity premise the member roll
	// rests on (one enrolled npub per organizer-issued invite).
	//
	// Bind is safe to call here: for a credential this same pubkey already owns it converges
	// idempotently, and boundAt is preserved (markBoundAt), so re-binding never resets the member's
	// newcomer seniority. ErrTokenSpent means a DIFFERENT device owns the presented credential — a
	// replay that mints nothing, since this npub is already bound — so admit either way. An I/O
	// failure likewise leaves membership unchanged; the credential simply stays unburned, exactly as
	// it always did before this.
	if m.store.IsBound(event.PubKey) {
		_ = m.store.Bind(id, event.PubKey)
		return false, ""
	}
	// Bind is the authoritative double-spend guard: it re-checks spent-ness under its write lock and
	// binds the credential's spent-record to THIS pubkey, returning ErrTokenSpent only when a DIFFERENT
	// device already owns it (the double-spend race, PLAN.md §3.3). We deliberately do NOT short-circuit
	// on a bare IsSpent(id) here: store.Bind binds the record to the owning pubkey, so a credential whose
	// spend persisted but whose bound-state save() failed must stay completable by the SAME device — a
	// stale IsSpent short-circuit would lock that member out permanently (finding R2). ErrTokenSpent from
	// Bind is treated as "already used", not a server error, so one credential can never mint two accounts.
	if err := m.store.Bind(id, event.PubKey); err != nil {
		if errors.Is(err, membership.ErrTokenSpent) {
			return true, reason(codeCredentialUsed, "blocked: membership credential already used")
		}
		return true, reason(codeRecordMembershipError, "error: could not record membership")
	}
	return false, ""
}

func extractCredential(event *nostr.Event) (membership.Credential, bool) {
	tokenB64, ok := tagValue(event, tagToken)
	if !ok {
		return membership.Credential{}, false
	}
	sigB64, ok := tagValue(event, tagSig)
	if !ok {
		return membership.Credential{}, false
	}
	token, err := base64.StdEncoding.DecodeString(tokenB64)
	if err != nil {
		return membership.Credential{}, false
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return membership.Credential{}, false
	}
	return membership.Credential{Token: token, Signature: sig}, true
}

func tagValue(event *nostr.Event, name string) (string, bool) {
	for _, tag := range event.Tags {
		if len(tag) >= 2 && tag[0] == name {
			return tag[1], true
		}
	}
	return "", false
}
