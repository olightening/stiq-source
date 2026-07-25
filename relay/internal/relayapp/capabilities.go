package relayapp

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"

	"github.com/stiq/relay/internal/config"
	"github.com/stiq/relay/internal/policy"
)

// StiqCapabilities builds the stiq-specific capability block advertised inside the relay's NIP-11
// document under the "stiq-capabilities" key (see the NIP-11 interceptor in main.go). It lets a
// stiq client discover — before it publishes anything — which stiq extensions this relay enforces
// (blind_required, weight-pricing, private-group read auth, P3 holder-proof required), the effective PoW bars, whether token
// domain separation is active, the issuer-key fingerprints to pin, the accepted event kinds, and
// the reject-code vocabulary version. It is purely descriptive: it changes no admission behaviour,
// exposes no per-member state, and a generic Nostr client simply ignores the extra key. It is built
// from the LIVE config (Reloader.Config) so it reflects SIGHUP hot-reloads.
//
// The returned map marshals to this exact shape:
//
//	{
//	  "schema_version": <int>,
//	  "enforced": { "blind_required": <bool>, "bytes_per_token": <int>, "private_group_read_auth": <bool>,
//	                "holder_proof_required": <bool> },
//	  "pow": { "enroll": <int>, "dm": <int> },
//	  "token_domain_sep": <bool>,
//	  "issuer_key_fingerprints": { "enroll": [<string>...], "posting": [...], "binding": [...],
//	                               "space_write": [...], "picture": [...], "audio": [...] },
//	  "issuer_keys": { "enroll": <string>, "posting": <string>, "read": <string> },
//	  "allowed_kinds": [<int>...],
//	  "reject_codes_version": <int>,
//	  "push": { "watcher": <string>, "ntfy": <string> }   // OPTIONAL; present only when configured
//	}
//
// The optional "push" object advertises the T1 keyless push circuit (organizer-hosted pushwatcher +
// self-hosted ntfy onions). It is emitted ONLY when at least one of cfg.PushWatcherOnion /
// cfg.PushNtfyOnion is non-empty; when both are empty the key is omitted entirely, so a relay with
// push unconfigured looks byte-identical to before. It is purely descriptive — a discovery hint for
// the client — and changes no admission behaviour.
func StiqCapabilities(cfg *config.Config) map[string]any {
	// Effective enroll PoW: EnrollPoW when set, else the DM/PoWDifficulty fallback (mirrors
	// Membership.enrollDifficulty). Effective DM PoW is PoWDifficulty (0 disables DMs).
	enrollPoW := cfg.EnrollPoW
	if enrollPoW <= 0 {
		enrollPoW = cfg.PoWDifficulty
	}

	// Effective allowed kinds: the configured set when present, else the shipped default (mirrors
	// config.Load, which substitutes DefaultAllowedKinds when the file leaves allowed_kinds empty).
	allowed := cfg.AllowedKinds
	if len(allowed) == 0 {
		allowed = config.DefaultAllowedKinds
	}

	m := map[string]any{
		"schema_version": config.SchemaVersion,
		"enforced": map[string]any{
			"blind_required":          cfg.BlindRequired,
			"bytes_per_token":         cfg.BytesPerToken,
			"private_group_read_auth": cfg.PrivateGroupReadAuth,
			"holder_proof_required":   cfg.HolderProofRequired,
			// Content-encryption read meter (#4): posts may be sealed under a rotating content-epoch
			// key and read via the blind read-token meter. The single master switch the client gates
			// the whole read-meter subsystem on. Off by default → posts stay plaintext, meter dormant.
			"content_encryption": cfg.ContentEncryption,
			// Censorable reads (#4): the organizer requires a READ-purpose token draw to prove the
			// member's npub, so it can refuse a read-revoked member. The relay only ADVERTISES this;
			// enforcement is organizer-side (it never touches read tokens). Off by default.
			"read_auth_required": cfg.ReadAuthRequired,
			// Tokens-everywhere: member space content (channel/group messages, h-tagged group
			// reactions, DM wraps) must spend space-write tokens. This is the client's ONLY
			// attach signal — today's relay rejects token-tagged space kinds, so a client must
			// never attach until this is true. Advertised true ONLY when the verifying keys are
			// ALSO configured (mirrors media_write_domains): the flag without space_write_issuer_
			// public_keys can never be satisfied — gateSpaceTokens rejects every token-tagged space
			// event — so advertising it would make compliant clients attach tokens that brick every
			// space write. Gating it here means the client's attach decision is safe by construction.
			"space_tokens_required": cfg.SpaceTokensRequired && len(cfg.SpaceWriteIssuerPublicKeys) > 0,
		},
		"pow": map[string]any{
			"enroll": enrollPoW,
			"dm":     cfg.PoWDifficulty,
		},
		// Token domain separation is active (posting tokens verified against a DISTINCT key) once the
		// operator supplies posting_issuer_public_keys. See config.PostingIssuerPublicKeys.
		"token_domain_sep": len(cfg.PostingIssuerPublicKeys) > 0,
		"issuer_key_fingerprints": map[string]any{
			// enroll = the general issuer keys (enrollment/draw credentials and the fallback for
			// posting/binding when those dedicated lists are empty). posting/binding come from their
			// own config lists and are empty until the domain-sep keys are supplied.
			"enroll":  keyFingerprints(cfg.IssuerPublicKeys),
			"posting": keyFingerprints(cfg.PostingIssuerPublicKeys),
			"binding": keyFingerprints(cfg.BindingIssuerPublicKeys),
			// Space-write token keys (tokens-everywhere) — empty until the operator supplies them.
			"space_write": keyFingerprints(cfg.SpaceWriteIssuerPublicKeys),
			// Media write-issuer keys (T1.3, enables F6): the relay already holds picture/audio
			// write issuers whenever the operator configures them (SetPictureWriteIssuers /
			// SetAudioWriteIssuers in relay.go, hot-reloadable per T1.1) — fingerprint them
			// UNCONDITIONALLY here, same as posting/binding/space_write above, independent of
			// media_write_domains' MediaTokensEnabled gate below. This is deliberate: a client's
			// drift-detector needs to tell "this domain's key rotated under me" apart from "this
			// domain was never configured" regardless of whether the operator has also flipped the
			// advertisement bool, so the fingerprint set must always reflect what's actually
			// enforced. Empty ([]) until the operator supplies the corresponding media write keys.
			// `read` is deliberately NOT added this phase — it is organizer-verified (not
			// relay-verified), and its provenance lands in Phase 5/T5.2 (see Appendix A / NB-6).
			"picture": keyFingerprints(cfg.PictureWriteIssuerPublicKeys),
			"audio":   keyFingerprints(cfg.AudioWriteIssuerPublicKeys),
		},
		// issuer_keys carries the RAW base64-encoded SPKI DER for the first configured key in each
		// list (not a fingerprint) so a v2-onboarding client can pin/verify it directly:
		// sha256(utf8(issuer_keys.enroll))[:16] must reproduce the join code's cid. This MUST be
		// byte-identical to the organizer's issuer_public.b64 (itself base64(DER SPKI), never PEM),
		// which is the same invariant the C5 domain-sep gate already relies on. posting/read are ""
		// until their dedicated key lists are configured (posting) or exist (read; no config list yet).
		"issuer_keys": map[string]any{
			"enroll":  firstKeyB64(cfg.IssuerPublicKeys),
			"posting": firstKeyB64(cfg.PostingIssuerPublicKeys),
			"read":    "",
		},
		"allowed_kinds":        allowed,
		"reject_codes_version": policy.RejectCodesVersion,
	}

	// Media write domains (Phase 4d activation signal): list each media domain whose WRITE-issuer
	// key set is configured AND whose advertisement the operator has enabled. A client must NOT spend
	// media-write-key tokens (with stiq_dom) until its domain appears here: against a relay that
	// doesn't verify it, those tokens fall back to the posting keys and fail, killing the post. Gated
	// on BOTH the keys (so the relay can actually verify) AND MediaTokensEnabled (the dashboard-
	// flippable ON/OFF, SIGHUP-reloadable without a relay restart). Omitted entirely when disabled or
	// unconfigured, so a dark relay's capability doc is byte-identical to before.
	mediaDomains := make([]string, 0, 2)
	if cfg.MediaTokensEnabled {
		if len(cfg.PictureWriteIssuerPublicKeys) > 0 {
			mediaDomains = append(mediaDomains, "picture")
		}
		if len(cfg.AudioWriteIssuerPublicKeys) > 0 {
			mediaDomains = append(mediaDomains, "audio")
		}
	}
	if len(mediaDomains) > 0 {
		m["media_write_domains"] = mediaDomains
	}

	// Optional push discovery block: advertise the keyless watcher + ntfy onions ONLY when the
	// operator has configured at least one. Omitting the key when both are empty keeps a push-off
	// relay byte-identical to before. Purely descriptive — no admission change.
	if cfg.PushWatcherOnion != "" || cfg.PushNtfyOnion != "" {
		m["push"] = map[string]any{
			"watcher": cfg.PushWatcherOnion,
			"ntfy":    cfg.PushNtfyOnion,
		}
	}

	return m
}

// keyFingerprints returns a "sha256:<hex>" fingerprint per PEM-encoded issuer key. Per the wire
// contract pinned in CLIENT_C5_FINGERPRINT_CONTRACT.md (and implemented client-side by
// walletKeyFingerprint in client/src/blind/wallet.ts), the hash is over the STANDARD-BASE64
// ENCODING of the decoded DER (SPKI) bytes — i.e. sha256(utf8(base64.StdEncoding(der))) — NOT the
// raw DER bytes directly, and NOT the PEM text. That base64 string is the exact value the
// join/community code carries in its `pk`/`rk` fields (and what firstKeyB64 below already
// produces), so hashing it here is what lets the client's drift-detector compare like for like;
// the organizer computes the identical hash over its `pubB64` (issuer/organizer-server.mjs). Any
// key that fails to PEM-decode is skipped (never panics); a nil/empty input yields an empty,
// non-nil slice so it marshals to [] rather than null. Reuses the same pem.Decode approach as
// config.ParseIssuerKeys.
func keyFingerprints(pems []string) []string {
	out := make([]string, 0, len(pems))
	for _, p := range pems {
		block, _ := pem.Decode([]byte(p))
		if block == nil {
			continue // skip un-decodable keys rather than panicking
		}
		b64 := base64.StdEncoding.EncodeToString(block.Bytes)
		sum := sha256.Sum256([]byte(b64))
		out = append(out, "sha256:"+hex.EncodeToString(sum[:]))
	}
	return out
}

// firstKeyB64 returns the standard-base64 encoding of the DECODED DER (SPKI) bytes of the first
// PEM-encoded key in pems, or "" when the list is empty or the first entry fails to PEM-decode.
// Unlike keyFingerprints (which hashes the DER for a stable identifier), this returns the DER
// itself so a v2-onboarding client can feed it straight into walletKeyFingerprint(enrollKeyB64) —
// it must be byte-identical to the organizer's issuer_public.b64 for that cid check to hold.
func firstKeyB64(pems []string) string {
	if len(pems) == 0 {
		return ""
	}
	block, _ := pem.Decode([]byte(pems[0]))
	if block == nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(block.Bytes)
}
