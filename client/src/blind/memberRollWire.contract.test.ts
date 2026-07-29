/**
 * Cross-process wire contract: the CLIENT parser against a member-roll doc that the REAL
 * organizer server actually published to a REAL relay.
 *
 * Every other member-roll test builds its own ciphertext with the client's own helpers, so the
 * organizer and the client could drift apart — different NIP-44 variant, different key encoding,
 * a renamed payload field — and every suite on both sides would stay green while enforcement
 * silently deferred forever in the field (or, worse, hid every member). This pins the actual
 * bytes that crossed the wire.
 *
 * The fixture is captured by the live end-to-end harness: it spawns the compiled relay binary and
 * `issuer/organizer-server.mjs`, lets the organizer publish on boot, reads the kind-30078
 * d=stiq:member-roll event back over a WebSocket, and writes {content, communityKeyB64,
 * expectedMembers} here. Regenerate it whenever the wire contract changes on either side.
 */
import {parseMemberRollContent} from '../moderation/organizerConfig';
import fixture from './__fixtures__/liveMemberRoll.json';

const key = () => Uint8Array.from(Buffer.from(fixture.communityKeyB64, 'base64'));

describe('member-roll wire contract (live organizer output)', () => {
  it('the client parses a roll the organizer server really published', () => {
    const roll = parseMemberRollContent(fixture.content, key());
    expect(roll).toBeDefined();
    expect([...roll!.members].sort()).toEqual(fixture.expectedMembers);
  });

  it('carries the organizer publish stamp', () => {
    const roll = parseMemberRollContent(fixture.content, key());
    expect(roll!.updatedAt).toBeGreaterThan(0);
  });

  it('defers (rather than enforcing an empty roll) under the wrong community key', () => {
    const wrong = new Uint8Array(32).fill(7);
    expect(parseMemberRollContent(fixture.content, wrong)).toBeUndefined();
  });

  it('defers on a truncated/tampered ciphertext', () => {
    expect(parseMemberRollContent(fixture.content.slice(0, -4), key())).toBeUndefined();
  });
});
