/**
 * logOffer.test.ts — the owner-consent gate for listing PRIVATE groups in the community log-page
 * picker. This is the CLIENT half of `issuer/log-offer.mjs` (the wire authority); these tests pin
 * the exact shape the organizer dashboard reads (see `issuer/log_offer_test.mjs` for the server side).
 */
import type {Event} from 'nostr-tools/pure';
import {InMemoryEventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import {
  LOG_OFFER_D_PREFIX,
  KIND_LOG_OFFER,
  logOfferDTag,
  buildLogOffer,
  buildLogOfferRevoke,
  parseLogOfferContent,
  currentLogOffer,
} from './logOffer';

const GID = 'group-abc123';
const OWNER = 'a'.repeat(64);
const IMPOSTOR = 'b'.repeat(64);

function fakeEvent(tags: string[][], content: string, createdAt = 1000, pubkey = OWNER): Event {
  return {
    id: Math.random().toString(36) + Math.random().toString(36),
    pubkey,
    created_at: createdAt,
    kind: Kind.AppData,
    tags,
    content,
    sig: '',
  } as Event;
}

describe('logOfferDTag', () => {
  it('round-trips and is never stiq:-prefixed (relay-reserved for the organizer)', () => {
    expect(LOG_OFFER_D_PREFIX).toBe('space-offer:');
    expect(logOfferDTag(GID)).toBe('space-offer:' + GID);
    expect(logOfferDTag(GID).startsWith('stiq:')).toBe(false);
    expect(KIND_LOG_OFFER).toBe(30078);
  });
});

describe('buildLogOffer / buildLogOfferRevoke', () => {
  it('builds a live offer event with the right kind/d/content', () => {
    const ev = buildLogOffer({gid: GID, name: 'Secret Garden', gradient: 'grad-wire', private: true, closed: false, broadcast: false});
    expect(ev.kind).toBe(Kind.AppData);
    expect(ev.tags).toContainEqual(['d', logOfferDTag(GID)]);
    const parsed = parseLogOfferContent(ev.content);
    expect(parsed).toEqual({
      v: 1, gid: GID, n: 'Secret Garden', g: 'grad-wire', pr: true, cl: false, bc: false, at: ev.created_at,
    });
  });

  it('omits the gradient as empty string when none is given', () => {
    const ev = buildLogOffer({gid: GID, name: 'No Grad', private: false, closed: true, broadcast: true});
    const parsed = parseLogOfferContent(ev.content);
    expect(parsed?.g).toBe('');
    expect(parsed?.pr).toBe(false);
    expect(parsed?.cl).toBe(true);
    expect(parsed?.bc).toBe(true);
  });

  it('caps name/gradient at build time (defense in depth, mirrors parse-time caps)', () => {
    const ev = buildLogOffer({gid: GID, name: 'x'.repeat(200), gradient: 'y'.repeat(200), private: true, closed: false, broadcast: false});
    const parsed = parseLogOfferContent(ev.content);
    expect(parsed?.n.length).toBe(80);
    expect(parsed?.g.length).toBe(120);
  });

  it('builds a revoke tombstone on the SAME d-tag', () => {
    const live = buildLogOffer({gid: GID, name: 'X', private: true, closed: false, broadcast: false});
    const revoke = buildLogOfferRevoke(GID);
    expect(revoke.kind).toBe(Kind.AppData);
    expect(revoke.tags).toEqual(live.tags);
    expect(parseLogOfferContent(revoke.content)).toBeNull();
  });
});

describe('parseLogOfferContent', () => {
  it('parses a well-formed live offer', () => {
    const content = JSON.stringify({v: 1, gid: GID, n: 'Name', g: 'grad', pr: true, cl: true, bc: false, at: 5});
    expect(parseLogOfferContent(content)).toEqual({v: 1, gid: GID, n: 'Name', g: 'grad', pr: true, cl: true, bc: false, at: 5});
  });

  it('rv:true is always "no live offer" regardless of other fields', () => {
    expect(parseLogOfferContent(JSON.stringify({v: 1, gid: GID, rv: true, at: 6}))).toBeNull();
    expect(parseLogOfferContent(JSON.stringify({v: 1, gid: GID, rv: true, n: 'still set', at: 6}))).toBeNull();
  });

  it('rejects garbage / wrong version / missing gid', () => {
    expect(parseLogOfferContent('{not json')).toBeNull();
    expect(parseLogOfferContent('null')).toBeNull();
    expect(parseLogOfferContent('42')).toBeNull();
    expect(parseLogOfferContent(JSON.stringify({v: 2, gid: GID}))).toBeNull();
    expect(parseLogOfferContent(JSON.stringify({v: 1}))).toBeNull();
    expect(parseLogOfferContent(JSON.stringify({v: 1, gid: ''}))).toBeNull();
  });

  it('caps n at 80 chars and g at 120 chars', () => {
    const content = JSON.stringify({v: 1, gid: GID, n: 'x'.repeat(200), g: 'y'.repeat(200)});
    const parsed = parseLogOfferContent(content);
    expect(parsed?.n.length).toBe(80);
    expect(parsed?.g.length).toBe(120);
  });

  it('defaults pr/cl/bc to false and at to 0 when absent/non-finite', () => {
    const parsed = parseLogOfferContent(JSON.stringify({v: 1, gid: GID}));
    expect(parsed).toEqual({v: 1, gid: GID, n: '', g: '', pr: false, cl: false, bc: false, at: 0});
  });
});

describe('currentLogOffer', () => {
  it('returns the latest owner-signed live offer (newer wins)', () => {
    const store = new InMemoryEventStore();
    const older = buildLogOffer({gid: GID, name: 'Old Name', private: true, closed: false, broadcast: false});
    const newer = buildLogOffer({gid: GID, name: 'New Name', private: true, closed: false, broadcast: false});
    store.save(fakeEvent(older.tags, older.content, 1000, OWNER));
    store.save(fakeEvent(newer.tags, newer.content, 2000, OWNER));
    expect(currentLogOffer(store, GID, OWNER)?.n).toBe('New Name');
  });

  it('ignores an offer signed by an impostor (not the owner)', () => {
    const store = new InMemoryEventStore();
    const doc = buildLogOffer({gid: GID, name: 'Impostor Offer', private: true, closed: false, broadcast: false});
    store.save(fakeEvent(doc.tags, doc.content, 1000, IMPOSTOR));
    expect(currentLogOffer(store, GID, OWNER)).toBeNull();
  });

  it('returns null when no offer exists, or the owner is unknown', () => {
    expect(currentLogOffer(new InMemoryEventStore(), GID, OWNER)).toBeNull();
    expect(currentLogOffer(new InMemoryEventStore(), GID, '')).toBeNull();
  });

  it('the newest event wins by created_at, regardless of publish order (revoke and restore)', () => {
    const live = buildLogOffer({gid: GID, name: 'Live', private: true, closed: false, broadcast: false});
    const revoke = buildLogOfferRevoke(GID);
    // Revoke published AFTER a live offer (revoke is newest) ⇒ no live offer.
    {
      const store = new InMemoryEventStore();
      store.save(fakeEvent(live.tags, live.content, 1000, OWNER));
      store.save(fakeEvent(revoke.tags, revoke.content, 2000, OWNER));
      expect(currentLogOffer(store, GID, OWNER)).toBeNull();
    }
    // Same two events, opposite arrival order ⇒ same result (newest created_at still wins, not
    // insertion order): revoke is still created_at 2000, still the latest.
    {
      const store = new InMemoryEventStore();
      store.save(fakeEvent(revoke.tags, revoke.content, 2000, OWNER));
      store.save(fakeEvent(live.tags, live.content, 1000, OWNER));
      expect(currentLogOffer(store, GID, OWNER)).toBeNull();
    }
    // A live offer published AFTER an earlier revoke (live is newest) ⇒ offer restored.
    {
      const store = new InMemoryEventStore();
      store.save(fakeEvent(revoke.tags, revoke.content, 1000, OWNER));
      store.save(fakeEvent(live.tags, live.content, 2000, OWNER));
      expect(currentLogOffer(store, GID, OWNER)?.gid).toBe(GID);
    }
  });
});
