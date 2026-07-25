/**
 * NIP-17 sealed direct messages (PLAN.md §3 / Step 16).
 *
 * Uses nostr-tools' vetted NIP-17 (seal via NIP-44, gift-wrap via NIP-59). The gift wrap
 * (kind 1059) is signed by an EPHEMERAL key, so the relay — and anyone watching — never
 * learns the sender. Only the recipient's key can unwrap it.
 *
 * Decrypted plaintext is never persisted (PLAN.md §4.1): only the sealed gift wraps live in
 * the cache; `readInbox` decrypts them in memory on demand.
 */
import {wrapEvent} from 'nostr-tools/nip17';
import {createRumor, createSeal} from 'nostr-tools/nip59';
import {finalizeEvent, generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import type {Event} from 'nostr-tools/pure';
import {v2 as nip44} from 'nostr-tools/nip44';
import {sha256} from '@noble/hashes/sha2.js';
import {utf8ToBytes} from '@noble/hashes/utils.js';
import {NativeModules} from 'react-native';
import {Kind} from '../nostr/events';
import {randomBytes} from '../util/random';
import type {EmojiTally} from '../channels/reactions';

/** Inner rumor kind for a DM reaction (NIP-25). Distinguishes it from a kind-14 chat message. */
export const DM_REACTION_KIND = 7;

interface PowNativeModule {
  minePow(serialized: string, nonceOffset: number, nonceWidth: number, difficulty: number): Promise<string>;
}
const StiqPow = (NativeModules as {StiqPow?: PowNativeModule}).StiqPow;

export interface DirectMessage {
  /** Gift-wrap event id (stable handle for the cached envelope) — differs per recipient. */
  id: string;
  /**
   * Inner RUMOR id — the ONLY identifier both parties share for the same message (each side holds
   * its own gift wrap with a different `id`). Reactions and replies reference this so they associate
   * across the two participants.
   */
  rumorId: string;
  /** Sender hex pubkey (recovered only by the recipient). */
  sender: string;
  text: string;
  createdAt: number;
  /** Delivery status slot — populated by the DM backend when available. */
  status?: 'sending' | 'sent' | 'failed';
  /**
   * The optimistic `local-…` id this echo was FIRST rendered under, kept when sendDM later adopts
   * the real gift-wrap id (`echo.id = wrap.id`). React list keys use `localId ?? id` so the
   * just-sent bubble — the bottom-most, most-visible row — keeps ONE key across that adoption and
   * never unmounts/remounts mid-send. Only ever present on our own outgoing echoes.
   */
  localId?: string;
  /**
   * Human-facing reason a failed ('✕') send did not go through — the RAW seal/relay message, mapped
   * to calm copy at render via calmRejection (like Outbox.reasons() for posts). Set on a pre-relay
   * seal/token/PoW failure (sendDM) or a relay rejection (deliver→syncDmEcho); cleared when the send
   * later reaches 'sent'. Absent ⇒ no failure detail to show.
   */
  failureReason?: string;
  /**
   * The space-invite wire payload this echo carried, if any (see inviteToSpace). Retained so a Retry
   * re-sends a faithful invite (grant + card), not a bare text message. Absent for a plain DM.
   */
  inviteWire?: string;
  /** Rumor id of the message this one replies to (from the inner rumor's `e` tag), if any. */
  replyTo?: string;
  /**
   * Present when this decrypted item is a REACTION (inner kind-7), not a chat message: the target
   * message's rumor id + the emoji. The DM backend folds these onto the target message's `reactions`
   * and does not render them as messages.
   */
  reaction?: {targetRumorId: string; emoji: string};
  /** Reaction tallies attached to a chat message for display (who reacted). */
  reactions?: EmojiTally[];
}

/** Seal a message to a recipient, returning the kind-1059 gift wrap to publish. */
export function sealDM(senderSecretKey: Uint8Array, recipientPubkey: string, text: string): Event {
  return wrapEvent(senderSecretKey, {publicKey: recipientPubkey}, text);
}

// NIP-17 chat message rumor kind.
const KIND_CHAT = 14;
// NIP-59 randomizes the wrap timestamp up to 2 days in the past to hide send time.
const TWO_DAYS = 2 * 24 * 60 * 60;
/**
 * The gift-wrap `created_at`, fuzzed uniformly across the last {@link TWO_DAYS} to hide the true
 * send time. This is an anonymity/timing-correlation defence, so the offset is drawn from the
 * CSPRNG (randomBytes), never Math.random: no anonymity decision may depend on a reconstructible
 * non-cryptographic PRNG (audit #25), matching the CSPRNG discipline used for the enrollment
 * timestamp jitter and token generation. Exported for testability.
 */
export function randomPastTimestamp(): number {
  // 4 CSPRNG bytes → uint32 → uniform fraction in [0, 1), reproducing the distribution and bounds
  // of the former Math.random() * TWO_DAYS with a cryptographic source.
  const b = randomBytes(4);
  const u32 = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  return Math.round(Date.now() / 1000 - (u32 / 0x1_0000_0000) * TWO_DAYS);
}

/**
 * Build the inner (kind-13) seal for a DM, signed by the sender. This needs the sender's
 * secret key; the outer wrap (mined below) does not, so callers seal under the key guard and
 * mine outside it.
 */
export function createDmSeal(
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
  text: string,
  replyTo?: string,
): {seal: Event; rumorId: string} {
  const tags: string[][] = [['p', recipientPubkey]];
  // A reply quotes its parent via an `e` tag (the parent's RUMOR id) INSIDE the encrypted rumor, so
  // the relay never learns the thread structure. The recipient resolves it on decrypt.
  if (replyTo) tags.push(['e', replyTo]);
  const rumor = createRumor({kind: KIND_CHAT, content: text, tags}, senderSecretKey);
  return {seal: createSeal(rumor, senderSecretKey, recipientPubkey), rumorId: rumor.id};
}

/**
 * Build the inner seal for a DM REACTION (kind-7) targeting a message by its shared RUMOR id. Same
 * gift-wrap transport as a chat message (sealed to the peer, PoW-mined), so the relay only ever sees
 * an anonymous wrap. The recipient folds it onto the target message via {@link openDM}.
 */
export function createDmReactionSeal(
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
  targetRumorId: string,
  emoji: string,
): {seal: Event; rumorId: string} {
  const tags: string[][] = [['p', recipientPubkey], ['e', targetRumorId]];
  const rumor = createRumor({kind: DM_REACTION_KIND, content: emoji, tags}, senderSecretKey);
  return {seal: createSeal(rumor, senderSecretKey, recipientPubkey), rumorId: rumor.id};
}

// Fixed-width zero-padded nonce so the serialized byte length never changes during mining —
// lets us hash a single mutable buffer instead of re-serializing every attempt. 12 digits is
// far more than the millions of attempts a ~20-bit mine needs.
const NONCE_WIDTH = 12;

/** Leading zero bits of a raw 32-byte hash (NIP-13 difficulty), the relay's exact check. */
function leadingZeroBitsOf(hash: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < hash.length; i++) {
    const byte = hash[i]!;
    if (byte === 0) {
      count += 8;
      continue;
    }
    return count + Math.clz32(byte) - 24;
  }
  return count;
}

/**
 * Pure-JS miner: pre-serializes once and rewrites only the nonce digit bytes, hashing the
 * buffer directly (no JSON.stringify per attempt). Used as a fallback when the native miner
 * isn't available (tests, non-Android builds). Returns the winning nonce as a decimal string.
 *
 * NOTE: Hermes is ~28x slower than V8 here, so this is impractical at difficulty 20 on a
 * phone — the native StiqPow module is used there. Kept for low difficulties (tests) and as a
 * correctness reference.
 */
async function mineJs(
  serialized: string,
  nonceOffset: number,
  nonceWidth: number,
  difficulty: number,
): Promise<string> {
  const buffer = utf8ToBytes(serialized);
  let count = 0;
  for (;;) {
    let n = ++count;
    for (let i = nonceOffset + nonceWidth - 1; i >= nonceOffset; i--) {
      buffer[i] = 48 + (n % 10);
      n = Math.floor(n / 10);
    }
    if (leadingZeroBitsOf(sha256(buffer)) >= difficulty) break;
    if ((count & 0xffff) === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  return String(count);
}

/**
 * Assemble the outer NIP-59 gift wrap (kind 1059) around a seal AND mine the NIP-13 proof-of-
 * work our relay requires. The wrap is signed by a throwaway ephemeral key, so mining runs
 * outside the sender-key guard.
 *
 * Mining is delegated to the native StiqPow module (hardware SHA-256, sub-second) when present,
 * falling back to the pure-JS miner otherwise. The event is pre-serialized with a fixed-width
 * zero-padded nonce placeholder so the miner only rewrites those digits. Returns the signed,
 * PoW-bearing gift wrap ready to publish.
 *
 * `extraTags` (default undefined ⇒ byte-identical to today) is a backward-compatible seam for the
 * FMD evaluation prototype (T18-S4): any extra tags are appended AFTER the `nonce` tag so they are
 * covered by both the wrap id and the mined proof-of-work, yet the placeholder still resolves to
 * the nonce (it precedes `extraTags` in the serialized array). This function never reads config —
 * the caller decides whether to pass a flag tag, and only does so when FMD_EVAL_ENABLED (T18-S7),
 * so a shipped build passes nothing and the wrap is unchanged.
 */
export async function mineGiftWrap(
  seal: Event,
  recipientPubkey: string,
  difficulty: number,
  extraTags?: string[][],
  // Tokens-everywhere (SHIPS DARK): after the ephemeral wrap key is minted, this callback (when
  // present) returns space-write token tags — an all-proofs stiq_spend chain bound to the wrap's OWN
  // ephemeral pubkey — so a DM pays the same anti-spam price as any space write while staying
  // unattributable. It is given the wrap's pubkey and the weighable {content, tags} (BEFORE the token
  // tags, which are weight-exempt) so it can price the wrap. Absent ⇒ no token tags, DMs unchanged.
  attachTokens?: (wrapPubkeyHex: string, weighable: {content: string; tags: string[][]}) => Promise<string[][]>,
): Promise<Event> {
  const ephemeralSecretKey = generateSecretKey();
  const wrapPubkey = getPublicKey(ephemeralSecretKey);
  const conversationKey = nip44.utils.getConversationKey(ephemeralSecretKey, recipientPubkey);
  const placeholder = '0'.repeat(NONCE_WIDTH);
  const content = nip44.encrypt(JSON.stringify(seal), conversationKey);
  const baseTags = [
    ['p', recipientPubkey],
    ['nonce', placeholder, String(difficulty)],
    ...(extraTags ?? []),
  ] as string[][];
  // Space tokens (dark): priced over content + the base tags (token tags are weight-exempt), then
  // appended so they trail the nonce — `indexOf(placeholder)` below still lands on the nonce.
  const tokenTags = attachTokens ? await attachTokens(wrapPubkey, {content, tags: baseTags}) : [];
  const unsigned = {
    kind: Kind.GiftWrap,
    pubkey: wrapPubkey,
    created_at: randomPastTimestamp(),
    content,
    // The nonce value starts as a zero-padded placeholder; mining only rewrites these digits.
    // extraTags + tokenTags (if any) trail the nonce, so `indexOf(placeholder)` still lands on it.
    tags: [...baseTags, ...tokenTags] as string[][],
  };

  // NIP-01 serialization. Everything up to and including the nonce is ASCII (hex keys, digits),
  // so the placeholder's char offset equals its byte offset.
  const serialized = JSON.stringify([
    0,
    unsigned.pubkey,
    unsigned.created_at,
    unsigned.kind,
    unsigned.tags,
    unsigned.content,
  ]);
  const nonceOffset = serialized.indexOf(placeholder);

  const count = StiqPow
    ? await StiqPow.minePow(serialized, nonceOffset, NONCE_WIDTH, difficulty)
    : await mineJs(serialized, nonceOffset, NONCE_WIDTH, difficulty);

  // Commit the winning nonce, then finalizeEvent recomputes the identical id and signs it.
  unsigned.tags[1]![1] = count.padStart(NONCE_WIDTH, '0');
  return finalizeEvent(unsigned, ephemeralSecretKey);
}

/** The two nested rumor/seal shapes we recover from an unwrap, as nostr-tools' nip44Decrypt yields. */
interface UnsignedRumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * NIP-44 conversation-key cache (audit finding #2). Deriving a conversation key is one pure-JS
 * secp256k1 ECDH — the single slowest step of a DM unwrap on Hermes. Under NIP-59 the OUTER wrap is
 * signed by a throwaway ephemeral key (unique per wrap → uncacheable), but the INNER seal is signed
 * by the sender's REAL pubkey, which recurs across every message from that peer. Caching the seal's
 * `getConversationKey(mySecKey, senderPubkey)` collapses a busy thread's per-message ECDH down to one
 * per distinct sender.
 *
 * The cache holds ONLY derived per-peer conversation keys — never the raw identity secret key, so it
 * is safe to hold in memory across the transient key guard (the sk is passed in per lookup and
 * scrubbed by the guard as usual). It is keyed by sender pubkey and bound to one identity; callers
 * MUST {@link clear} it when the identity changes (community switch / duress) so no key derived under
 * one identity ever survives into another. Reuse the same instance across refreshes for the cache to
 * actually hit.
 */
export class ConversationKeyCache {
  private readonly keys = new Map<string, Uint8Array>();

  /**
   * Conversation key for `peerPubkey`: derived once via ECDH with `sk` (which the caller holds
   * transiently under the key guard), then served from the map. Passing `sk` per call — rather than
   * retaining it — keeps the raw key out of this long-lived object.
   */
  get(peerPubkey: string, sk: Uint8Array): Uint8Array {
    let key = this.keys.get(peerPubkey);
    if (!key) {
      key = nip44.utils.getConversationKey(sk, peerPubkey);
      this.keys.set(peerPubkey, key);
    }
    return key;
  }

  /** Number of distinct peer keys derived so far — lets tests assert the cache is doing its job. */
  get size(): number {
    return this.keys.size;
  }

  /** Drop every derived key (identity change / wipe). */
  clear(): void {
    this.keys.clear();
  }
}

/** A fresh, empty conversation-key cache. */
export function makeConversationKeyCache(): ConversationKeyCache {
  return new ConversationKeyCache();
}

/**
 * Unwrap a NIP-59 gift wrap using a shared conversation-key cache. Mirrors nostr-tools' unwrapEvent
 * (outer wrap decrypt → seal → inner rumor decrypt) but reuses the SENDER's cached conversation key
 * for the inner seal decrypt (finding #2). The outer decrypt still derives a fresh key per wrap
 * because the wrap pubkey is ephemeral. Throws (like unwrapEvent) if not addressed to us.
 */
function unwrapWithCache(wrap: Event, cache: ConversationKeyCache, sk: Uint8Array): UnsignedRumor {
  // Outer: ephemeral wrap pubkey — one-shot, never cached.
  const outerKey = nip44.utils.getConversationKey(sk, wrap.pubkey);
  const seal = JSON.parse(nip44.decrypt(wrap.content, outerKey)) as UnsignedRumor;
  // Inner: seal is signed by the sender's real pubkey — cache the conversation key per sender.
  const innerKey = cache.get(seal.pubkey, sk);
  return JSON.parse(nip44.decrypt(seal.content, innerKey)) as UnsignedRumor;
}

/** Turn a decrypted rumor + its wrap id into a DirectMessage (reaction vs chat message). */
function rumorToMessage(rumor: UnsignedRumor, wrapId: string): DirectMessage {
  const eTag = rumor.tags.find(t => t[0] === 'e' && t[1])?.[1];
  // A kind-7 rumor is a REACTION targeting `eTag` (a rumor id); a kind-14 rumor is a chat message
  // whose `eTag` (if any) is a reply reference.
  if (rumor.kind === DM_REACTION_KIND) {
    return {
      id: wrapId,
      rumorId: rumor.id,
      sender: rumor.pubkey,
      text: '',
      createdAt: rumor.created_at,
      reaction: {targetRumorId: eTag ?? '', emoji: rumor.content},
    };
  }
  return {
    id: wrapId,
    rumorId: rumor.id,
    sender: rumor.pubkey,
    text: rumor.content,
    createdAt: rumor.created_at,
    ...(eTag ? {replyTo: eTag} : {}),
  };
}

/** Open a gift wrap addressed to us. Throws if it is not decryptable with our key. */
export function openDM(wrap: Event, recipientSecretKey: Uint8Array): DirectMessage {
  return rumorToMessage(unwrapWithCache(wrap, new ConversationKeyCache(), recipientSecretKey), wrap.id);
}

/** Result of a decryption attempt, so callers can prune wraps that will never decrypt (finding #3). */
export interface InboxDecryptResult {
  /** Successfully decrypted messages, newest first. */
  messages: DirectMessage[];
  /** Wrap ids that threw on decrypt (not addressed to us / undecryptable) — safe to prune by age. */
  failedIds: string[];
}

/**
 * How many wraps to decrypt per key-guard entry. The caller (Identity) re-reads + scrubs the secret
 * key once per chunk and yields the JS thread between chunks (finding #1), so this bounds both how
 * long the raw key stays resident in RAM and how long the single Hermes thread is blocked before it
 * can service a touch/render. 32 unwraps (≈64 ECDH) is a small, sub-frame slice on-device.
 */
export const DECRYPT_CHUNK = 32;

/**
 * Decrypt ONE synchronous slice of gift wraps with the raw secret key already in hand (finding #1's
 * per-chunk key-guard re-entry; never yields, so the caller scrubs the key right after). Appends
 * successes to `out.messages` and undecryptable ids to `out.failedIds`, and shares `cache` across
 * chunks so a repeat sender derives its inner-seal conversation key once (finding #2). Returns the
 * index just past the last wrap consumed (its own kind-filtered scan makes it resumable).
 */
export function decryptInboxChunk(
  wraps: Event[],
  start: number,
  recipientSecretKey: Uint8Array,
  cache: ConversationKeyCache,
  out: InboxDecryptResult,
): number {
  let processed = 0;
  let i = start;
  for (; i < wraps.length && processed < DECRYPT_CHUNK; i++) {
    const wrap = wraps[i]!;
    if (wrap.kind !== Kind.GiftWrap) continue;
    processed++;
    try {
      out.messages.push(rumorToMessage(unwrapWithCache(wrap, cache, recipientSecretKey), wrap.id));
    } catch {
      // not addressed to us (or undecryptable) — record for age-based pruning, then ignore
      out.failedIds.push(wrap.id);
    }
  }
  return i;
}

/**
 * Decrypt every gift wrap meant for us; silently skip those that are not. Single-shot (no yielding) —
 * used by tests and by {@link openDM}. Production DM refresh drives {@link decryptInboxChunk} directly
 * so it can re-enter the key guard and yield between chunks; this convenience wrapper decrypts the
 * whole batch under one already-held key. Returns messages newest-first plus the undecryptable ids.
 */
export function readInbox(
  wraps: Event[],
  recipientSecretKey: Uint8Array,
  cache: ConversationKeyCache = new ConversationKeyCache(),
): InboxDecryptResult {
  const out: InboxDecryptResult = {messages: [], failedIds: []};
  let i = 0;
  while (i < wraps.length) i = decryptInboxChunk(wraps, i, recipientSecretKey, cache, out);
  out.messages.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}
