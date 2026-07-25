/**
 * NIP-13 proof-of-work (PLAN.md §4.1 / Step 16). The relay gates DM gift wraps on PoW; this
 * mines the required difficulty into an event before signing. (Wiring this into the NIP-17
 * gift wrap needs a custom wrap that exposes the nonce — see DEFERRED in dm/README.md.)
 */
import {getEventHash} from 'nostr-tools/pure';
import {sha256} from '@noble/hashes/sha2.js';
import {utf8ToBytes} from '@noble/hashes/utils.js';
import {NativeModules} from 'react-native';

/**
 * Native hardware PoW miner (Android StiqPow) — hashes on a background thread, returning the winning
 * nonce as a decimal string. Same module dm.ts uses for gift-wrap PoW. Absent under Jest / non-Android
 * builds, where the pure-JS fallback runs instead.
 */
interface PowNativeModule {
  minePow(serialized: string, nonceOffset: number, nonceWidth: number, difficulty: number): Promise<string>;
}
const StiqPow = (NativeModules as {StiqPow?: PowNativeModule}).StiqPow;

export interface MinableEvent {
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** Count the leading zero bits of a hex event id (the NIP-13 difficulty). */
export function countLeadingZeroBits(idHex: string): number {
  let count = 0;
  for (const char of idHex) {
    const nibble = parseInt(char, 16);
    if (Number.isNaN(nibble)) {
      break;
    }
    if (nibble === 0) {
      count += 4;
      continue;
    }
    // eslint-disable-next-line no-bitwise -- counting zero bits in a nibble
    for (let mask = 0x8; mask > 0; mask >>= 1) {
      // eslint-disable-next-line no-bitwise
      if (nibble & mask) {
        break;
      }
      count += 1;
    }
    break;
  }
  return count;
}

/**
 * Mine a `nonce` tag so the event id has at least `difficulty` leading zero bits. Returns a
 * new event (the caller signs it; signing recomputes the same id).
 */
export function mineEvent(event: MinableEvent, difficulty: number): MinableEvent {
  let nonce = 0;
  for (;;) {
    const tags = [
      ...event.tags.filter(tag => tag[0] !== 'nonce'),
      ['nonce', String(nonce), String(difficulty)],
    ];
    const candidate = {...event, tags};
    if (countLeadingZeroBits(getEventHash(candidate)) >= difficulty) {
      return candidate;
    }
    nonce += 1;
  }
}

// Fixed-width zero-padded nonce so the serialized byte length never changes during mining — lets the
// miner hash one mutable buffer instead of re-serializing per attempt. 12 digits >> any real mine.
const NONCE_WIDTH = 12;

/** Leading zero bits of a raw 32-byte hash — the relay's exact NIP-13 check (LeadingZeroBits(id)). */
function leadingZeroBitsOfHash(hash: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < hash.length; i++) {
    const byte = hash[i]!;
    if (byte === 0) {
      count += 8;
      continue;
    }
    // eslint-disable-next-line no-bitwise -- counting the leading zero bits of a byte
    return count + Math.clz32(byte) - 24;
  }
  return count;
}

/**
 * Pure-JS miner: pre-serializes once and rewrites only the nonce digit bytes, hashing the buffer
 * directly (no getEventHash per attempt). Yields the JS thread every 64k attempts so a slow mine
 * never blocks touch/render. Fallback for tests / non-Android; mirrors dm.ts's mineJs exactly.
 */
async function mineNonceJs(
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
    if (leadingZeroBitsOfHash(sha256(buffer)) >= difficulty) break;
    // eslint-disable-next-line no-bitwise -- cheap "every 65536th iteration" check
    if ((count & 0xffff) === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  return String(count);
}

/**
 * Async NIP-13 miner that delegates to the native StiqPow module (hardware SHA-256, sub-second) when
 * present, falling back to the chunked-yield pure-JS miner otherwise. Identical DIFFICULTY and TAG
 * semantics to {@link mineEvent} — it mines the SAME `['nonce', <value>, String(difficulty)]` tag to
 * the SAME target (id has >= `difficulty` leading zero bits); only WHO computes the hash changes. The
 * winning nonce is zero-padded to a fixed width, which is irrelevant to the relay (it checks only the
 * event id's leading zero bits). Use this on real user paths (enrollment); keep the sync `mineEvent`
 * for tiny test difficulties and callers that can't await.
 */
export async function mineEventPow(event: MinableEvent, difficulty: number): Promise<MinableEvent> {
  if (difficulty <= 0) {
    // No PoW required — attach a zero nonce tag for shape parity and return immediately.
    return {...event, tags: [...event.tags.filter(t => t[0] !== 'nonce'), ['nonce', '0', '0']]};
  }
  const placeholder = '0'.repeat(NONCE_WIDTH);
  const tags = [...event.tags.filter(t => t[0] !== 'nonce'), ['nonce', placeholder, String(difficulty)]];

  // NIP-01 id preimage: [0, pubkey, created_at, kind, tags, content]. Everything up to and including
  // the nonce placeholder is ASCII (hex pubkey, digits, tag strings), so its char offset == byte offset.
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, tags, event.content]);
  const nonceOffset = serialized.indexOf(placeholder);

  const count = StiqPow
    ? await StiqPow.minePow(serialized, nonceOffset, NONCE_WIDTH, difficulty)
    : await mineNonceJs(serialized, nonceOffset, NONCE_WIDTH, difficulty);

  tags[tags.length - 1]![1] = count.padStart(NONCE_WIDTH, '0');
  return {...event, tags};
}
