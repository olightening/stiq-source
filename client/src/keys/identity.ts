/**
 * Identity — the enrolled user, backed by the secure key store (PLAN.md Step 7).
 *
 * Stores the on-device key, the bound relay, and the membership credential. reset() is the
 * duress/logout hook (Step 11) — it removes all three.
 */
import * as nip19 from 'nostr-tools/nip19';
import {getPublicKey, type Event} from 'nostr-tools/pure';
import {v2 as nip44} from 'nostr-tools/nip44';
import {bytesToBase64, base64ToBytes} from '../util/base64';
import {bytesToHex} from '../util/hex';
import {KeyStore, type SecureKeyStore, type SecureStorage, type UnsignedEvent} from './keystore';
import {
  createDmSeal,
  createDmReactionSeal,
  mineGiftWrap,
  decryptInboxChunk,
  makeConversationKeyCache,
  type ConversationKeyCache,
  type InboxDecryptResult,
} from '../dm/dm';
import {DM_POW_DIFFICULTY, FMD_EVAL_ENABLED} from '../config';
import {fmdExtraTagsFor, evalRecipientFmdPk} from '../research/fmd/prototype';
import {buildKeyDelivery, unwrapKeyFromSender} from '../channels/groupCrypto';
import {buildEncryptedProfileEvent} from '../profile/identityDoc';
import {
  LEGACY_RELAY_ITEM,
  LEGACY_CRED_TOKEN_ITEM,
  LEGACY_CRED_SIG_ITEM,
  identityRelayKey,
  credTokenKey,
  credSigKey,
} from '../app/workspaceKeys';

export interface Credential {
  token: Uint8Array;
  signature: Uint8Array;
}

export interface IdentityInfo {
  pubkey: string;
  npub: string;
  relayUrl: string;
}

export class Identity {
  private readonly store: SecureKeyStore;
  private readonly relayItem: string;
  private readonly credTokenItem: string;
  private readonly credSigItem: string;

  /**
   * @param storage hardware-backed secure storage.
   * @param slotId  optional KeyRing slot id. When set, the signing key, credential, and bound
   *                relay are all namespaced to this identity (`stiq_privkey_<slotId>`,
   *                `stiq_cred_token_<slotId>`, …) so several communities coexist in silo. Omitting
   *                it targets the pre-silo global keys — used only for the un-enrolled bootstrap
   *                and read by the one-time migration.
   */
  constructor(private readonly storage: SecureStorage, slotId?: string) {
    this.store = new KeyStore(storage, slotId);
    this.relayItem = slotId ? identityRelayKey(slotId) : LEGACY_RELAY_ITEM;
    this.credTokenItem = slotId ? credTokenKey(slotId) : LEGACY_CRED_TOKEN_ITEM;
    this.credSigItem = slotId ? credSigKey(slotId) : LEGACY_CRED_SIG_ITEM;
  }

  /**
   * Optional pre-sign tag hook (tokens-everywhere, SHIPS DARK). When set, {@link sign} calls it with
   * the unsigned event and appends whatever tags it returns BEFORE finalizing — so the tags are
   * covered by the event id + signature. AppRuntime injects one that attaches an all-proofs
   * space-write token chain for bound-npub SPACE content kinds (channel/group messages) once the
   * relay requires it; for every other kind (profiles, reports, lists, config, key delivery) the
   * hook returns null and signing is byte-identical. Null hook (the default) ⇒ no behaviour change.
   */
  private preSignHook: ((unsigned: UnsignedEvent) => Promise<string[][] | null>) | null = null;

  /** Install (or clear) the pre-sign tag hook. AppRuntime rebinds it in lock-step with the identity. */
  setPreSignHook(hook: ((unsigned: UnsignedEvent) => Promise<string[][] | null>) | null): void {
    this.preSignHook = hook;
  }

  /** Persist the on-device key, bound relay, and membership credential. */
  async enroll(
    secretKey: Uint8Array,
    relayUrl: string,
    credential: Credential,
  ): Promise<IdentityInfo> {
    await this.store.enroll(secretKey);
    await this.storage.setItem(this.relayItem, relayUrl);
    await this.storage.setItem(this.credTokenItem, bytesToBase64(credential.token));
    await this.storage.setItem(this.credSigItem, bytesToBase64(credential.signature));
    return this.info();
  }

  isEnrolled(): Promise<boolean> {
    return this.store.isEnrolled();
  }

  async info(): Promise<IdentityInfo> {
    const pubkey = await this.store.publicKey();
    const relayUrl = (await this.storage.getItem(this.relayItem)) ?? '';
    return {pubkey, npub: nip19.npubEncode(pubkey), relayUrl};
  }

  /** The stored membership credential, used to (re)publish the binding event if needed. */
  async credential(): Promise<Credential | null> {
    const token = await this.storage.getItem(this.credTokenItem);
    const sig = await this.storage.getItem(this.credSigItem);
    if (!token || !sig) {
      return null;
    }
    return {token: base64ToBytes(token), signature: base64ToBytes(sig)};
  }

  async sign(unsigned: UnsignedEvent): Promise<Event> {
    if (this.preSignHook) {
      const extra = await this.preSignHook(unsigned);
      if (extra && extra.length > 0) {
        unsigned = {...unsigned, tags: [...(unsigned.tags ?? []), ...extra]};
      }
    }
    return this.store.sign(unsigned);
  }

  /**
   * Run `fn` with the raw secret key (transient — scrubbed immediately after). Used by the blind
   * signer to produce the encrypted author attestation on a blind post, exactly as sealDM uses it
   * for DMs. The key never leaves the callback.
   */
  useSecretKey<T>(fn: (sk: Uint8Array) => T): Promise<T> {
    return this.store.useSecretKey(fn);
  }

  /**
   * Seal a DM to a peer (NIP-17) and mine the relay-required NIP-13 proof-of-work.
   * The sender key is used only to build the inner seal (transient + scrubbed); the outer
   * wrap is signed by an ephemeral key, so the PoW mine runs outside the key guard.
   */
  async sealDM(
    peerPubkey: string,
    text: string,
    replyTo?: string,
    powDifficulty: number = DM_POW_DIFFICULTY,
    // Tokens-everywhere (dark): forwarded to mineGiftWrap so a DM wrap pays space-write tokens under
    // enforcement. Absent (the default) ⇒ no token tags, byte-identical DMs.
    attachTokens?: (wrapPubkeyHex: string, weighable: {content: string; tags: string[][]}) => Promise<string[][]>,
  ): Promise<{wrap: Event; rumorId: string}> {
    const {seal, rumorId} = await this.store.useSecretKey(sk => createDmSeal(sk, peerPubkey, text, replyTo));
    // SHIP-DARK FMD eval seam (T18-S7). This is the SINGLE flag-guarded branch: with FMD_EVAL_ENABLED
    // false (the shipped default) it is skipped entirely — no FMD pk is derived, `extraTags` is
    // undefined, and mineGiftWrap builds a wrap byte-identical to before the FMD seam existed. Only a
    // local eval build (flag flipped) mints an eval recipient key and injects a flag tag via the
    // flag-guarded fmdExtraTagsFor choke point. The decoy cover-set (subscriptionPlan.ts) stays the
    // shipping DM metadata defense regardless.
    const extraTags = FMD_EVAL_ENABLED ? fmdExtraTagsFor(evalRecipientFmdPk(peerPubkey)) : undefined;
    const wrap = await mineGiftWrap(seal, peerPubkey, powDifficulty, extraTags, attachTokens);
    return {wrap, rumorId};
  }

  /**
   * Seal + mine a DM REACTION (kind-7) to a peer, targeting a message by its shared rumor id.
   * `powDifficulty` defaults to the build constant; AppRuntime passes the relay-advertised `dmPow`
   * (capability-driven PoW, C4) so an operator can raise it without shipping a new client. This
   * module stays runtime-free — the difficulty is supplied by the caller, not imported from state.
   */
  async sealDmReaction(
    peerPubkey: string,
    targetRumorId: string,
    emoji: string,
    powDifficulty: number = DM_POW_DIFFICULTY,
    attachTokens?: (wrapPubkeyHex: string, weighable: {content: string; tags: string[][]}) => Promise<string[][]>,
  ): Promise<Event> {
    const {seal} = await this.store.useSecretKey(sk => createDmReactionSeal(sk, peerPubkey, targetRumorId, emoji));
    return mineGiftWrap(seal, peerPubkey, powDifficulty, undefined, attachTokens);
  }

  /**
   * Decrypt the gift wraps addressed to us into messages (plaintext stays in memory). Chunked to keep
   * the single JS thread responsive (finding #1): the raw secret key is read + scrubbed ONCE PER CHUNK
   * (via useSecretKey) and the loop yields the event loop between chunks, so the key is never resident
   * across a yield and a large historical backlog no longer freezes startup. `onChunk`, if given,
   * fires with the messages so far after each chunk so conversations can stream in. `cache` (a
   * per-identity {@link ConversationKeyCache}) is reused across chunks and across calls so repeat
   * senders derive their inner-seal key once (finding #2).
   */
  async readInbox(
    wraps: Event[],
    cache: ConversationKeyCache,
    onChunk?: (messagesSoFar: InboxDecryptResult['messages']) => void,
  ): Promise<InboxDecryptResult> {
    const out: InboxDecryptResult = {messages: [], failedIds: []};
    let i = 0;
    while (i < wraps.length) {
      // One key-guard entry per chunk: sk lives only for this synchronous slice, then is scrubbed.
      i = await this.store.useSecretKey(sk => decryptInboxChunk(wraps, i, sk, cache, out));
      if (i < wraps.length) {
        if (onChunk) onChunk([...out.messages].sort((a, b) => b.createdAt - a.createdAt));
        await new Promise<void>(resolve => setTimeout(resolve, 0)); // yield between chunks
      }
    }
    out.messages.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  /** A fresh conversation-key cache for {@link readInbox}. Holds only derived per-peer keys (never the
   *  raw secret key), so the caller may retain it across refreshes and MUST clear() it on identity
   *  change / duress. */
  newConversationKeyCache(): ConversationKeyCache {
    return makeConversationKeyCache();
  }

  /**
   * Export the raw 32-byte secret key as hex, for the user-initiated paper-key backup flow
   * (Settings → Key backup, gated behind PIN re-entry). This is the one deliberate read of the
   * key out of the secure store: the user is explicitly choosing to write it down. The transient
   * copy is scrubbed; callers MUST treat the returned string as secret (never log/persist/send).
   */
  exportPrivkey(): Promise<string> {
    return this.store.useSecretKey(sk => bytesToHex(sk));
  }

  /**
   * Build a SIGNED private-space key-delivery event (kind 30079) wrapping `key` (epoch `epoch`) of
   * space `spaceId` to one member. The secret key is used transiently to derive the NIP-44
   * conversation key and is scrubbed afterwards (mirrors sealDM). Only the member's sk can unwrap.
   */
  async wrapSpaceKeyFor(
    spaceId: string,
    epoch: number,
    key: Uint8Array,
    memberPubkey: string,
  ): Promise<Event> {
    const unsigned = await this.store.useSecretKey(sk =>
      buildKeyDelivery(spaceId, epoch, key, sk, memberPubkey),
    );
    return this.store.sign(unsigned);
  }

  /**
   * Unwrap a space key a sender wrapped for us (from a kind-30079 delivery). Returns the 32-byte
   * key; throws if not addressed to us or tampered. The secret key is transient + scrubbed.
   */
  unwrapSpaceKey(blob: string, senderPubkey: string): Promise<Uint8Array> {
    return this.store.useSecretKey(sk => unwrapKeyFromSender(blob, sk, senderPubkey));
  }

  /**
   * NIP-44-encrypt `plaintext` to a specific peer (raw ciphertext, no event framing) — the
   * primitive behind the join-request intro note's per-admin seals (channels/membership.ts).
   * The secret key is transient + scrubbed (mirrors sealDM / wrapSpaceKeyFor).
   */
  sealForPeer(peerPubkey: string, plaintext: string): Promise<string> {
    return this.store.useSecretKey(sk =>
      nip44.encrypt(plaintext, nip44.utils.getConversationKey(sk, peerPubkey)),
    );
  }

  /**
   * Decrypt a NIP-44 ciphertext a peer sealed for us (the admin side of {@link sealForPeer} —
   * the peer here is the event's SIGNER, e.g. a join request's requester). Throws on a wrong
   * key / tampered ciphertext — callers try/catch and skip. Transient key, scrubbed.
   */
  openFromPeer(peerPubkey: string, ciphertext: string): Promise<string> {
    return this.store.useSecretKey(sk =>
      nip44.decrypt(ciphertext, nip44.utils.getConversationKey(sk, peerPubkey)),
    );
  }

  /**
   * Build a SIGNED encrypted self-profile event (kind-30078, d="identity-enc"): `plaintext`
   * NIP-44-encrypted to our OWN key so only our own devices can read it — the relay stores only
   * ciphertext. The secret key is used transiently to derive the self conversation key (ECDH of the
   * key with its own pubkey) and is scrubbed afterwards (mirrors sealDM / wrapSpaceKeyFor).
   */
  async buildEncryptedProfile(plaintext: string, createdAt: number): Promise<Event> {
    const ciphertext = await this.store.useSecretKey(sk =>
      nip44.encrypt(plaintext, nip44.utils.getConversationKey(sk, getPublicKey(sk))),
    );
    return this.store.sign(buildEncryptedProfileEvent(ciphertext, createdAt));
  }

  /**
   * Decrypt one of OUR OWN encrypted self-profile events (content = NIP-44 self-ciphertext). Throws
   * on a wrong key / tampered ciphertext — callers try/catch and skip. Transient key, scrubbed.
   */
  decryptSelfProfile(ciphertext: string): Promise<string> {
    return this.store.useSecretKey(sk =>
      nip44.decrypt(ciphertext, nip44.utils.getConversationKey(sk, getPublicKey(sk))),
    );
  }

  async reset(): Promise<void> {
    await this.store.reset();
    await this.storage.removeItem(this.relayItem);
    await this.storage.removeItem(this.credTokenItem);
    await this.storage.removeItem(this.credSigItem);
  }
}
