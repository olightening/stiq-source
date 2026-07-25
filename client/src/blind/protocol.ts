/**
 * Blind-posting protocol — shared vocabulary (PLAN.md §3.3/§3.6 generalized to all content).
 *
 * A "blind post" is an ordinary content event (note/comment/article/channel message) that is
 * signed by a FRESH throwaway key — never the author's real npub — so the relay (and any
 * volunteer host) can never tell which npub authored it, nor link two posts to one author. It
 * carries three extra tags:
 *
 *   ['stiq_token', base64(token)]  — a blind-signed anti-spam token (one per post)
 *   ['stiq_sig',   base64(sig)]    — the issuer's RSA blind signature over `token`
 *   ['stiq_attr',  base64(ct)]     — the author's identity, ENCRYPTED to the community key
 *
 * P3 (holder-bound tokens): the 32 token bytes ARE a BIP-340 x-only pubkey `Q`; the client keeps
 * the matching secret `q`. A multi-token post additionally carries one `['stiq_spend', base64(sig)]`
 * per token beyond the first, proving that token's `q` authorized THIS event — see ./holderProof
 * and ./blindPost `assembleBlindEvent`. Token 0 needs no proof: the event is signed with `q0`, so
 * `event.pubkey == Q0` already proves it.
 *
 * The relay verifies the (token, sig) pair against the published issuer public key and refuses
 * a token it has already seen (spent-set) — that is the whole admission decision for a post. It
 * never reads `stiq_attr`. Community MEMBERS (who hold the community key) decrypt `stiq_attr` to
 * recover the real author for profiles, threads and moderation; a host cannot.
 *
 * Tokens are publish-only and cannot be revoked: because they are blind-signed, not even the
 * organizer can link a token to an npub, so no one can selectively kill a member's posting
 * ability. Moderation is advisory-only (see ../moderation): mods never remove anything, they
 * broadcast signed events that tell clients to render a given author's posts in the mod log.
 *
 * The tag names, the attestation kind/sub-tags, and the epoch scalars all live in the shared
 * contract module ({@link ../contracts}) so the client can never drift from the relay/organizer.
 * They are RE-EXPORTED here unchanged for the blind/* importers that reference them via `./protocol`.
 *
 * NOTE ON "WHICH KINDS GO BLIND": there is deliberately no kind allow-list on the client. Whether
 * an event is posted blind is decided purely by {@link BlindSigner.sign} on whether a community
 * key is loaded (see ./blindSigner) — the CALLER picks blind (AppRuntime's `feedSigner`, wrapping
 * BlindSigner) vs bound-npub (`this.identity` directly) per call site. Channel (42) and live-chat
 * (1311) messages are signed with the bound npub on purpose (channels are owner/admin-voiced, not
 * anonymous) and are excluded from blind posting on the RELAY side too (relay/internal/policy/
 * membership.go `blindContentKinds`), so client and relay agree without either side needing a
 * shared kind list.
 */
// Tag names (TAG_TOKEN/TAG_SIG/TAG_SPEND/TAG_ATTR/TAG_ENC/ENC_NIP44/TAG_KE), the attestation kind +
// its sub-tags (ATTR_BIND/ATTR_NAME/ATTR_GRAD), the holder-proof domain separator (SPEND_DOMAIN),
// and the epoch scalars are owned by the contract module.
export {
  TAG_TOKEN,
  TAG_SIG,
  TAG_SPEND,
  TAG_ATTR,
  TAG_ENC,
  ENC_NIP44,
  TAG_KE,
  KIND_ATTESTATION,
  ATTR_BIND,
  ATTR_NAME,
  ATTR_GRAD,
  SPEND_DOMAIN,
  EPOCH_SECONDS,
  currentEpoch,
} from '../contracts';
