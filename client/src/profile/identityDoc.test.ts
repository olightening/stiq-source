import {
  buildIdentityBeacon,
  isIdentityBeacon,
  isEncryptedProfile,
  readIdentityBeacon,
  buildEncryptedProfileEvent,
  encodeProfilePayload,
  decodeProfilePayload,
  hasIdentityToPublish,
  D_IDENTITY_BEACON,
  D_IDENTITY_PROFILE,
} from './identityDoc';
import {Kind} from '../nostr/events';
import {encodeGradient, type GradientSpec} from '../media/gradient';
import type {Event} from 'nostr-tools/pure';

const grad: GradientSpec = {type: 'linear', angle: 90, stops: ['#ff0000', '#00ff00']};
const wire = encodeGradient(grad);

const asEvent = (unsigned: {kind: number; created_at: number; tags: string[][]; content: string}): Event =>
  ({...unsigned, id: 'id', pubkey: 'pk', sig: 'sig'} as Event);

describe('identity beacon', () => {
  it('encodes name + gradient into a d="identity" kind-30078 header event', () => {
    const b = buildIdentityBeacon('Alice', wire, 1000)!;
    expect(b.kind).toBe(Kind.AppData);
    expect(b.created_at).toBe(1000);
    expect(b.tags).toContainEqual(['d', D_IDENTITY_BEACON]);
    const {name, gradientWire} = readIdentityBeacon(b.content);
    expect(name).toBe('Alice');
    expect(gradientWire).toBe(wire);
  });

  it('returns null when there is nothing to announce', () => {
    expect(buildIdentityBeacon('', '', 1000)).toBeNull();
    expect(hasIdentityToPublish('', '')).toBe(false);
    expect(hasIdentityToPublish('Alice', '')).toBe(true);
    expect(hasIdentityToPublish('', wire)).toBe(true);
  });

  it('discriminates beacon vs encrypted profile vs a normal post by kind + d tag', () => {
    const beacon = asEvent(buildIdentityBeacon('Alice', '', 1000)!);
    const profile = asEvent(buildEncryptedProfileEvent('ciphertext', 1000));
    expect(isIdentityBeacon(beacon)).toBe(true);
    expect(isEncryptedProfile(beacon)).toBe(false);
    expect(isEncryptedProfile(profile)).toBe(true);
    expect(isIdentityBeacon(profile)).toBe(false);
    expect(isIdentityBeacon({kind: Kind.Post, tags: [], content: 'hi'} as unknown as Event)).toBe(false);
  });
});

describe('encrypted profile payload', () => {
  it('round-trips name + gradient, omitting empty fields', () => {
    expect(decodeProfilePayload(encodeProfilePayload('Alice', wire))).toEqual({n: 'Alice', g: wire});
    expect(decodeProfilePayload(encodeProfilePayload('', wire))).toEqual({g: wire});
    expect(decodeProfilePayload(encodeProfilePayload('Alice', ''))).toEqual({n: 'Alice'});
  });

  it('tolerates malformed / wrong-typed json without throwing', () => {
    expect(decodeProfilePayload('not json')).toEqual({});
    expect(decodeProfilePayload('123')).toEqual({});
    expect(decodeProfilePayload('{"n":5}')).toEqual({});
  });

  it('buildEncryptedProfileEvent is an addressable kind-30078 carrying the ciphertext body', () => {
    const e = buildEncryptedProfileEvent('CIPHER', 42);
    expect(e.kind).toBe(Kind.AppData);
    expect(e.created_at).toBe(42);
    expect(e.tags).toContainEqual(['d', D_IDENTITY_PROFILE]);
    expect(e.content).toBe('CIPHER');
  });
});
