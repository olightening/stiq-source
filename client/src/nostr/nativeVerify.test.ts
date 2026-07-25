/**
 * createEventVerifier parity — the native-schnorr ingest verifier must be PROVABLY identical in
 * accept/reject behaviour to nostr-tools' pure-JS `verifyEvent` (the security authority: RelayClient
 * stores an event only if this verifier passes it). The "native" module here is a jest fake backed
 * by @noble/curves schnorr.verify — the same curve math the real StiqSchnorr module runs via
 * libsecp256k1 — injected through the factory's test-only override parameters.
 */
import {finalizeEvent, generateSecretKey, verifyEvent, type Event} from 'nostr-tools/pure';
import {schnorr} from '@noble/curves/secp256k1.js';
import {createEventVerifier, type SchnorrNativeModule} from './nativeVerify';

/** Strict hex → bytes (throws on non-hex), mirroring the Kotlin module's hexToBytes. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Behaves exactly like the Kotlin module: schnorr verify, false (never a throw) on bad input. */
const fakeNative: SchnorrNativeModule = {
  verify: (pubkeyHex, msgHashHex, sigHex) => {
    try {
      return schnorr.verify(hexToBytes(sigHex), hexToBytes(msgHashHex), hexToBytes(pubkeyHex));
    } catch {
      return false;
    }
  },
};

const throwingNative: SchnorrNativeModule = {
  verify: () => {
    throw new Error('bridge exploded');
  },
};

/**
 * Plain-object clone. finalizeEvent returns a VerifiedEvent carrying nostr-tools' verifiedSymbol
 * cache, which makes verifyEvent short-circuit true — the clone strips it so BOTH paths actually
 * verify, and tampered copies can't inherit a cached pass.
 */
const clone = (e: Event): Event => JSON.parse(JSON.stringify(e)) as Event;

function signedEvent(content = 'hello'): Event {
  return clone(
    finalizeEvent(
      {kind: 1, created_at: 1_700_000_000, tags: [['t', 'x']], content},
      generateSecretKey(),
    ),
  );
}

describe('createEventVerifier parity with verifyEvent', () => {
  const native = createEventVerifier(fakeNative, true);

  /** Assert the native-backed verifier and pure-JS verifyEvent agree on `event`. */
  const expectParity = (event: Event, expected: boolean): void => {
    expect(verifyEvent(clone(event))).toBe(expected);
    expect(native(clone(event))).toBe(expected);
  };

  it('accepts a validly signed event', () => {
    expectParity(signedEvent(), true);
  });

  it('rejects tampered content (id no longer matches)', () => {
    const e = signedEvent();
    e.content = 'tampered';
    expectParity(e, false);
  });

  it('rejects a tampered signature', () => {
    const e = signedEvent();
    e.sig = (e.sig[0] === '0' ? '1' : '0') + e.sig.slice(1);
    expectParity(e, false);
  });

  it('rejects a signature transplanted from another event', () => {
    const a = signedEvent('one');
    const b = signedEvent('two');
    a.sig = b.sig;
    expectParity(a, false);
  });

  it('rejects an event signed by a different key than its pubkey claims', () => {
    const a = signedEvent();
    const b = signedEvent();
    a.pubkey = b.pubkey; // id changes under the new pubkey → id/hash mismatch
    expectParity(a, false);
  });

  it('rejects structurally invalid events', () => {
    const e = signedEvent();
    const missingSig = {...clone(e)} as Partial<Event>;
    delete missingSig.sig;
    expectParity(missingSig as Event, false);
    const badKind = {...clone(e), kind: 'one'} as unknown as Event;
    expectParity(badKind, false);
    const badTags = {...clone(e), tags: 'nope'} as unknown as Event;
    expectParity(badTags, false);
  });

  it('rejects garbage hex in pubkey/sig without throwing', () => {
    const e = signedEvent();
    e.pubkey = 'z'.repeat(64); // invalid hex — id recomputes fine, curve parse fails on both paths
    const g = clone(e);
    expect(native(g)).toBe(verifyEvent(clone(e)));
  });

  it('falls back to pure-JS verifyEvent when the native call throws', () => {
    const verifier = createEventVerifier(throwingNative, true);
    const good = signedEvent();
    expect(verifier(clone(good))).toBe(true); // fallback verdict, not a hard false
    const bad = signedEvent();
    bad.content = 'tampered';
    expect(verifier(clone(bad))).toBe(false);
  });

  it('returns verifyEvent itself when the flag is off or the module is absent', () => {
    expect(createEventVerifier(fakeNative, false)).toBe(verifyEvent);
    expect(createEventVerifier(null, true)).toBe(verifyEvent);
    expect(createEventVerifier(undefined, true)).toBe(verifyEvent); // NativeModules lookup in jest → absent
  });
});
