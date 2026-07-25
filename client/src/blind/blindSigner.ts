/**
 * BlindSigner — the write-side seam that turns any outgoing post into a relay-blind post.
 *
 * It implements the same `sign(unsigned) => Promise<Event>` contract as the identity keystore, so
 * it can be dropped in wherever a post/comment/channel message is published without touching the
 * call sites. When the community is provisioned for blind posting (a community key is loaded), it
 * spends wallet tokens and signs with the FIRST spent token's own secret (P3 holder-bound tokens —
 * see ./holderProof), moving the author's display-name/gradient header out of the plaintext content
 * and into the encrypted attestation. Otherwise it falls back to a normal npub-signed event, so
 * nothing changes until a community opts in.
 *
 * WEIGHT-PRICED tokens: the number of tokens spent is `tokenCost` of the event (one per
 * `bytesPerToken` of chargeable weight, floored at one) — computed identically to the relay so a
 * bigger event (an inline picture / voice clip) transparently spends more tokens. With weight-pricing
 * disabled (bytesPerToken=0, the default) this is exactly one token per post, unchanged. A PROBE
 * attribution (fixed-width placeholder pubkey) sizes the cost before spending — real pricing only
 * needs the attribution's byte length, not the actual token-0 pubkey it ends up bound to (see
 * `sign()` below) — then the real attribution is rebuilt once Q0 is known.
 *
 * Out-of-tokens is deliberately a hard error, not a silent fallback: once a community is blind, a
 * post must never quietly go out under the real npub — the caller draws more / surfaces a neutral
 * message instead.
 */
import type {Event} from 'nostr-tools/pure';
import type {UnsignedEvent} from '../keys/keystore';
import {bytesToHex} from '../util/hex';
import {decodeGradientHeader, decodeNameHeader} from '../profile/displayName';
import {encryptForSpace} from '../channels/groupCrypto';
import {getActiveCommunityKey} from './communityKey';
import {getWriteContentKey} from './contentKey';
import {buildAttribution} from './attribution';
import {assembleBlindEvent} from './blindPost';
import {tokenCost, getBytesPerToken} from './tokenCost';
import {TAG_ATTR, TAG_ENC, ENC_NIP44, TAG_KE} from './protocol';
import {TAG_DOM} from '../contracts';
import type {EpochWallet} from './wallet';
import type {DrawPurpose} from './drawExchange';

/**
 * Optional per-event MEDIA routing (Phase 4d, SHIPS DARK). For a media-blob event the router returns
 * the media-WRITE wallet its tokens should come from and the `stiq_dom` value to claim; the relay
 * then verifies those tokens against that domain's dedicated key. Returns null for a non-media event
 * or a domain the relay hasn't advertised — the post wallet pays, no `stiq_dom`, byte-identical.
 */
export type MediaTokenRouter = (unsigned: UnsignedEvent) => {wallet: EpochWallet; domain: string} | null;

/**
 * Thrown when a blind wallet has no tokens left to spend — feed posting (this file), and (T0.1)
 * space-write sends (channels/groups/DMs) via AppRuntime.spendSpaceTokens.
 *
 * `purpose` records WHICH wallet ran dry (space-write, post, media, …), for a future caller that wants
 * to distinguish. None does today: EVERY purpose surfaces the exact same calm message below, on
 * purpose — a raw "out of tokens, draw more" string reaching a user is precisely the bug this class
 * exists to prevent (F2/F4/B6), so the message can't vary by call site and accidentally regress one of
 * them. `purpose` is optional so the many pre-existing zero-arg call sites keep compiling unchanged.
 */
export class BlindTokensExhausted extends Error {
  readonly purpose?: DrawPurpose;
  constructor(purpose?: DrawPurpose) {
    super('We couldn’t reach your community — check your connection and try again in a moment.');
    this.name = 'BlindTokensExhausted';
    this.purpose = purpose;
  }
}

/**
 * Thrown when the community runs content encryption (relay flag on + an announced epoch) but this
 * device holds NO write key for it — sealing is REQUIRED and unavailable, and posting plaintext
 * would silently leak the body to the relay/host (the exact 2026-07-21 failure: ensureWriteEpoch's
 * best-effort provision failed and members posted plaintext with no warning). Subclasses
 * {@link BlindTokensExhausted} deliberately: every durable-write catch (signPendingWrite's queue +
 * 'failed'+Retry placeholder, feedSigner's retry-once) already treats that class as "transient
 * infrastructure, keep the write and self-heal", which is exactly right here — the runtime provisions
 * the epoch key in the background and the queued write sends automatically once it lands. Same calm
 * user-facing message, same no-raw-prose rule.
 */
export class SealKeyUnavailable extends BlindTokensExhausted {
  constructor() {
    super();
    this.name = 'SealKeyUnavailable';
  }
}

/** What the BlindSigner needs from the identity: a fallback signer + guarded key access. */
export interface BlindSignerDeps {
  /** Normal npub signing, used when the community is not (yet) blind. */
  sign(unsigned: UnsignedEvent): Promise<Event>;
  /** Run fn with the raw secret key (transient) — signs the encrypted attestation. */
  useSecretKey<T>(fn: (sk: Uint8Array) => T): Promise<T>;
}

export class BlindSigner {
  constructor(
    private readonly deps: BlindSignerDeps,
    private readonly wallet: EpochWallet,
    /** Optional media-token router (Phase 4d, dark). Absent ⇒ every event pays from the post wallet
     *  with no `stiq_dom`, byte-identical to before this seam existed. */
    private readonly mediaRouter?: MediaTokenRouter,
    /** When this returns true, the community REQUIRES content sealing (relay advertises
     *  content_encryption + an epoch is announced) — a missing write key then throws
     *  {@link SealKeyUnavailable} instead of silently posting plaintext. This is the ONLY thing that
     *  can turn sealing on: merely HOLDING a write key (`wk` below) never seals by itself — that was
     *  the 2026-07-22 bug (relay flips content_encryption off, client still had a cached epoch key,
     *  and kept sealing posts nobody could read). Consulted fresh on every `sign()` call (never
     *  captured once), so a flag flip mid-session (caps re-negotiated on reconnect) takes effect on
     *  the very next post. Absent ⇒ never seal, matching every dark/off deployment. */
    private readonly sealRequired?: () => boolean,
  ) {}

  /**
   * Sign `unsigned` as a blind post when provisioned, else as a normal npub event.
   *
   * NOTE: this is gated ONLY on whether a community key is loaded — there is no kind allow-list
   * here or anywhere else in the client. It is the CALLER's job to decide whether a given piece of
   * content should go through this signer at all (e.g. AppRuntime's `feedSigner` wraps this for
   * feed posts/comments/reactions/polls/voice, while channel/live-chat broadcasts are signed with
   * the bound npub directly, matching the relay's own exclusion of those kinds from its blind
   * content set). See ./protocol for the fuller rationale.
   */
  async sign(unsigned: UnsignedEvent): Promise<Event> {
    const communityKey = getActiveCommunityKey();
    if (!communityKey) {
      return this.deps.sign(unsigned); // community not blind yet → unchanged behaviour
    }

    // Lift the display-name / gradient header out of the plaintext body into the (encrypted)
    // attestation, so the relay can't even link posts by name.
    const {name, text} = decodeNameHeader(unsigned.content);
    const gradient = decodeGradientHeader(unsigned.content);
    const clean: UnsignedEvent = {...unsigned, content: text};
    const meta = {...(name ? {name} : {}), ...(gradient ? {gradient} : {})};

    // Seal the BODY under the current content epoch key ONLY when the community currently REQUIRES
    // it (sealRequired, consulted fresh right here — never at construction — so a live flag flip is
    // honoured on the very next post). Merely HOLDING a write key is not enough: a stale/cached epoch
    // key surviving after the relay turns content_encryption off must never sole-handedly seal a post
    // (the 2026-07-22 bug — 11 posts sealed with the flag already off, rendered permanently locked for
    // most members). The attribution is a SEPARATE key (always member-readable), so authorship
    // survives even when the reader hasn't unlocked this epoch.
    const mustSeal = this.sealRequired?.() ?? false;
    const wk = mustSeal ? getWriteContentKey() : null;
    // Fail CLOSED when sealing is required but no epoch key is loaded: a plaintext fallback here is
    // a silent leak of the body to the relay/host. The caller's durable pipeline keeps the write and
    // retries once the runtime provisions the key (see SealKeyUnavailable's doc).
    if (mustSeal && !wk) throw new SealKeyUnavailable();
    const sealed: UnsignedEvent = wk
      ? {
          ...clean,
          content: encryptForSpace(clean.content, wk.key),
          tags: [...clean.tags, [TAG_ENC, ENC_NIP44], [TAG_KE, String(wk.epoch)]],
        }
      : clean;

    // P3 (holder-bound tokens): the event's signer is no longer a freshly generated throwaway key —
    // it is TOKEN 0 itself (event.pubkey === hex(token0.token)), so which token lands at index 0
    // isn't known until AFTER we spend. But `attr`'s byte length — the only thing pricing needs —
    // does not depend on which 32-byte pubkey it binds to, only on its (fixed) 64-hex-char width,
    // and `stiq_spend` proofs are excluded from chargeable weight on both sides (tokenCost.ts /
    // relay weight.go skip TAG_SPEND). So `need` can be sized from a PROBE attribution built with a
    // placeholder pubkey of the same width, entirely before Q0 is known — pricing stays exact.
    const attrProbe = await this.deps.useSecretKey(sk =>
      buildAttribution(sk, PROBE_EVENT_PUBKEY_HEX, communityKey, meta),
    );

    // Media token routing (Phase 4d, dark): a media-blob event may pay from a dedicated picture/audio
    // WRITE wallet and claim its domain via `stiq_dom`, so the organizer meters media independently.
    // The `stiq_dom` tag IS chargeable weight, so it must be present before pricing. If the media
    // wallet is empty we fall back to the post wallet WITHOUT the tag (posting never breaks — the
    // relay then verifies against the posting keys as today). Router absent / returns null ⇒ the tag
    // is never added and the post wallet pays, byte-identical to before.
    const route = this.mediaRouter?.(unsigned) ?? null;
    let priced = sealed;
    let tokens = null;
    if (route) {
      const withDom: UnsignedEvent = {...sealed, tags: [...sealed.tags, [TAG_DOM, route.domain]]};
      const needDom = tokenCost(withDom.content, [...withDom.tags, [TAG_ATTR, attrProbe]], getBytesPerToken());
      const mediaTokens = await route.wallet.spendMany(needDom);
      if (mediaTokens) {
        priced = withDom;
        tokens = mediaTokens;
      }
    }
    if (!tokens) {
      // Post-wallet path (no stiq_dom): the default, and the fallback when the media wallet is dry.
      const need = tokenCost(sealed.content, [...sealed.tags, [TAG_ATTR, attrProbe]], getBytesPerToken());
      tokens = await this.wallet.spendMany(need);
    }
    if (!tokens) throw new BlindTokensExhausted();

    // Now Q0 (the event's real signer/pubkey) is known — rebuild the REAL attribution bound to it
    // (parseAttribution requires the bind tag to equal the actual event.pubkey).
    const eventPubkeyHex = bytesToHex(tokens[0]!.token);
    const attr = await this.deps.useSecretKey(sk => buildAttribution(sk, eventPubkeyHex, communityKey, meta));
    return assembleBlindEvent(priced, tokens, attr);
  }
}

/**
 * Fixed-width placeholder used only to SIZE the probe attribution above — never signed onto the
 * wire. Any 32-byte-hex-shaped string works; its value is irrelevant, only its length (64 hex
 * chars, matching a real event.pubkey) needs to match so the probe attribution's byte length is
 * identical to the real one.
 */
const PROBE_EVENT_PUBKEY_HEX = '0'.repeat(64);
