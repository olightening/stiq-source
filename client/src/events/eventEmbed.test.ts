/**
 * eventEmbed.ts — `de` (description snippet) wire support, added 2026-07-22 so an event card shared
 * as a `stiq:event:…` token can show its description immediately instead of only after the full
 * kind-31923 doc resolves (see EventDetailHost's degraded-VM upgrade path).
 */
import {utf8ToBytes, bytesToUtf8} from '@noble/hashes/utils.js';
import {bytesToBase64} from '../util/base64';
import {EVENT_EMBED_PREFIX, encodeEventEmbed, parseEventEmbed} from './eventEmbed';
import type {EventAddr} from './types';

const PK = 'a'.repeat(64);
const ADDR: EventAddr = {pubkey: PK, d: 'my-event'};

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Hand-build a raw token from an arbitrary wire object — lets tests simulate an OLD token (no
 * `de` key at all) or a hostile/malformed one without going through the real encoder. */
function rawToken(wire: unknown): string {
  return EVENT_EMBED_PREFIX + toBase64Url(utf8ToBytes(JSON.stringify(wire)));
}

describe('eventEmbed — description (`de`) round-trip', () => {
  it('carries a description through encode → parse', () => {
    const token = encodeEventEmbed({
      addr: ADDR,
      title: 'Rooftop meetup',
      description: 'Bring your own drinks. We start at sunset.',
      type: 'inperson',
      waitlistEnabled: false,
    });
    const ref = parseEventEmbed(token);
    expect(ref).not.toBeNull();
    expect(ref!.description).toBe('Bring your own drinks. We start at sunset.');
  });

  it('omits `de` from the wire entirely when no description is given (no empty-string key)', () => {
    const token = encodeEventEmbed({addr: ADDR, type: 'inperson', waitlistEnabled: false});
    const payload = token.slice(EVENT_EMBED_PREFIX.length);
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const rem = base64.length % 4;
    const padded = rem === 0 ? base64 : base64 + '='.repeat(4 - rem);
    const wire = JSON.parse(bytesToUtf8(Buffer.from(padded, 'base64'))) as Record<string, unknown>;
    expect('de' in wire).toBe(false);
    expect(parseEventEmbed(token)!.description).toBeUndefined();
  });

  it('is backward compatible: an OLD token with no `de` key at all still parses fine', () => {
    // Simulates a token minted before this field existed — every other field intact, `de` absent.
    const token = rawToken({v: 1, p: PK, d: 'my-event', t: 'Old-style card'});
    const ref = parseEventEmbed(token);
    expect(ref).not.toBeNull();
    expect(ref!.title).toBe('Old-style card');
    expect(ref!.description).toBeUndefined();
  });

  it('clamps an oversize description to the snippet cap (~400 chars) on encode', () => {
    const long = 'x'.repeat(1000);
    const token = encodeEventEmbed({addr: ADDR, type: 'inperson', waitlistEnabled: false, description: long});
    const ref = parseEventEmbed(token);
    expect(ref!.description!.length).toBeLessThanOrEqual(400);
    expect(ref!.description).toBe('x'.repeat(400));
  });

  it('clamps an oversize `de` on the PARSE side too, in case a hostile/foreign token ships a longer one', () => {
    // Long enough to exceed the description snippet cap (400) but well under the overall token
    // payload cap, so this exercises cleanBlock's own clamp rather than the payload-size reject.
    const long = 'y'.repeat(900);
    const token = rawToken({v: 1, p: PK, d: 'my-event', de: long});
    const ref = parseEventEmbed(token);
    expect(ref).not.toBeNull();
    expect(ref!.description!.length).toBeLessThanOrEqual(400);
  });

  it('strips control characters but keeps newlines (multi-line clamp, mirrors eventsStore.clampBlock)', () => {
    const dirty = 'Line one\nLine two\x00\x07 with control chars\nLine three';
    const token = encodeEventEmbed({addr: ADDR, type: 'inperson', waitlistEnabled: false, description: dirty});
    const ref = parseEventEmbed(token);
    expect(ref!.description).toBe('Line one\nLine two with control chars\nLine three');
  });

  it('a whitespace-only description encodes/parses as absent, never an empty-ish string', () => {
    const token = encodeEventEmbed({addr: ADDR, type: 'inperson', waitlistEnabled: false, description: '   \n\n  '});
    const ref = parseEventEmbed(token);
    expect(ref!.description).toBeUndefined();
  });

  it('a non-string `de` on the wire is dropped, never throws, never coerced', () => {
    const token = rawToken({v: 1, p: PK, d: 'my-event', de: 12345});
    expect(() => parseEventEmbed(token)).not.toThrow();
    expect(parseEventEmbed(token)!.description).toBeUndefined();
  });

  it('parseEventEmbed NEVER throws on garbage input (malformed base64/JSON/prefix)', () => {
    const garbage = [
      'stiq:event:not-valid-base64-!!!',
      'stiq:event:',
      EVENT_EMBED_PREFIX + toBase64Url(utf8ToBytes('not json at all {{{')),
      'not-a-stiq-token-at-all',
      EVENT_EMBED_PREFIX + toBase64Url(utf8ToBytes(JSON.stringify({v: 1, p: 'not-hex', d: 'x', de: 'desc'}))),
    ];
    for (const g of garbage) {
      expect(() => parseEventEmbed(g)).not.toThrow();
    }
    expect(parseEventEmbed('stiq:event:not-valid-base64-!!!')).toBeNull();
    expect(parseEventEmbed('not-a-stiq-token-at-all')).toBeNull();
  });
});
