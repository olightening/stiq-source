// Package config loads the relay's issuer keys, membership store path, and listen address.
package config

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"os"
)

// DefaultAllowedKinds are the event kinds the relay accepts from bound members:
//
//	0 (profile), 1 (posts/NIP-22 comments), 7 (votes), 40/41/42 (NIP-28 channels, §3.7),
//	1111 (NIP-22 comments), 1984 (reports), 1986 (double-spend witness, P4 — admitted like a report),
//	1018/1068 (NIP-88 polls), 1311 (NIP-53 live chat), 10000 (NIP-51 mute list / owner block
//	list), 10003 (NIP-51 bookmark list / saved posts), 10009 (NIP-51 channel subscriptions),
//	30023 (NIP-23 long-form),
//	30023 (NIP-23 long-form), 30078 (NIP-78 organizer moderation config + tag policy), 30311
//	(NIP-53 live activity / channel), 30079 (private-space E2E key delivery, PLAN.md §8 — an
//	addressable, member-published NIP-44-wrapped key handoff; the relay only ever sees ciphertext).
//
// NIP-29 relay-managed groups: 9/11/12 (group chat/threads), 9000-9007 + 9021/9022 (group
//
//	management), 39000-39003 (relay-generated group state). Membership/role enforcement is
//	applied by policy.GroupGuard; the 39000-39003 state is written only by the relay itself
//	(the guard rejects member-submitted state), so allow-listing them here is safe.
//
// 1987/30500 (client draft-sharing pair: draft access request / draft access delivery) were live on
// prod's hand-edited explicit allowed_kinds before this constant carried them (added 2026-07-29,
// rate-limit default-deny audit).
//
// kind 1059 (DM gift wrap) goes through the PoW path, not this list. The membership-binding
// kind is handled separately.
// DefaultMaxEventBytes and DefaultMaxTagsPerEvent are the content-neutral weight caps applied
// when the config leaves them unset (0), bounding an oversized event before it can strain the
// parser; 1000 tags is far above any legitimate post while still blocking a tag-flood.
// DefaultMaxEventBytes is also the fallback relayapp.New derives the khatru websocket transport's
// MaxMessageSize from (+ 64KiB headroom) when max_event_bytes is left unset — the two ceilings must
// stay in lockstep or frames near the cap get silently dropped by the transport (see relay.go).
const (
	DefaultMaxEventBytes   = 64 * 1024
	DefaultMaxTagsPerEvent = 1000
)

// SchemaVersion is the stiq config/wire schema version advertised to clients in the NIP-11
// `stiq-capabilities` block (relayapp.StiqCapabilities). A client reads it to decide whether it
// understands the relay's stiq extensions before speaking them. Bump it only on a
// backward-incompatible change to that advertised shape.
const SchemaVersion = 1

var DefaultAllowedKinds = []int{
	0, 1, 7, 40, 41, 42, 1018, 1068, 1111, 1222, 1244, 1311, 1984, 10000, 10003, 10009, 30023, 30078, 30079, 30311,
	// 1986 (double-spend witness): a member-signed, self-verifying conflict proof (P4). Admitted like a
	// report via the bound-member path; consumers re-derive the conflict before hiding, so the relay
	// grants it no trust — it only stores/serves it so mirrors and clients can share the signal.
	1986,
	// 9026 (read-meter unlock request) / 9027 (organizer-signed unlock response): the encrypted-content
	// read-token mailbox pair, store-and-forward like the enroll/draw mailbox and PoW-gated in policy.
	9026, 9027,
	// 30351 (media blob): the base64 payload of ONE inline picture or voice clip, split out of the
	// post body so it is fetched by id ON TAP instead of riding the feed firehose (bug round
	// 2026-07-15 — inline media forced every member to download every picture/voice clip over Tor,
	// tapped or not). Deliberately ONE generic kind, never picture/voice-specific: the relay learns
	// "some media", never which. The blob carries NO tags — no back-reference to its post, no
	// modality marker — and is signed by its own throwaway key, so (kind, pubkey, d="") is unique
	// per blob and the addressable range's ReplaceEvent semantics can never collapse two blobs into
	// one. It is intentionally NOT in the client's firehose kind set (contracts/index.ts's
	// FETCH_ONLY_KINDS); a REQ by id is the only way it is ever served. Bytes are unchanged in
	// aggregate — they merely moved out of the kind-1 body — so max_event_bytes (512KB, set by
	// deploy/stiq-up.sh to clear a ~267KB voice note) already covers the largest blob.
	30351,
	// 31923 (NIP-52 calendar event doc): addressable, signed by the HOST's bound npub — attribution
	// is the point (an event has an organizer). Content is the event's PUBLIC fields only; the exact
	// address / entry notes / stream link ride encrypted DMs post-approval, so the relay never sees
	// them. Edits/cancel/going-count bumps are addressable republishes of the same (pubkey, d).
	// 31925 (event "interested" RSVP): the reaction of the events surface — rides the BLIND token
	// path when blind_required (see policy.blindContentKinds), so the relay never learns who is
	// interested in what; counts are a client-side tally deduped per real author.
	31923, 31925,
	9, 11, 12,
	9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009, 9021, 9022,
	39000, 39001, 39002, 39003, 39004, 39005,
	// 1987 (draft access request) / 30500 (draft access delivery): client/src/contracts/index.ts
	// Kind.DraftAccessRequest / Kind.DraftDelivery — the client-side draft-sharing pair. Live on prod's
	// hand-edited explicit allowed_kinds before this addition (verified read-only 2026-07-29); this
	// brings the repo's source-of-truth constant in line with what prod already admits (rate-limit
	// default-deny audit, 2026-07-29).
	1987, 30500,
}

// NOTE: voice kinds 1222/1244 are allow-listed here so bound members may publish them, but the
// ConfigHolder gate rejects them unless the organizer's limits policy sets allow_voice=true.

// Config is the on-disk relay configuration.
type Config struct {
	Listen string `json:"listen"`
	// PEM-encoded RSA issuer public keys (PLAN.md §3.3). A member's credential must verify
	// under one of these. Multiple keys support issuer-key rotation.
	IssuerPublicKeys []string `json:"issuer_public_keys"`
	// BindingIssuerPublicKeys, when non-empty, are the ONLY keys accepted for a kind-9011 membership
	// binding — the scarce, invite-gated enrollment credential. This enforces token domain separation
	// (finding #16): posting/read/draw tokens are minted far more liberally than enrollment
	// credentials, and because a bare RSA-PSS credential carries no type/context, the relay cannot
	// otherwise tell them apart — so a plentiful posting token would double as a membership-binding
	// credential (Sybil / ban-evasion). Empty ⇒ fall back to IssuerPublicKeys (backward compatible);
	// this only closes the hole once the ORGANIZER signs enrollment credentials under a DISTINCT key
	// whose public half is supplied here. See the cross-layer note in the audit for findings #3/#4.
	BindingIssuerPublicKeys []string `json:"binding_issuer_public_keys"`
	// PostingIssuerPublicKeys, when non-empty, are the ONLY keys accepted for a per-post blind token
	// (handleBlindPost). This is the posting half of token domain separation (finding #16), symmetric
	// to BindingIssuerPublicKeys: once the organizer mints posting/read/draw tokens under a key that is
	// DISTINCT from the scarce enrollment credential, supplying its public half here verifies posting
	// tokens against ONLY it. Empty ⇒ fall back to IssuerPublicKeys (backward compatible; the default).
	// Providing this field is the relay half of the domain-sep rollout; it is a no-op until the
	// organizer signs posting tokens under a separate key, so the intended flag flip no longer forces
	// operators to REPURPOSE issuer_public_keys (which would brick every existing bound member's
	// posting/binding). See the cross-layer note for findings #3/#4/#16.
	PostingIssuerPublicKeys []string `json:"posting_issuer_public_keys"`
	// PictureWriteIssuerPublicKeys / AudioWriteIssuerPublicKeys extend posting-token domain separation
	// to media (asks #3/#4): when non-empty, a blind post whose relay-visible `stiq_dom` tag CLAIMS
	// that media domain (`picture` / `audio`) must carry a token signed under THIS key set, not the
	// general posting key. Empty ⇒ that domain falls back to PostingIssuerPublicKeys (then
	// IssuerPublicKeys), byte-identical to today. The relay is content-blind, so this enforces the
	// CLAIMED domain only (a post that omits the tag pays with a post token); the real per-media
	// ceiling is the organizer's per-(credential, purpose, epoch) draw quota. Read domains never touch
	// relay admission (reads are metered at the organizer), so there is no picture/audio READ key here.
	PictureWriteIssuerPublicKeys []string `json:"picture_write_issuer_public_keys"`
	AudioWriteIssuerPublicKeys   []string `json:"audio_write_issuer_public_keys"`
	// MediaTokensEnabled gates the ADVERTISEMENT of the media write domains (media_write_domains in
	// NIP-11 stiq-capabilities). The keys above load at startup (and, since T1.1, can ALSO be
	// hot-reloaded via SIGHUP — see relayapp.Reloader.Apply / Membership.UpdatePictureWriteIssuers /
	// UpdateAudioWriteIssuers) so the relay can always VERIFY a stiq_dom-claiming post, but a client
	// only ATTACHES media tokens (with stiq_dom) when the domain is advertised — so this bool is the
	// dashboard-flippable ON/OFF for media token domains without a relay restart, independent of
	// whether the underlying keys themselves changed this reload. false (default) ⇒ domains
	// unadvertised ⇒ media blobs pay from the post wallet, byte-identical to today. SIGHUP-reloadable
	// (read live by StiqCapabilities from Reloader.Config). Enabling is SOFT (updated clients opt in,
	// old clients unaffected, media-wallet exhaustion falls back to post tokens), not a fleet-break.
	MediaTokensEnabled bool `json:"media_tokens_enabled"`
	// SpaceWriteIssuerPublicKeys (tokens-everywhere): the issuer key set for SPACE-WRITE tokens —
	// the blind anti-spam tokens attached to BOUND-NPUB space content (channel messages 1311/42,
	// group chat/replies 9/11/12, h-tagged group reactions, DM gift wraps 1059). The event stays
	// signed by the member's npub (roles + attribution intact — or the wrap's ephemeral key for
	// DMs); the tokens prove the spam price was paid without revealing whose they are, verified via
	// an ALL-PROOFS stiq_spend chain (every token carries a proof — no token equals event.pubkey,
	// unlike the blind path). Empty ⇒ token-tagged space kinds stay rejected exactly as today.
	SpaceWriteIssuerPublicKeys []string `json:"space_write_issuer_public_keys"`
	AllowedKinds               []int    `json:"allowed_kinds"`
	// AllowedKindsExplicit records that the config FILE set allowed_kinds, rather than Load
	// substituting DefaultAllowedKinds. Derived at load, never serialized — it exists so startup can
	// tell the operator which defaults their explicit list omits (see MissingDefaultKinds).
	AllowedKindsExplicit bool `json:"-"`
	// OrganizerPubkeys are the hex Nostr pubkeys of the community organizer(s) (PLAN.md §3.4).
	// Their kind-30078 `stiq:` config events (moderator roster + rate-limit policy) are the
	// relay's moderation trust root; they are also exempt from the membership gate.
	OrganizerPubkeys []string `json:"organizer_pubkeys"`
	// DataDir, when set, enables persistent event storage (badger).
	DataDir string `json:"data_dir"`
	// FDroidRepoDir, when set, enables the relay to statically serve an F-Droid-format update
	// repository under /fdroid/ on the SAME loopback mux the onion targets (T9 in-app signed APK
	// updates over Tor). Empty (the default) leaves the route UNREGISTERED — the feature ships dark
	// and relay behaviour is byte-identical (a /fdroid/ GET falls through to khatru's 404). Load
	// performs NO default substitution (mirrors DataDir). RESTART-ONLY (same class as DataDir): it
	// is read once at boot in main.go and is intentionally NOT in the SIGHUP hot-reload set. The
	// relay stays author-blind: it only streams file bytes and performs no content inspection; the
	// client verifies the signed index-v1.jar + pinned cert, granting the relay zero trust.
	FDroidRepoDir string `json:"fdroid_repo_dir"`
	// MembershipFile persists the spent-token and bound-npub sets. Empty = in-memory only.
	MembershipFile string `json:"membership_file"`
	// PoWDifficulty is the NIP-13 leading-zero-bit difficulty required on kind-1059 gift
	// wraps (NIP-17 DMs). 0 disables DMs (PLAN.md §4.1).
	PoWDifficulty int `json:"pow_difficulty"`
	// EnrollPoW is the NIP-13 difficulty required on the credential-exchange mailbox events
	// (kinds 9020/9023, PLAN.md §3.3 smoother-onboarding). It is typically LOWER than
	// PoWDifficulty so a phone can mine an enrollment request without the native miner. 0 falls
	// back to PoWDifficulty. The client's ENROLL_POW_DIFFICULTY must match this value.
	EnrollPoW int `json:"enroll_pow"`
	// MaxLimit caps the `limit` field of any incoming REQ filter (NIP-11 Limitation.MaxLimit).
	// A client requesting more than this gets the cap silently applied. 0 = no cap.
	MaxLimit int `json:"max_limit"`
	// DefaultLimit is applied to REQ filters that carry no limit at all. Prevents a single
	// subscription from replaying unbounded history. 0 = let the storage backend decide.
	DefaultLimit int `json:"default_limit"`
	// MaxEventBytes caps the approximate serialized size (content + tags) of any stored event —
	// the content-neutral "weight" half of the blind door (PLAN.md §3.4). It needs no identity,
	// so it applies to blind posts and bound-member events alike. 0 in the file defaults to
	// DefaultMaxEventBytes; set explicitly to tune. Advertised via NIP-11 max_content_length.
	MaxEventBytes int `json:"max_event_bytes"`
	// MaxTagsPerEvent caps the number of tags on any stored event (blocks tag-flood DoS). 0 in
	// the file defaults to DefaultMaxTagsPerEvent. Advertised via NIP-11 max_event_tags.
	MaxTagsPerEvent int `json:"max_tags_per_event"`
	// BytesPerToken turns on WEIGHT-PRICED anti-spam tokens: a blind post must carry one token per
	// bytesPerToken of its chargeable weight (content + non-token tags), floored at one. This makes
	// pictures/audio (which ride inline as base64 in content) cost proportionally more tokens with
	// no content-type awareness on the relay, so the per-epoch token cap becomes a single un-gameable
	// data budget. 0 (the default) DISABLES it — every event costs exactly one token, byte-identical
	// to the legacy behaviour. Flipping it on (>0) rejects single-token posts from un-upgraded
	// clients, so it is a deliberate clients-first migration and MUST stay 0 until the community's
	// apps are updated. NOT auto-defaulted (0 is a valid, meaningful value).
	BytesPerToken int `json:"bytes_per_token"`
	// BlindRequired closes the bound-npub bypass: when true, the relay REQUIRES the blind token path
	// for blind-eligible content kinds (notes, reactions, comments, articles, polls, voice), so a
	// bound npub can no longer publish those tokenless (which would re-link authors and skip the
	// per-post anti-spam budget). Channels, groups, profiles, reports, lists, DMs, config, and the
	// one-time membership binding are unaffected. false (the default) ships DARK — byte-identical to
	// before — so it is a deliberate clients-first flip, enabled only once the community's apps
	// blind-post all content (the current client already does). NOT auto-defaulted.
	BlindRequired bool `json:"blind_required"`
	// HolderProofRequired turns on P3 holder-bound-token verification: the relay requires token 0 of
	// a blind post to equal event.pubkey (the token that signed the event) and every further token to
	// carry a positionally-paired stiq_spend BIP-340 proof (policy.Membership.checkHolderProof).
	// false (the default) ships DARK — byte-identical to before: stiq_spend tags are ignored and
	// token 0 need not equal event.pubkey, so pre-P3 bearer-token clients keep posting unchanged.
	// This is a deliberate, CLIENTS-FIRST migration flip (mirrors BlindRequired above): enable only
	// once the community's clients mint holder-bound tokens (Q = schnorr.getPublicKey(q)), typically
	// alongside a K_post rotation at an epoch boundary so old bearer tokens are discarded together
	// (see wallet.ts reconcileKey / the isStoredToken 'k'-field filter on the client side).
	HolderProofRequired bool `json:"holder_proof_required"`
	// PrivateGroupReadAuth turns on read enforcement for NIP-29 groups marked `private` (finding
	// #38). When false (the default) the `private` flag is metadata only — the relay CANNOT enforce
	// member-only reads because it runs no NIP-42 AUTH and thus can't identify the querier, so private
	// content must be protected by client-side encryption. When true, the relay requires a querier of
	// a private group's content kinds to be an AUTHENTICATED member (NIP-42), rejecting others.
	// SHIPS DARK: enabling it REQUIRES clients to implement NIP-42 AUTH, or their private-group reads
	// break — a deliberate, coordinated clients-first flip (see the cross-layer note for finding #38).
	PrivateGroupReadAuth bool `json:"private_group_read_auth"`
	// ContentEncryption advertises the content-encryption read meter (#4): community posts may be
	// sealed under a rotating content-epoch key and unlocked via the blind read-token meter. The relay
	// itself only ADVERTISES this — it stores opaque sealed bytes and never sees plaintext or keys; the
	// meter lives entirely at the organizer. It is the single master switch the client gates the whole
	// read-meter subsystem on. SHIPS DARK: false (default) → posts publish PLAINTEXT and the meter is
	// dormant, byte-identical to before. Enabling it is a coordinated clients-first flip (older clients
	// can't decrypt sealed bodies), exactly like BlindRequired/HolderProofRequired above.
	ContentEncryption bool `json:"content_encryption"`
	// SpaceTokensRequired (tokens-everywhere) closes the last unmetered write surfaces: when true,
	// member space content (channel messages, group chat/replies, h-tagged group reactions, DM gift
	// wraps) MUST carry space-write tokens (see SpaceWriteIssuerPublicKeys), so channels/groups/DMs
	// share the feed's token economics instead of (partly absent) per-npub rate windows. Control-
	// plane kinds (joins, leaves, adds/removes, metadata, key delivery, settings docs) are NEVER
	// token-taxed — a joiner has no wallet yet. false (the default) ships DARK — byte-identical
	// admission. A deliberate clients-first flip: enable only once the community's apps attach space
	// tokens (they do so when NIP-11 advertises this flag), else un-updated members' spaces break.
	SpaceTokensRequired bool `json:"space_tokens_required"`
	// ReadAuthRequired advertises censorable reads (#4): the organizer requires a READ-purpose token
	// draw to prove the member's npub (a reader-auth), so it can refuse a read-REVOKED member. The
	// relay only ADVERTISES this so clients attach the proof; it never touches read tokens itself
	// (enforcement is organizer-side). The WRITE path is never affected, so posting stays blind and
	// uncensorable (the most a mod can do to a poster is ban → advisory mod-log). Off by default →
	// read draws stay anonymous, byte-identical to before. Meaningful only alongside ContentEncryption.
	ReadAuthRequired bool `json:"read_auth_required"`
	// SafeBrowsingAPIKey enables the relay-proxied Google Safe Browsing reputation endpoint
	// (POST /safebrowsing). Empty disables it. Clients send only 4-byte URL-hash prefixes; the
	// relay forwards them to Google over Tor's SOCKS port (STIQ_TOR_SOCKS, default
	// 127.0.0.1:9050) so the lookup is anonymized and the URL itself never leaves the device.
	// Can also be supplied via the SAFE_BROWSING_API_KEY env var (preferred for secrets).
	SafeBrowsingAPIKey string `json:"safe_browsing_api_key"`
	// PushWatcherOnion and PushNtfyOnion are the .onion endpoints of the T1 keyless push circuit: the
	// pushwatcher's HTTP register API and the self-hosted ntfy the watcher pokes. They are PURELY
	// DESCRIPTIVE: the relay itself neither runs nor trusts either service — it only republishes these
	// two strings in NIP-11 stiq-capabilities.push so a client can discover the watcher to register
	// with and pin the ntfy host its endpoint must live under (relayapp.StiqCapabilities). Both default
	// to "" which means push is OFF (the push block is omitted from NIP-11 entirely); Load() performs NO
	// default substitution for them. They are RESTART-ONLY: unlike the moderation policy, they are NOT
	// in the SIGHUP hot-reload set, so changing them requires a relay restart to take effect.
	PushWatcherOnion string `json:"push_watcher_onion"`
	PushNtfyOnion    string `json:"push_ntfy_onion"`
	// WebsocketCompression toggles RFC 7692 permessage-deflate on the relay's WebSocket.
	//
	// It is a POINTER so the file can distinguish "not mentioned" (nil ⇒ the shipped default, ON)
	// from an explicit `"websocket_compression": false`. Read it through
	// WebsocketCompressionEnabled(), never directly.
	//
	// Leaving it ON is safe for an un-updated client fleet by protocol construction: the server only
	// ever compresses a connection whose client OFFERED the extension in its handshake
	// (Sec-WebSocket-Extensions). The shipped client's hand-rolled WebSocket sends no such header, so
	// its handshake response and every frame on it are byte-identical to a relay with this off. The
	// cost only arrives with a client that asks for it.
	//
	// It exists as a kill switch because the cost is MEMORY, and this relay's host is memory-tight:
	// the underlying library (fasthttp/websocket, a gorilla fork) compresses with a pooled
	// klauspost/compress flate.Writer, measured at ~810 KB of live heap each, held for the duration
	// of one outbound message. The pool bounds that by peak CONCURRENT writes rather than by
	// connection count (no-context-takeover is the only mode the library implements), but a burst of
	// simultaneous cold-start feed responses still costs ~0.8 MB per concurrently-writing connection.
	// If the box starts pressuring memory, set this false and SIGHUP will NOT pick it up — it is
	// restart-only (see relayapp.enableWebsocketCompression).
	//
	// RESTART-ONLY. khatru reads the upgrader once per handshake off an unsynchronised struct field;
	// swapping it under live traffic would be a data race, so it is deliberately not in Reloader.Apply.
	WebsocketCompression *bool `json:"websocket_compression"`
}

// DefaultWebsocketCompression is the shipped default for websocket_compression when the config file
// does not mention it. See Config.WebsocketCompression for why ON is safe for an un-updated fleet.
const DefaultWebsocketCompression = true

// WebsocketCompressionEnabled resolves the tri-state websocket_compression field: an absent key
// yields DefaultWebsocketCompression, an explicit true/false yields itself.
func (c Config) WebsocketCompressionEnabled() bool {
	if c.WebsocketCompression == nil {
		return DefaultWebsocketCompression
	}
	return *c.WebsocketCompression
}

// EffectiveMaxEventBytes / EffectiveMaxTagsPerEvent return the weight caps the relay actually
// enforces, substituting the shipped defaults for an unset (0) value exactly as Load does. Load
// already performs that substitution for a config read off disk, but Config values are also built
// directly in tests and by embedders, and the NIP-11 document must advertise the number that is
// really enforced in BOTH cases — an advertised cap that differs from the enforced one costs a Tor
// round-trip to discover.
func (c Config) EffectiveMaxEventBytes() int {
	if c.MaxEventBytes > 0 {
		return c.MaxEventBytes
	}
	return DefaultMaxEventBytes
}

func (c Config) EffectiveMaxTagsPerEvent() int {
	if c.MaxTagsPerEvent > 0 {
		return c.MaxTagsPerEvent
	}
	return DefaultMaxTagsPerEvent
}

func Load(path string) (Config, error) {
	var c Config
	data, err := os.ReadFile(path)
	if err != nil {
		return c, fmt.Errorf("read config: %w", err)
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, fmt.Errorf("parse config: %w", err)
	}
	// Fail loud on a malformed organizer pubkey. event.PubKey is always canonical 64-char lowercase
	// hex, so an organizer key that isn't (mixed-case, a typo, a truncated/npub-form value) would
	// SILENTLY never match any event author — locking the organizer out of publishing moderation
	// config while looking configured. Reject at startup instead, mirroring ParseIssuerKeys.
	for i, pk := range c.OrganizerPubkeys {
		if !isCanonicalPubkey(pk) {
			return c, fmt.Errorf("config: organizer_pubkeys[%d] %q must be exactly 64 lowercase hex chars "+
				"(a canonical Nostr pubkey); a mixed-case or malformed key silently never matches an event author", i, pk)
		}
	}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:3334"
	}
	if len(c.AllowedKinds) == 0 {
		c.AllowedKinds = DefaultAllowedKinds
	} else {
		c.AllowedKindsExplicit = true
	}
	if c.MaxEventBytes == 0 {
		c.MaxEventBytes = DefaultMaxEventBytes
	}
	if c.MaxTagsPerEvent == 0 {
		c.MaxTagsPerEvent = DefaultMaxTagsPerEvent
	}
	return c, nil
}

// minIssuerModulusBits is the smallest RSA modulus the relay will trust as an issuer key. The
// issuer keys are the SOLE trust root for every blind-token and credential verification, so a
// downgraded/undersized key silently weakens the entire unforgeability guarantee. 2048 bits is the
// current floor for RSA blind signatures.
const minIssuerModulusBits = 2048

// standardRSAExponent is the only public exponent the relay accepts. A non-standard exponent
// (e=1, or small e=3-class values) enables small-exponent forgery attacks; F4 is universal for
// blind-RSA issuance, so anything else signals a malformed or malicious key.
const standardRSAExponent = 65537

// ParseIssuerKeys decodes the PEM-encoded issuer public keys into RSA keys, rejecting any key whose
// modulus is below minIssuerModulusBits or whose exponent is not the standard F4 (65537), so a weak
// or downgraded issuer key can never be deployed silently. (finding #71)
func ParseIssuerKeys(pems []string) ([]*rsa.PublicKey, error) {
	keys := make([]*rsa.PublicKey, 0, len(pems))
	for i, p := range pems {
		block, _ := pem.Decode([]byte(p))
		if block == nil {
			return nil, fmt.Errorf("issuer key %d: not valid PEM", i)
		}
		pub, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("issuer key %d: %w", i, err)
		}
		rsaPub, ok := pub.(*rsa.PublicKey)
		if !ok {
			return nil, fmt.Errorf("issuer key %d: not an RSA key", i)
		}
		if bits := rsaPub.N.BitLen(); bits < minIssuerModulusBits {
			return nil, fmt.Errorf("issuer key %d: modulus is %d bits; refusing weak issuer key below %d bits", i, bits, minIssuerModulusBits)
		}
		if rsaPub.E != standardRSAExponent {
			return nil, fmt.Errorf("issuer key %d: public exponent is %d; only the standard %d (F4) is accepted", i, rsaPub.E, standardRSAExponent)
		}
		keys = append(keys, rsaPub)
	}
	return keys, nil
}

// isCanonicalPubkey reports whether s is a canonical Nostr pubkey: exactly 64 lowercase hex digits.
// This is the exact form of event.PubKey, so an organizer key that differs would never match.
func isCanonicalPubkey(s string) bool {
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

// LoopbackOnly returns an error unless listen binds a loopback interface. The relay must
// be reachable ONLY through the Tor hidden service (PLAN.md §3.1).
func LoopbackOnly(listen string) error {
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		return fmt.Errorf("invalid listen address %q: %w", listen, err)
	}
	if host == "" {
		return fmt.Errorf("listen address %q must specify a loopback host", listen)
	}
	if host == "localhost" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("listen host %q is not an IP address", host)
	}
	if !ip.IsLoopback() {
		return fmt.Errorf("listen host %q is not loopback; the relay must be reachable only via Tor", host)
	}
	return nil
}

// MissingDefaultKinds returns the DefaultAllowedKinds that an EXPLICIT allowed_kinds omits, in
// default order — empty when the list was defaulted, or when it covers every default.
//
// An explicit allowed_kinds fully REPLACES the defaults (see Load); it is not merged. That is
// deliberate and stays that way: merging would silently re-admit a kind an operator removed on
// purpose, which is a worse failure than the one below. But the consequence is a standing footgun —
// every kind the app gains from here on needs a manual edit on every deployment that ever wrote an
// explicit list, and the symptom is a feature that silently does nothing on that relay while
// working everywhere else. It has been tripped and re-documented at least twice.
//
// So the list is never silently narrowed any more: startup names exactly what is missing. Note
// 9020-9027 (the credential/read-token mailbox kinds) are absent from DefaultAllowedKinds ON
// PURPOSE — they bypass the allow-list via the PoW mailbox path — so they can never appear here.
func MissingDefaultKinds(c Config) []int {
	if !c.AllowedKindsExplicit {
		return nil
	}
	have := make(map[int]struct{}, len(c.AllowedKinds))
	for _, k := range c.AllowedKinds {
		have[k] = struct{}{}
	}
	var missing []int
	for _, k := range DefaultAllowedKinds {
		if _, ok := have[k]; !ok {
			missing = append(missing, k)
		}
	}
	return missing
}
