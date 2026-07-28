import type {Event} from 'nostr-tools/pure';
import {
  SPACE_KEY_REQUEST_D_PREFIX,
  spaceKeyRequestDTag,
  buildSpaceKeyRequest,
  parseSpaceKeyRequest,
} from './membership';
import {Kind} from '../nostr/events';

/**
 * The key-redelivery request doc (OPEN_ITEMS §3.1) — the wire piece a stranded private-space
 * member publishes so a keyed admin re-runs their kind-30079 delivery. Its shape is contractual
 * three ways at once: the `d` prefix must never enter the organizer-reserved `stiq:` namespace
 * (the relay rejects those from members), the exact `d` value is what the recovery filter in
 * buildSpaceKeyRecoveryFilters REQs by, and the `h` tag is what routes it through the group's
 * scoped subscription to an admin's ingest.
 */
const asEvent = (partial: Partial<Event>): Event =>
  ({
    id: 'e'.repeat(64),
    pubkey: 'a'.repeat(64),
    created_at: 1234,
    kind: Kind.AppData,
    tags: [],
    content: '',
    sig: 's',
    ...partial,
  }) as Event;

describe('buildSpaceKeyRequest / parseSpaceKeyRequest', () => {
  it('builds the contractual shape: kind 30078, exact d, h routing tag, EMPTY content', () => {
    const unsigned = buildSpaceKeyRequest('grp1');
    expect(unsigned.kind).toBe(Kind.AppData);
    expect(unsigned.tags).toContainEqual(['d', 'space-key-request:grp1']);
    expect(unsigned.tags).toContainEqual(['h', 'grp1']);
    expect(unsigned.content).toBe(''); // carries no secret, needs none
    // The reserved-namespace invariant the relay enforces on members' 30078s:
    expect(spaceKeyRequestDTag('grp1').startsWith('stiq:')).toBe(false);
    expect(spaceKeyRequestDTag('grp1')).toBe(`${SPACE_KEY_REQUEST_D_PREFIX}grp1`);
  });

  it('round-trips through parse, reading requester + created_at (the responder dedupe key)', () => {
    const unsigned = buildSpaceKeyRequest('grp1');
    const signedish = asEvent({
      kind: unsigned.kind,
      tags: unsigned.tags,
      content: unsigned.content,
      pubkey: 'b'.repeat(64),
      created_at: 7777,
    });
    expect(parseSpaceKeyRequest(signedish)).toEqual({
      spaceId: 'grp1',
      requester: 'b'.repeat(64),
      at: 7777,
    });
  });

  it('rejects everything that is not a request: wrong kind, other 30078 docs, empty space id', () => {
    expect(parseSpaceKeyRequest(asEvent({kind: 1, tags: [['d', 'space-key-request:g']]}))).toBeNull();
    expect(parseSpaceKeyRequest(asEvent({tags: []}))).toBeNull();
    expect(parseSpaceKeyRequest(asEvent({tags: [['d', 'space-invites:g']]}))).toBeNull();
    expect(parseSpaceKeyRequest(asEvent({tags: [['d', 'stiq:moderators']]}))).toBeNull();
    expect(parseSpaceKeyRequest(asEvent({tags: [['d', 'space-key-request:']]}))).toBeNull();
  });
});
