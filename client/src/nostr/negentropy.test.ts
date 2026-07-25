/**
 * Negentropy (NIP-77) reconciliation tests. The headline test drives a full client↔server
 * handshake between two TS engines over varied set differences and asserts the client recovers
 * the EXACT delta (need = relay-only ids, have = local-only ids). Because both roles are the
 * faithful port of go-nostr, a green run here is strong evidence the wire format matches the
 * relay too.
 */
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {
  Negentropy,
  NegentropyStorage,
  encodeVarInt,
  type Item,
} from './negentropy';

/** Deterministic, well-distributed 64-hex id for index n. */
function idFor(n: number): string {
  return bytesToHex(sha256(new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0x53])));
}

/** A shared universe of events; timestamps intentionally collide to exercise prefix bounds. */
function universe(n: number): Item[] {
  return Array.from({length: n}, (_, i) => ({id: idFor(i), timestamp: 1000 + (i % 50)}));
}

/** Drive a complete reconciliation; return the client's discovered delta. */
function sync(
  localIdx: Set<number>,
  remoteIdx: Set<number>,
  total: number,
  frameLimit = 0,
  buckets?: number,
): {
  need: Set<string>;
  have: Set<string>;
  rounds: number;
} {
  const all = universe(total);
  const local = NegentropyStorage.fromItems(all.filter((_, i) => localIdx.has(i)));
  const remote = NegentropyStorage.fromItems(all.filter((_, i) => remoteIdx.has(i)));

  // The initiator's fan-out (`buckets`) is a purely local knob; the responder reads explicit
  // bounds, so it keeps the default. Passing undefined exercises DEFAULT_BUCKETS (16).
  const client = new Negentropy(local, 0, buckets);
  const server = new Negentropy(remote, frameLimit);

  const need = new Set<string>();
  const have = new Set<string>();

  let msg = client.initiate();
  let rounds = 0; // number of server→client message exchanges
  for (let guard = 0; guard < 1000; guard++) {
    const serverOut = server.reconcile(msg).output;
    if (serverOut == null) throw new Error('server should never signal done');
    const c = client.reconcile(serverOut);
    rounds++;
    c.need.forEach(id => need.add(id));
    c.have.forEach(id => have.add(id));
    if (c.output == null) break;
    msg = c.output;
  }
  return {need, have, rounds};
}

function expectedDelta(localIdx: Set<number>, remoteIdx: Set<number>, total: number) {
  const need = new Set<string>();
  const have = new Set<string>();
  for (let i = 0; i < total; i++) {
    if (remoteIdx.has(i) && !localIdx.has(i)) need.add(idFor(i));
    if (localIdx.has(i) && !remoteIdx.has(i)) have.add(idFor(i));
  }
  return {need, have};
}

describe('encodeVarInt', () => {
  it('encodes zero as a single zero byte', () => {
    expect(encodeVarInt(0)).toEqual([0]);
  });

  it('encodes small values in one byte', () => {
    expect(encodeVarInt(1)).toEqual([1]);
    expect(encodeVarInt(127)).toEqual([127]);
  });

  it('uses continuation bits for multi-byte values', () => {
    // 128 = 0b1_0000000 → [0x81, 0x00]
    expect(encodeVarInt(128)).toEqual([0x81, 0x00]);
    expect(encodeVarInt(300)).toEqual([0x82, 0x2c]);
  });
});

describe('NegentropyStorage', () => {
  it('produces an order-independent fingerprint for the same set', () => {
    const items = universe(40);
    const a = NegentropyStorage.fromItems(items);
    const b = NegentropyStorage.fromItems([...items].reverse());
    expect(a.fingerprint(0, a.size)).toEqual(b.fingerprint(0, b.size));
  });

  it('changes the fingerprint when membership differs', () => {
    const a = NegentropyStorage.fromItems(universe(40));
    const b = NegentropyStorage.fromItems(universe(39));
    expect(a.fingerprint(0, a.size)).not.toEqual(b.fingerprint(0, b.size));
  });

  it('dedupes and rejects malformed ids', () => {
    const dup = {id: idFor(1), timestamp: 5};
    const bad = {id: 'abc', timestamp: 5};
    const s = NegentropyStorage.fromItems([dup, dup, bad]);
    expect(s.size).toBe(1);
  });
});

describe('Negentropy reconciliation', () => {
  it('finds nothing when both sides are identical', () => {
    const idx = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
    const {need, have} = sync(idx, idx, 10);
    expect(need.size).toBe(0);
    expect(have.size).toBe(0);
  });

  it('reports every remote-only id as needed (cold local cache)', () => {
    const local = new Set<number>();
    const remote = new Set([0, 1, 2, 3, 4]);
    const {need, have} = sync(local, remote, 5);
    const exp = expectedDelta(local, remote, 5);
    expect(need).toEqual(exp.need);
    expect(have.size).toBe(0);
  });

  it('recovers a small bidirectional delta', () => {
    const local = new Set([0, 1, 2, 3, 4]);
    const remote = new Set([3, 4, 5, 6, 7]);
    const {need, have} = sync(local, remote, 8);
    const exp = expectedDelta(local, remote, 8);
    expect(need).toEqual(exp.need); // 5,6,7
    expect(have).toEqual(exp.have); // 0,1,2
  });

  it('recovers a large delta requiring multi-round fingerprint recursion', () => {
    // >16*32 items per side so the top-level buckets are themselves large enough to recurse
    // (rather than resolving to a single id-list), forcing several reconciliation rounds.
    const total = 2000;
    const local = new Set<number>();
    const remote = new Set<number>();
    for (let i = 0; i < total; i++) {
      if (i % 3 !== 0) local.add(i); // local is missing every 3rd id
      if (i % 5 !== 0) remote.add(i); // remote is missing every 5th id
    }
    const {need, have, rounds} = sync(local, remote, total);
    const exp = expectedDelta(local, remote, total);
    expect(need).toEqual(exp.need);
    expect(have).toEqual(exp.have);
    expect(rounds).toBeGreaterThan(1); // genuinely multi-round, not a trivial id-list
  });

  it('converges under a constrained server frame size', () => {
    const total = 300;
    const local = new Set<number>();
    const remote = new Set<number>();
    for (let i = 0; i < total; i++) {
      if (i % 4 !== 0) local.add(i);
      remote.add(i);
    }
    const {need, have} = sync(local, remote, total, 4096);
    const exp = expectedDelta(local, remote, total);
    expect(need).toEqual(exp.need);
    expect(have).toEqual(exp.have);
  });
});

describe('Negentropy branching factor (buckets)', () => {
  // A large set difference: local missing every 5th id, remote missing every 7th (~200+ delta
  // each way over total=1000), big enough to force multi-round fingerprint recursion.
  const total = 1000;
  const local = new Set<number>();
  const remote = new Set<number>();
  for (let i = 0; i < total; i++) {
    if (i % 5 !== 0) local.add(i);
    if (i % 7 !== 0) remote.add(i);
  }
  const exp = expectedDelta(local, remote, total);

  it('recovers the identical delta regardless of initiator fan-out (bounds are explicit)', () => {
    const r16 = sync(local, remote, total, 0, 16);
    const r32 = sync(local, remote, total, 0, 32);
    const r64 = sync(local, remote, total, 0, 64);
    for (const r of [r16, r32, r64]) {
      expect(r.need).toEqual(exp.need);
      expect(r.have).toEqual(exp.have);
    }
  });

  it('takes strictly fewer-or-equal rounds as fan-out grows', () => {
    const rounds16 = sync(local, remote, total, 0, 16).rounds;
    const rounds32 = sync(local, remote, total, 0, 32).rounds;
    const rounds64 = sync(local, remote, total, 0, 64).rounds;
    expect(rounds32).toBeLessThanOrEqual(rounds16);
    expect(rounds64).toBeLessThanOrEqual(rounds32);
  });

  it('rejects an out-of-range or non-integer bucket count at construction', () => {
    const s = NegentropyStorage.fromItems(universe(4));
    for (const bad of [0, 1, 300, 2.5]) {
      expect(() => new Negentropy(s, 0, bad)).toThrow(/buckets must be an integer/);
    }
  });
});
