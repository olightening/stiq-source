import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {
  advisoryOverlay,
  buildLogBatch,
  buildLogEvent,
  buildLogUser,
  buildRestoreEvent,
  buildUnlogUser,
  loggedAuthorsFrom,
} from './advisory';

const modSk = generateSecretKey();
const modPk = getPublicKey(modSk);
const isMod = (pk: string) => pk === modPk;

/** Sign an advisory as the moderator, stamping created_at so latest-wins is testable. */
function asMod(unsigned: {kind: number; tags: string[][]; content: string}, ts: number): Event {
  return finalizeEvent({...unsigned, created_at: ts}, modSk);
}

describe('advisory moderation overlay', () => {
  const author = getPublicKey(generateSecretKey());

  it('routes a standing-rule author to the log; a reversal restores them', () => {
    const log = asMod(buildLogUser(author), 100);
    expect(advisoryOverlay([log], isMod).loggedAuthors.has(author)).toBe(true);

    const unlog = asMod(buildUnlogUser(author), 200); // newer wins
    expect(advisoryOverlay([log, unlog], isMod).loggedAuthors.has(author)).toBe(false);

    const relog = asMod(buildLogUser(author), 300); // newer again
    expect(advisoryOverlay([log, unlog, relog], isMod).loggedAuthors.has(author)).toBe(true);
  });

  it('routes a single event to the log and back', () => {
    const log = asMod(buildLogEvent('ev1', author), 10);
    expect(advisoryOverlay([log], isMod).loggedEvents.has('ev1')).toBe(true);
    const restore = asMod(buildRestoreEvent('ev1'), 20);
    expect(advisoryOverlay([log, restore], isMod).loggedEvents.has('ev1')).toBe(false);
  });

  it('routes an entire past batch to the log', () => {
    const batch = asMod(buildLogBatch(['a', 'b', 'c'], author), 10);
    const overlay = advisoryOverlay([batch], isMod);
    expect(overlay.loggedEvents.has('a')).toBe(true);
    expect(overlay.loggedEvents.has('b')).toBe(true);
    expect(overlay.loggedEvents.has('c')).toBe(true);
  });

  it('ignores directives from non-moderators', () => {
    const impostorSk = generateSecretKey();
    const fake = finalizeEvent({...buildLogUser(author), created_at: 10}, impostorSk);
    expect(advisoryOverlay([fake], isMod).loggedAuthors.has(author)).toBe(false);
  });

  it('a standing rule catches every throwaway-keyed blind post by that author', () => {
    // The overlay keys on the REAL author pubkey, so it does not matter that each blind post is
    // signed by a different throwaway key — the caller resolves the real author before matching.
    const log = asMod(buildLogUser(author), 10);
    const {loggedAuthors} = advisoryOverlay([log], isMod);
    expect(loggedAuthors.has(author)).toBe(true);
  });
});

describe('loggedAuthorsFrom (moderator console "Logged" tab source)', () => {
  const a1 = getPublicKey(generateSecretKey());
  const a2 = getPublicKey(generateSecretKey());

  it('lists standing-rule authors newest first, with the issuing moderator + time', () => {
    const older = asMod(buildLogUser(a1), 100);
    const newer = asMod(buildLogUser(a2), 200);
    const rows = loggedAuthorsFrom(advisoryOverlay([older, newer], isMod));
    expect(rows.map(r => r.pubkey)).toEqual([a2, a1]); // newest first
    expect(rows[0]).toMatchObject({pubkey: a2, since: 200, moderatorPubkey: modPk});
    expect(rows[1]).toMatchObject({pubkey: a1, since: 100, moderatorPubkey: modPk});
  });

  it('omits an author whose standing rule was reversed', () => {
    const log = asMod(buildLogUser(a1), 100);
    const unlog = asMod(buildUnlogUser(a1), 200);
    expect(loggedAuthorsFrom(advisoryOverlay([log, unlog], isMod))).toEqual([]);
  });
});
