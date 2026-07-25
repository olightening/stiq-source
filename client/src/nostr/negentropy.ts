/**
 * NIP-77 Negentropy — set reconciliation, ported to pure TypeScript from go-nostr's
 * `nip77/negentropy` (the same implementation the stiq relay runs via khatru). Reconciling
 * with the relay tells us exactly which event ids it has that we don't, so we fetch only the
 * delta instead of re-streaming overlapping history — a real bandwidth win over Tor.
 *
 * This is a faithful wire-compatible port: the encoding (varint + delta-coded timestamps +
 * bounds), the fingerprint accumulator (8×uint32 little-endian add → SHA-256, first 16 bytes),
 * and the recursive range/fingerprint/id-list protocol must match the Go side byte-for-byte or
 * the relay rejects our frames. Both the initiator (client) and responder (server) roles are
 * implemented so the algorithm can be unit-tested end-to-end without a live relay.
 *
 * Numbers: Nostr timestamps are unix seconds (well under 2^53), so plain JS numbers are exact.
 * The "infinite" sentinel bound uses MAX_TIMESTAMP and is always the terminal bound in a
 * message (matching Go, which relies on the same property to avoid int64 overflow).
 */
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js';

const PROTOCOL_VERSION = 0x61; // version 1
/**
 * DEFAULT initiator fan-out: how many sub-ranges `splitRange()` divides a mismatched range
 * into per round. This is a purely LOCAL tuning knob, NOT a wire constant — negentropy bounds
 * are explicit on the wire, so the responder fingerprints exactly whatever ranges arrive
 * regardless of how the initiator chose to split. A higher fan-out means fewer round-trips at
 * the cost of larger frames — see the `buckets` constructor param (T10 Tor sync tuning).
 */
const DEFAULT_BUCKETS = 16;
const FINGERPRINT_SIZE = 16; // bytes
/** Sentinel for the open upper bound. Real timestamps never reach this, so it sorts last. */
export const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

enum Mode {
  Skip = 0,
  Fingerprint = 1,
  IdList = 2,
}

export interface Item {
  timestamp: number;
  /** 64-char lowercase hex event id. */
  id: string;
}

interface Bound {
  timestamp: number;
  /** Hex prefix (possibly shorter than a full id, or empty). */
  id: string;
}

const INFINITE_BOUND: Bound = {timestamp: MAX_TIMESTAMP, id: ''};

/** Order items by timestamp, then lexicographically by hex id (matches Go's ItemCompare). */
function itemCompare(a: Item, b: Item): number {
  if (a.timestamp === b.timestamp) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  return a.timestamp < b.timestamp ? -1 : 1;
}

// ── varint (base-128, big-endian, high bit = continuation) ──────────────────────────────────

/** Encode a non-negative integer as a Go-compatible varint (byte values). */
export function encodeVarInt(n: number): number[] {
  if (n === 0) return [0];
  const out: number[] = [];
  while (n !== 0) {
    out.unshift(n % 128);
    n = Math.floor(n / 128);
  }
  for (let i = 0; i < out.length - 1; i++) {
    out[i] = (out[i] as number) | 0x80;
  }
  return out;
}

// ── fingerprint accumulator (8×uint32 little-endian add with carry, then SHA-256) ───────────

class Accumulator {
  private readonly buf = new Uint8Array(32);
  private readonly view = new DataView(this.buf.buffer);

  reset(): void {
    this.buf.fill(0);
  }

  /** Add a 32-byte value as eight little-endian uint32 words, propagating carry. */
  addBytes(other: Uint8Array): void {
    const otherView = new DataView(other.buffer, other.byteOffset, other.byteLength);
    let carry = 0;
    for (let i = 0; i < 8; i++) {
      const offset = i * 4;
      const orig = this.view.getUint32(offset, true);
      const sum = orig + carry + otherView.getUint32(offset, true);
      // sum may exceed 2^32; low 32 bits are the word, the rest is the carry.
      this.view.setUint32(offset, sum >>> 0, true);
      carry = Math.floor(sum / 0x100000000);
    }
  }

  /** SHA-256 of (accumulated 32 bytes ++ varint(count)), truncated to FINGERPRINT_SIZE bytes. */
  getFingerprint(count: number): string {
    const input = new Uint8Array(32 + 8);
    input.set(this.buf, 0);
    const tail = encodeVarInt(count);
    input.set(tail, 32);
    const hash = sha256(input.subarray(0, 32 + tail.length));
    return bytesToHex(hash.subarray(0, FINGERPRINT_SIZE));
  }
}

// ── sorted storage with range fingerprints ──────────────────────────────────────────────────

/** A sealed, sorted collection of items supporting range fingerprints and lower-bound search. */
export class NegentropyStorage {
  private readonly items: Item[];
  private readonly acc = new Accumulator();

  private constructor(items: Item[]) {
    this.items = items;
  }

  /** Build a sealed storage from arbitrary {id, timestamp} items (deduped, sorted). */
  static fromItems(items: Item[]): NegentropyStorage {
    const seen = new Set<string>();
    const deduped: Item[] = [];
    for (const it of items) {
      if (it.id.length !== 64 || seen.has(it.id)) continue;
      seen.add(it.id);
      deduped.push({timestamp: it.timestamp, id: it.id});
    }
    deduped.sort(itemCompare);
    return new NegentropyStorage(deduped);
  }

  get size(): number {
    return this.items.length;
  }

  range(begin: number, end: number): Item[] {
    return this.items.slice(begin, end);
  }

  /** First index in [begin, end) whose item is >= bound (binary lower_bound). */
  findLowerBound(begin: number, end: number, bound: Bound): number {
    const target: Item = {timestamp: bound.timestamp, id: bound.id};
    let lo = begin;
    let hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (itemCompare(this.items[mid] as Item, target) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  fingerprint(begin: number, end: number): string {
    this.acc.reset();
    for (let i = begin; i < end; i++) {
      this.acc.addBytes(hexToBytes((this.items[i] as Item).id));
    }
    return this.acc.getFingerprint(end - begin);
  }
}

// ── hex stream reader / writer ───────────────────────────────────────────────────────────────

class HexReader {
  private idx = 0;
  constructor(private readonly src: string) {}

  get len(): number {
    return this.src.length - this.idx;
  }

  readHexByte(): number {
    if (this.src.length < this.idx + 2) throw new Error('negentropy: short read');
    const b = parseInt(this.src.slice(this.idx, this.idx + 2), 16);
    this.idx += 2;
    if (Number.isNaN(b)) throw new Error('negentropy: bad hex');
    return b;
  }

  readString(hexLen: number): string {
    if (this.src.length < this.idx + hexLen) throw new Error('negentropy: short read');
    const s = this.src.slice(this.idx, this.idx + hexLen);
    this.idx += hexLen;
    return s;
  }
}

class HexWriter {
  private buf = '';

  /** Length in hex characters (Go's StringHexWriter.Len). */
  get len(): number {
    return this.buf.length;
  }

  hex(): string {
    return this.buf;
  }

  reset(): void {
    this.buf = '';
  }

  writeByte(b: number): void {
    this.buf += (b & 0xff).toString(16).padStart(2, '0');
  }

  writeHex(hex: string): void {
    this.buf += hex;
  }

  writeBytes(bytes: number[]): void {
    for (const b of bytes) this.writeByte(b);
  }
}

// ── the protocol engine ──────────────────────────────────────────────────────────────────────

/** Result of feeding one inbound message to the engine. */
export interface ReconcileResult {
  /** Next outbound message (hex), or null when the client has finished reconciling. */
  output: string | null;
  /** Ids the relay has that we don't — fetch these (only populated for the client role). */
  need: string[];
  /** Ids we have that the relay doesn't (only populated for the client role). */
  have: string[];
}

export class Negentropy {
  private readonly frameSizeLimit: number;
  private readonly buckets: number;
  private isClient = false;
  private lastTimestampIn = 0;
  private lastTimestampOut = 0;
  private need: string[] = [];
  private have: string[] = [];

  /**
   * @param storage sealed local items to reconcile against the peer.
   * @param frameSizeLimit max bytes per outbound frame (0 = unlimited). Must be 0 or >= 4096.
   * @param buckets initiator range fan-out (local tuning knob, wire-compatible). Integer in
   *   [2,256]; defaults to DEFAULT_BUCKETS (16). Higher = fewer rounds, larger frames.
   */
  constructor(
    private readonly storage: NegentropyStorage,
    frameSizeLimit = 0,
    buckets: number = DEFAULT_BUCKETS,
  ) {
    if (frameSizeLimit !== 0 && frameSizeLimit < 4096) {
      throw new Error('negentropy: frameSizeLimit must be 0 or >= 4096');
    }
    if (!Number.isInteger(buckets) || buckets < 2 || buckets > 256) {
      throw new Error('negentropy: buckets must be an integer in [2,256]');
    }
    this.frameSizeLimit = frameSizeLimit === 0 ? Infinity : frameSizeLimit;
    this.buckets = buckets;
  }

  /** Client role: produce the opening message (protocol version + initial range split). */
  initiate(): string {
    this.isClient = true;
    const out = new HexWriter();
    out.writeByte(PROTOCOL_VERSION);
    this.splitRange(0, this.storage.size, INFINITE_BOUND, out);
    return out.hex();
  }

  /**
   * Process an inbound message and produce the reply. For the client, `need`/`have` carry the
   * ids discovered in THIS message and `output` is null once reconciliation is complete.
   */
  reconcile(msg: string): ReconcileResult {
    this.need = [];
    this.have = [];
    const out = this.reconcileAux(new HexReader(msg));
    if (out.length === 2 && this.isClient) {
      return {output: null, need: this.need, have: this.have};
    }
    return {output: out, need: this.need, have: this.have};
  }

  private reconcileAux(reader: HexReader): string {
    this.lastTimestampIn = 0;
    this.lastTimestampOut = 0;

    const fullOutput = new HexWriter();
    fullOutput.writeByte(PROTOCOL_VERSION);

    const pv = reader.readHexByte();
    if (pv !== PROTOCOL_VERSION) {
      if (this.isClient) throw new Error(`negentropy: unsupported protocol version ${pv}`);
      // Server replies with its own version so the client can downgrade/abort.
      return fullOutput.hex();
    }

    let prevBound: Bound = {timestamp: 0, id: ''};
    let prevIndex = 0;
    // `skipping` coalesces consecutive matched ranges: nothing is emitted while it's true; a
    // pending skip is flushed (as one Skip bound at prevBound) only when a non-skip range
    // follows. A skip still open at end-of-message is simply dropped (= "done up to here").
    let skipping = false;

    const partial = new HexWriter(); // reset and reused each iteration

    while (reader.len > 0) {
      partial.reset();

      const finishSkip = (): void => {
        if (skipping) {
          skipping = false;
          this.writeBound(partial, prevBound);
          partial.writeByte(Mode.Skip);
        }
      };

      const currBound = this.readBound(reader);
      const mode = this.readVarInt(reader) as Mode;

      const lower = prevIndex;
      let upper = this.storage.findLowerBound(prevIndex, this.storage.size, currBound);

      switch (mode) {
        case Mode.Skip:
          skipping = true;
          break;

        case Mode.Fingerprint: {
          const theirFingerprint = reader.readString(FINGERPRINT_SIZE * 2);
          const ourFingerprint = this.storage.fingerprint(lower, upper);
          if (theirFingerprint === ourFingerprint) {
            skipping = true;
          } else {
            finishSkip();
            this.splitRange(lower, upper, currBound, partial);
          }
          break;
        }

        case Mode.IdList: {
          const numIds = this.readVarInt(reader);
          const theirItems = new Set<string>();
          for (let i = 0; i < numIds; i++) {
            theirItems.add(reader.readString(64));
          }

          for (const item of this.storage.range(lower, upper)) {
            if (theirItems.has(item.id)) {
              theirItems.delete(item.id); // both have it
            } else if (this.isClient) {
              this.have.push(item.id); // we have, they don't
            }
          }

          if (this.isClient) {
            for (const id of theirItems) {
              this.need.push(id); // they have, we don't
            }
            skipping = true;
          } else {
            // Server: reply with our own ids for the same range.
            finishSkip();

            let responseIds = '';
            let responses = 0;
            let endBound = currBound;
            const range = this.storage.range(lower, upper);
            for (let index = 0; index < range.length; index++) {
              const it = range[index] as Item;
              if (this.frameSizeLimit - 200 < fullOutput.len / 2 + responseIds.length / 2) {
                endBound = {timestamp: it.timestamp, id: it.id};
                upper = lower + index;
                break;
              }
              responseIds += it.id;
              responses++;
            }

            this.writeBound(partial, endBound);
            partial.writeByte(Mode.IdList);
            partial.writeBytes(encodeVarInt(responses));
            partial.writeHex(responseIds);

            fullOutput.writeHex(partial.hex());
            partial.reset();
          }
          break;
        }

        default:
          throw new Error(`negentropy: unexpected mode ${mode}`);
      }

      if (this.frameSizeLimit - 200 < fullOutput.len / 2 + partial.len / 2) {
        // Frame full: coalesce the remainder into a single fingerprint bound and stop.
        const remainingFingerprint = this.storage.fingerprint(upper, this.storage.size);
        this.writeBound(fullOutput, INFINITE_BOUND);
        fullOutput.writeByte(Mode.Fingerprint);
        fullOutput.writeHex(remainingFingerprint);
        break;
      } else {
        fullOutput.writeHex(partial.hex());
      }

      prevIndex = upper;
      prevBound = currBound;
    }

    return fullOutput.hex();
  }

  private splitRange(lower: number, upper: number, upperBound: Bound, output: HexWriter): void {
    const numElems = upper - lower;

    if (numElems < this.buckets * 2) {
      // Small range: send the full id list.
      this.writeBound(output, upperBound);
      output.writeByte(Mode.IdList);
      output.writeBytes(encodeVarInt(numElems));
      for (const item of this.storage.range(lower, upper)) {
        output.writeHex(item.id);
      }
    } else {
      const itemsPerBucket = Math.floor(numElems / this.buckets);
      const bucketsWithExtra = numElems % this.buckets;
      let curr = lower;

      for (let i = 0; i < this.buckets; i++) {
        const bucketSize = itemsPerBucket + (i < bucketsWithExtra ? 1 : 0);
        const ourFingerprint = this.storage.fingerprint(curr, curr + bucketSize);
        curr += bucketSize;

        let nextBound: Bound;
        if (curr === upper) {
          nextBound = upperBound;
        } else {
          const pair = this.storage.range(curr - 1, curr + 1);
          nextBound = getMinimalBound(pair[0] as Item, pair[1] as Item);
        }

        this.writeBound(output, nextBound);
        output.writeByte(Mode.Fingerprint);
        output.writeHex(ourFingerprint);
      }
    }
  }

  // ── timestamp / bound (de)serialization ────────────────────────────────────────────────────

  private readTimestamp(reader: HexReader): number {
    const delta = this.readVarInt(reader);
    if (delta === 0) {
      this.lastTimestampIn = MAX_TIMESTAMP; // zero encodes infinite
      return MAX_TIMESTAMP;
    }
    const timestamp = this.lastTimestampIn + (delta - 1);
    this.lastTimestampIn = timestamp;
    return timestamp;
  }

  private readBound(reader: HexReader): Bound {
    const timestamp = this.readTimestamp(reader);
    const length = this.readVarInt(reader);
    const id = reader.readString(length * 2);
    return {timestamp, id};
  }

  private writeTimestamp(w: HexWriter, timestamp: number): void {
    if (timestamp === MAX_TIMESTAMP) {
      this.lastTimestampOut = MAX_TIMESTAMP;
      w.writeBytes(encodeVarInt(0));
      return;
    }
    const delta = timestamp - this.lastTimestampOut;
    this.lastTimestampOut = timestamp;
    w.writeBytes(encodeVarInt(delta + 1));
  }

  private writeBound(w: HexWriter, bound: Bound): void {
    this.writeTimestamp(w, bound.timestamp);
    w.writeBytes(encodeVarInt(bound.id.length / 2));
    w.writeHex(bound.id);
  }

  private readVarInt(reader: HexReader): number {
    let res = 0;
    for (;;) {
      const b = reader.readHexByte();
      res = res * 128 + (b & 127);
      if ((b & 128) === 0) break;
    }
    return res;
  }
}

/** Smallest bound that separates `prev` from `curr` (matches Go's getMinimalBound). */
function getMinimalBound(prev: Item, curr: Item): Bound {
  if (curr.timestamp !== prev.timestamp) {
    return {timestamp: curr.timestamp, id: ''};
  }
  let sharedPrefixBytes = 0;
  // Compare up to the first 16 bytes (32 hex chars), as the Go implementation does.
  for (let i = 0; i < 32; i += 2) {
    if (curr.id.slice(i, i + 2) !== prev.id.slice(i, i + 2)) break;
    sharedPrefixBytes++;
  }
  return {timestamp: curr.timestamp, id: curr.id.slice(0, (sharedPrefixBytes + 1) * 2)};
}
