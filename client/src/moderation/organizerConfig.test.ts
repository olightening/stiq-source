import {nip19} from 'nostr-tools';
import type {Event} from 'nostr-tools/pure';
import {InMemoryEventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import {
  currentModerators,
  currentLimits,
  currentStoragePolicy,
  currentSeededBridges,
  currentCommunityConfig,
  currentFeaturedSpaces,
  currentGuide,
  currentLogPage,
  toRetentionPolicy,
  ORGANIZER_D_MODERATORS,
  ORGANIZER_D_LIMITS,
  ORGANIZER_D_STORAGE,
  ORGANIZER_D_BRIDGES,
  ORGANIZER_D_COMMUNITY,
  ORGANIZER_D_FEATURED,
  ORGANIZER_D_GUIDE,
  ORGANIZER_D_LOG_PAGE,
  MAX_FEATURED_SPACES,
  MAX_FEATURED_LABEL,
  MAX_GUIDE_TITLE,
  MAX_LOG_PICKS,
  MAX_LOG_PEOPLE,
} from './organizerConfig';
import {REACTION_RETENTION, TIMELINE_RETENTION} from '../nostr/sqliteStore';
import {encodeSpaceEmbed} from '../channels/spaceEmbed';
import {decodeGradient} from '../media/gradient';

const ORGANIZER_HEX = 'a'.repeat(64);
const ORGANIZER_NPUB = nip19.npubEncode(ORGANIZER_HEX);
const MOD_A = 'b'.repeat(64);
const MOD_B = 'c'.repeat(64);

let seq = 0;
function appData(
  pubkey: string,
  d: string,
  tags: string[][],
  content = '',
  created_at = ++seq,
): Event {
  return {
    id: `${d}-${created_at}-${pubkey.slice(0, 4)}`,
    pubkey,
    kind: Kind.AppData,
    created_at,
    tags: [['d', d], ...tags],
    content,
    sig: '',
  };
}

describe('organizerConfig — roster', () => {
  it('returns undefined when no organizer is configured', () => {
    const store = new InMemoryEventStore();
    expect(currentModerators(store, undefined)).toBeUndefined();
  });

  it('returns undefined when the organizer has published no roster', () => {
    const store = new InMemoryEventStore();
    expect(currentModerators(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('reads moderator pubkeys from the latest roster as npubs', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_MODERATORS, [['p', MOD_A]], '', 1));
    store.save(
      appData(ORGANIZER_HEX, ORGANIZER_D_MODERATORS, [['p', MOD_A], ['p', MOD_B]], '', 2),
    );
    const mods = currentModerators(store, ORGANIZER_NPUB);
    expect(mods).toEqual([nip19.npubEncode(MOD_A), nip19.npubEncode(MOD_B)]);
  });

  it('ignores a roster signed by a non-organizer (grant withdrawn / impostor)', () => {
    const store = new InMemoryEventStore();
    store.save(appData(MOD_A, ORGANIZER_D_MODERATORS, [['p', MOD_B]]));
    expect(currentModerators(store, ORGANIZER_NPUB)).toBeUndefined();
  });
});

describe('organizerConfig — limits', () => {
  it('parses a full limits policy', () => {
    const store = new InMemoryEventStore();
    store.save(
      appData(
        ORGANIZER_HEX,
        ORGANIZER_D_LIMITS,
        [],
        JSON.stringify({
          posts: {daily: 20, weekly: 100, monthly: 300},
          comments: {daily: 100},
          dm_global_per_min: 60,
          exempt_moderators: true,
        }),
      ),
    );
    const limits = currentLimits(store, ORGANIZER_NPUB);
    expect(limits?.posts).toEqual({daily: 20, weekly: 100, monthly: 300});
    expect(limits?.comments).toEqual({daily: 100, weekly: undefined, monthly: undefined});
    expect(limits?.dmGlobalPerMin).toBe(60);
    expect(limits?.exemptModerators).toBe(true);
  });

  it('tolerates malformed JSON', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LIMITS, [], 'not json'));
    expect(currentLimits(store, ORGANIZER_NPUB)).toBeUndefined();
  });
});

describe('organizerConfig — storage policy (T16 stiq:storage)', () => {
  it('returns undefined with no organizer and with no published stiq:storage doc', () => {
    const store = new InMemoryEventStore();
    expect(currentStoragePolicy(store, undefined)).toBeUndefined();
    expect(currentStoragePolicy(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('parses the compact wire keys {rc,tc,ma,cr}', () => {
    const store = new InMemoryEventStore();
    store.save(
      appData(ORGANIZER_HEX, ORGANIZER_D_STORAGE, [], JSON.stringify({rc: 500, tc: 400, ma: 30, cr: true})),
    );
    expect(currentStoragePolicy(store, ORGANIZER_NPUB)).toEqual({
      reactionCap: 500,
      timelineCap: 400,
      maxAgeDays: 30,
      collapseReplaceable: true,
    });
  });

  it('drops negative / non-numeric caps via the num() guard and defaults cr to false', () => {
    const store = new InMemoryEventStore();
    // rc negative, tc a string, ma NaN (JSON-serialized to null) → all dropped; cr absent → false.
    store.save(
      appData(ORGANIZER_HEX, ORGANIZER_D_STORAGE, [], JSON.stringify({rc: -5, tc: 'x', ma: NaN})),
    );
    expect(currentStoragePolicy(store, ORGANIZER_NPUB)).toEqual({
      reactionCap: undefined,
      timelineCap: undefined,
      maxAgeDays: undefined,
      collapseReplaceable: false,
    });
  });

  it('ignores a stiq:storage doc signed by a non-organizer', () => {
    const store = new InMemoryEventStore();
    store.save(appData(MOD_A, ORGANIZER_D_STORAGE, [], JSON.stringify({tc: 100})));
    expect(currentStoragePolicy(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('tolerates malformed JSON', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_STORAGE, [], 'not json'));
    expect(currentStoragePolicy(store, ORGANIZER_NPUB)).toBeUndefined();
  });
});

describe('organizerConfig — toRetentionPolicy (StoragePolicy → RetentionPolicy mapping)', () => {
  it('returns {} for an absent policy (pure store defaults)', () => {
    expect(toRetentionPolicy(undefined)).toEqual({});
  });

  it('clamps caps up to the low-storage floor (min 200)', () => {
    expect(toRetentionPolicy({reactionCap: 10, timelineCap: 50})).toEqual({
      reactionCap: 200,
      timelineCap: 200,
    });
  });

  it('caps at the default ceiling so a policy can only shrink, never grow', () => {
    expect(toRetentionPolicy({reactionCap: 999999, timelineCap: 999999})).toEqual({
      reactionCap: REACTION_RETENTION,
      timelineCap: TIMELINE_RETENTION,
    });
  });

  it('passes a mid-range cap through unchanged', () => {
    expect(toRetentionPolicy({reactionCap: 1000, timelineCap: 800})).toEqual({
      reactionCap: 1000,
      timelineCap: 800,
    });
  });

  it('converts maxAgeDays → maxAgeSeconds (×86400) only for a positive bound', () => {
    expect(toRetentionPolicy({maxAgeDays: 30})).toEqual({maxAgeSeconds: 30 * 86400});
    expect(toRetentionPolicy({maxAgeDays: 0})).toEqual({}); // 0 = no age bound
  });

  it('passes collapseReplaceable through (both values)', () => {
    expect(toRetentionPolicy({collapseReplaceable: true})).toEqual({collapseReplaceable: true});
    expect(toRetentionPolicy({collapseReplaceable: false})).toEqual({collapseReplaceable: false});
  });

  it('maps a full policy end to end', () => {
    expect(
      toRetentionPolicy({reactionCap: 500, timelineCap: 400, maxAgeDays: 14, collapseReplaceable: true}),
    ).toEqual({
      reactionCap: 500,
      timelineCap: 400,
      maxAgeSeconds: 14 * 86400,
      collapseReplaceable: true,
    });
  });
});

describe('organizerConfig — seeded bridges (T14 stiq:bridges)', () => {
  const OBFS4 = 'obfs4 1.2.3.4:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=AbCdEf iat-mode=0';
  const WEBTUNNEL =
    'webtunnel 5.6.7.8:443 89ABCDEF0123456789ABCDEF0123456789ABCDEF url=https://tunnel.example.com/xyz';
  const SNOWFLAKE = 'snowflake 1.1.1.1:1 0000000000000000000000000000000000000000';

  it('returns undefined with no organizer and with no published stiq:bridges doc', () => {
    const store = new InMemoryEventStore();
    expect(currentSeededBridges(store, undefined)).toBeUndefined();
    expect(currentSeededBridges(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('parses valid obfs4 + webtunnel lines from the {b:[...]} content', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_BRIDGES, [], JSON.stringify({b: [WEBTUNNEL, OBFS4]})));
    expect(currentSeededBridges(store, ORGANIZER_NPUB)).toEqual([WEBTUNNEL, OBFS4]);
  });

  it('drops snowflake/vanilla/malformed lines and dedupes (obfs4/webtunnel only)', () => {
    const store = new InMemoryEventStore();
    store.save(
      appData(ORGANIZER_HEX, ORGANIZER_D_BRIDGES, [], JSON.stringify({b: [OBFS4, SNOWFLAKE, 'garbage', OBFS4]})),
    );
    expect(currentSeededBridges(store, ORGANIZER_NPUB)).toEqual([OBFS4]);
  });

  it('caps the list at MAX_SEEDED_BRIDGES (12)', () => {
    const store = new InMemoryEventStore();
    const many = Array.from(
      {length: 20},
      (_, i) => `obfs4 10.0.0.${i}:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=AbCdEf iat-mode=0`,
    );
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_BRIDGES, [], JSON.stringify({b: many})));
    expect(currentSeededBridges(store, ORGANIZER_NPUB)).toHaveLength(12);
  });

  it('ignores a stiq:bridges doc signed by a non-organizer', () => {
    const store = new InMemoryEventStore();
    store.save(appData(MOD_A, ORGANIZER_D_BRIDGES, [], JSON.stringify({b: [OBFS4]})));
    expect(currentSeededBridges(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('returns undefined for malformed JSON, a non-array b, or an all-dropped list', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_BRIDGES, [], 'not json', 1));
    expect(currentSeededBridges(store, ORGANIZER_NPUB)).toBeUndefined();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_BRIDGES, [], JSON.stringify({b: 'nope'}), 2));
    expect(currentSeededBridges(store, ORGANIZER_NPUB)).toBeUndefined();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_BRIDGES, [], JSON.stringify({b: [SNOWFLAKE]}), 3));
    expect(currentSeededBridges(store, ORGANIZER_NPUB)).toBeUndefined();
  });
});

describe('organizerConfig — community (announcement banner)', () => {
  // The exact wire `sanitizeCommunity` emits (issuer/organizer-server.mjs) for a banner the
  // organizer typed into the dashboard and left un-expiring. If this drifts, the banner dies
  // silently: the client renders nothing and the dashboard still reports "published".
  const SERVER_WIRE = JSON.stringify({
    nm: 'Test community',
    desc: 'A tagline.',
    icn: '🌿',
    acc: '#8a8f98',
    dv: 'list',
    ew: 0,
    ae: true,
    ad: true,
    ann: {t: 'Welcome! Read the guide before posting.', u: 0},
  });

  it('parses the announcement out of the organizer server wire (u:0 ⇒ no expiry)', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_COMMUNITY, [], SERVER_WIRE));
    // u:0 is the "never expires" sentinel — it must NOT surface as `until: 0`, which reads as a 1970
    // deadline downstream. The banner carries no expiry at all.
    expect(currentCommunityConfig(store, ORGANIZER_NPUB)?.announcement).toEqual({
      text: 'Welcome! Read the guide before posting.',
    });
  });

  it('treats a mis-entered tiny `until` (e.g. "3") as no expiry — the banner still shows', () => {
    const store = new InMemoryEventStore();
    // Reproduces the field footgun: an organizer typed "3" into the raw unix-seconds box, which is a
    // 1970 timestamp. Left unguarded it would bury the banner forever; instead it means "no expiry".
    const wire = JSON.stringify({nm: 'X', ann: {t: 'Welcome! Go to the log :)', u: 3}});
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_COMMUNITY, [], wire));
    expect(currentCommunityConfig(store, ORGANIZER_NPUB)?.announcement).toEqual({
      text: 'Welcome! Go to the log :)',
    });
  });

  it('keeps a real future `until` timestamp as a genuine expiry', () => {
    const store = new InMemoryEventStore();
    const until = 4102444800; // 2100-01-01 — a plausible expiry the organizer actually set
    const wire = JSON.stringify({nm: 'X', ann: {t: 'Sale ends soon', u: until}});
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_COMMUNITY, [], wire));
    expect(currentCommunityConfig(store, ORGANIZER_NPUB)?.announcement).toEqual({
      text: 'Sale ends soon',
      until,
    });
  });

  it('omits the announcement when the organizer left the banner blank', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_COMMUNITY, [], JSON.stringify({nm: 'X', ann: {t: '', u: 0}})));
    expect(currentCommunityConfig(store, ORGANIZER_NPUB)?.announcement).toBeUndefined();
  });

  it('ignores a stiq:community doc signed by a non-organizer', () => {
    const store = new InMemoryEventStore();
    store.save(appData(MOD_A, ORGANIZER_D_COMMUNITY, [], SERVER_WIRE));
    expect(currentCommunityConfig(store, ORGANIZER_NPUB)).toBeUndefined();
  });
});

describe('organizerConfig — community guide', () => {
  // Byte-for-byte the wire issuer/organizer-server.mjs's /api/guide POST now signs (kind-30078
  // stiq:guide), replacing the old kind-30023 article the blind-token gate silently rejected. If
  // this drifts, the guide dies exactly the way it used to — dashboard says "published", app shows
  // nothing.
  const SERVER_WIRE = JSON.stringify({v: 1, title: 'House rules', content: '# Welcome\nBe kind.'});

  it('parses the guide out of the organizer server wire', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_GUIDE, [], SERVER_WIRE, 42));
    expect(currentGuide(store, ORGANIZER_NPUB)).toEqual({
      title: 'House rules',
      content: '# Welcome\nBe kind.',
      updatedAt: 42,
    });
  });

  it('returns undefined with no organizer and with nothing published', () => {
    const store = new InMemoryEventStore();
    expect(currentGuide(store, undefined)).toBeUndefined();
    expect(currentGuide(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('treats an empty body as the organizer\'s "cleared" state (absent)', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_GUIDE, [], JSON.stringify({v: 1, title: 'x', content: ''})));
    expect(currentGuide(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('falls back to a default title and truncates an over-long one', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_GUIDE, [], JSON.stringify({v: 1, content: 'body'}), 1));
    expect(currentGuide(store, ORGANIZER_NPUB)?.title).toBe('Community Guide');
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_GUIDE, [], JSON.stringify({v: 1, title: 'T'.repeat(200), content: 'body'}), 2));
    expect(currentGuide(store, ORGANIZER_NPUB)?.title).toHaveLength(MAX_GUIDE_TITLE);
  });

  it('ignores a stiq:guide doc signed by a non-organizer (a mod can no longer overwrite the rules)', () => {
    const store = new InMemoryEventStore();
    store.save(appData(MOD_A, ORGANIZER_D_GUIDE, [], SERVER_WIRE));
    expect(currentGuide(store, ORGANIZER_NPUB)).toBeUndefined();
  });
});

describe('organizerConfig — featured spaces', () => {
  const COORD = `30311:${'d'.repeat(64)}:general`;
  const wire = (items: unknown[]): string => JSON.stringify({v: 1, items});

  it('returns undefined with no organizer and with nothing published', () => {
    const store = new InMemoryEventStore();
    expect(currentFeaturedSpaces(store, undefined)).toBeUndefined();
    expect(currentFeaturedSpaces(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('parses refs, types and labels in the organizer\'s order', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_FEATURED, [], wire([
      {a: COORD, t: 'channel', l: 'Start here'},
      {a: 'g1', t: 'group', n: 'Team'},
    ])));
    expect(currentFeaturedSpaces(store, ORGANIZER_NPUB)).toEqual([
      {ref: COORD, type: 'channel', label: 'Start here', name: undefined},
      {ref: 'g1', type: 'group', label: undefined, name: 'Team'},
    ]);
  });

  it('distinguishes "cleared the rail" (empty) from "never published" (undefined)', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_FEATURED, [], wire([])));
    expect(currentFeaturedSpaces(store, ORGANIZER_NPUB)).toEqual([]);
  });

  it('drops entries that could never be routed, and de-dupes repeated refs', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_FEATURED, [], wire([
      {a: COORD, t: 'channel'},
      {a: COORD, t: 'channel'}, // duplicate
      {a: 'g1', t: 'wat'}, // unknown type
      {a: '', t: 'group'}, // empty ref
      {t: 'group'}, // missing ref
      null,
    ])));
    expect(currentFeaturedSpaces(store, ORGANIZER_NPUB)).toEqual([
      {ref: COORD, type: 'channel', label: undefined, name: undefined},
    ]);
  });

  it('caps the rail and truncates an over-long label', () => {
    const store = new InMemoryEventStore();
    const many = Array.from({length: 20}, (_, i) => ({a: `g${i}`, t: 'group', l: 'x'.repeat(80)}));
    const rows = currentFeaturedSpaces(store, ORGANIZER_NPUB) ?? [];
    expect(rows).toHaveLength(0);
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_FEATURED, [], wire(many)));
    const capped = currentFeaturedSpaces(store, ORGANIZER_NPUB)!;
    expect(capped).toHaveLength(MAX_FEATURED_SPACES);
    expect(capped[0]!.label).toHaveLength(MAX_FEATURED_LABEL);
  });

  it('returns undefined for malformed JSON or a non-array items', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_FEATURED, [], 'not json', 1));
    expect(currentFeaturedSpaces(store, ORGANIZER_NPUB)).toBeUndefined();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_FEATURED, [], JSON.stringify({items: 'nope'}), 2));
    expect(currentFeaturedSpaces(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('parses the organizer server wire verbatim, blank label/name included', () => {
    // Byte-for-byte what issuer/organizer-server.mjs sanitizeFeatured() emits — it always writes
    // `l` and `n`, using '' for "unset". If this drifts, the dashboard reports a successful publish
    // while the rail renders wrong (or not at all), with nothing to point at.
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_FEATURED, [], JSON.stringify({
      v: 1,
      items: [
        {a: COORD, t: 'channel', l: 'Start here', n: ''},
        {a: 'g1', t: 'group', l: '', n: 'Team'},
      ],
    })));
    expect(currentFeaturedSpaces(store, ORGANIZER_NPUB)).toEqual([
      {ref: COORD, type: 'channel', label: 'Start here', name: undefined},
      {ref: 'g1', type: 'group', label: undefined, name: 'Team'},
    ]);
  });

  it('ignores a stiq:featured doc signed by a non-organizer', () => {
    const store = new InMemoryEventStore();
    store.save(appData(MOD_A, ORGANIZER_D_FEATURED, [], wire([{a: COORD, t: 'channel'}])));
    expect(currentFeaturedSpaces(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('parses a featured user, but only with a valid 64-char hex ref', () => {
    const store = new InMemoryEventStore();
    const HEX = 'e'.repeat(64);
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_FEATURED, [], wire([
      {a: HEX, t: 'user', l: 'Ask me anything', n: 'Alice'},
      {a: 'npub1notdecoded', t: 'user'}, // not hex → dropped (the profile route needs hex)
      {a: 'ABCDEF', t: 'user'}, // too short → dropped
    ])));
    expect(currentFeaturedSpaces(store, ORGANIZER_NPUB)).toEqual([
      {ref: HEX, type: 'user', label: 'Ask me anything', name: 'Alice'},
    ]);
  });

  it('decodes a stiq:space share link to a native coordinate + carried name + gradient', () => {
    // The only channel/group reference a member can COPY in-app is the `stiq:space:` share link, so
    // it is what an organizer pastes. It must resolve to the native coordinate (== Channel.id) with
    // the name + gradient it carries, so the row matches a real channel and renders offline.
    const store = new InMemoryEventStore();
    const owner = 'f'.repeat(64);
    const chLink = encodeSpaceEmbed({
      kind: 30311, owner, identifier: 'blue', name: 'Blue hour', private: false,
      gradient: decodeGradient('L180:051e1f,080551')!,
    });
    const grpLink = encodeSpaceEmbed({
      kind: 39000, owner, identifier: 'team-h', name: 'Team', private: true,
      gradient: decodeGradient('L90:112233,445566')!,
    });
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_FEATURED, [], wire([
      {a: chLink, t: 'channel', l: 'Start here', n: 'stale snapshot'},
      {a: grpLink, t: 'group'},
    ])));
    const rows = currentFeaturedSpaces(store, ORGANIZER_NPUB)!;
    expect(rows).toHaveLength(2);
    // Coordinate + type come from the link; the link's name beats the stale wire `n`.
    expect(rows[0]).toMatchObject({
      ref: `30311:${owner}:blue`, type: 'channel', label: 'Start here', name: 'Blue hour',
    });
    expect(rows[0]!.gradient).toBeTruthy();
    expect(rows[1]).toMatchObject({ref: `39000:${owner}:team-h`, type: 'group', name: 'Team'});
    expect(rows[1]!.gradient).toBeTruthy();
  });

  it('carries a bare `g` gradient on a coordinate entry and drops an unroutable space link', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_FEATURED, [], wire([
      {a: COORD, t: 'channel', g: 'L180:051e1f,080551'},
      {a: 'stiq:space:zzzz', t: 'channel'}, // decodes to non-JSON → unroutable → dropped
    ])));
    const rows = currentFeaturedSpaces(store, ORGANIZER_NPUB)!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ref: COORD, type: 'channel'});
    expect(rows[0]!.gradient).toBeTruthy();
  });
});

describe('organizerConfig — currentLogPage (d="stiq:log-page")', () => {
  const PK = 'e'.repeat(64);
  const OWNER = 'd'.repeat(64);
  const COORD = `30311:${OWNER}:general`;

  it('parses the note gradient (note.g); a malformed one is dropped without losing the note', () => {
    const store = new InMemoryEventStore();
    const wire = JSON.stringify({note: {ver: 'v1', b: 'Hi.', g: 'L90:112233,445566'}});
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], wire, 999));
    expect(currentLogPage(store, ORGANIZER_NPUB)!.note!.gradient).toEqual(
      decodeGradient('L90:112233,445566'),
    );

    const bad = JSON.stringify({note: {ver: 'v2', b: 'Hi again.', g: 'nonsense'}});
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], bad, 1000));
    const doc = currentLogPage(store, ORGANIZER_NPUB)!;
    expect(doc.note!.gradient).toBeUndefined();
    expect(doc.note!.body).toBe('Hi again.');
  });

  it('parses every section on a full happy-path doc', () => {
    const store = new InMemoryEventStore();
    const wire = JSON.stringify({
      note: {ver: 'v1', t: 'A note from Mara', s: 'started this community', b: 'Welcome!', sig: '— Mara ✦'},
      rules: {b: 'Be kind. No spam.', e: 'The rules', m: 'Custom meta', at: 500, x: true},
      picks: [
        {a: COORD, t: 'channel', bl: 'the town square', c: 'Open', n: 'General', g: 'L180:051e1f,080551'},
      ],
      people: [{p: PK, r: 'keeps the peace', n: 'Alice'}],
      copy: {
        ph: 'Picks header', pph: 'People header', dt: 'Doorway title', ds: '{n}/{m}',
        mo: 'Motto', rs: 'Show rules', rh: 'Hide rules', tk: 'Tuck', ro: 'Reopen',
      },
      sp: true,
      au: true,
    });
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], wire, 999));
    const doc = currentLogPage(store, ORGANIZER_NPUB)!;

    expect(doc.note).toMatchObject({
      title: 'A note from Mara',
      subline: 'started this community',
      body: 'Welcome!',
      signature: '— Mara ✦',
    });
    // The effective version = the wire `ver` + a content hash (so a changed note can never carry a
    // stale version, whatever published it), stable across republishes of identical text.
    expect(doc.note!.version).toMatch(/^v1~n[0-9a-f]+$/);
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], wire, 1000));
    expect(currentLogPage(store, ORGANIZER_NPUB)!.note!.version).toBe(doc.note!.version);
    expect(doc.rules).toEqual({
      body: 'Be kind. No spam.',
      eyebrow: 'The rules',
      meta: 'Custom meta',
      updatedAt: 500,
      startExpanded: true,
    });
    expect(doc.picks).toHaveLength(1);
    expect(doc.picks[0]).toMatchObject({
      ref: COORD, type: 'channel', blurb: 'the town square', chip: 'Open', name: 'General',
    });
    expect(doc.picks[0]!.gradient).toBeTruthy();
    expect(doc.people).toEqual([{pubkey: PK, role: 'keeps the peace', name: 'Alice'}]);
    expect(doc.copy).toEqual({
      picksHeader: 'Picks header',
      peopleHeader: 'People header',
      doorwayTitle: 'Doorway title',
      doorwaySub: '{n}/{m}',
      motto: 'Motto',
      rulesShowLabel: 'Show rules',
      rulesHideLabel: 'Hide rules',
      tuckLabel: 'Tuck',
      reopenLabel: 'Reopen',
    });
    expect(doc.showPeople).toBe(true);
    expect(doc.aurora).toBe(true);
    expect(doc.updatedAt).toBe(999);
  });

  it('returns undefined with no organizer and with nothing published', () => {
    const store = new InMemoryEventStore();
    expect(currentLogPage(store, undefined)).toBeUndefined();
    expect(currentLogPage(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('note is undefined when its body is absent/blank', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], JSON.stringify({note: {ver: 'v1', t: 'Title'}}), 1));
    expect(currentLogPage(store, ORGANIZER_NPUB)?.note).toBeUndefined();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], JSON.stringify({note: {ver: 'v1', b: '   '}}), 2));
    expect(currentLogPage(store, ORGANIZER_NPUB)?.note).toBeUndefined();
  });

  it('a note without `ver` gets a stable, non-empty fallback version keyed to its body', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], JSON.stringify({note: {b: 'Same body.'}}), 1));
    const v1a = currentLogPage(store, ORGANIZER_NPUB)?.note?.version;
    expect(v1a).toBeTruthy();

    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], JSON.stringify({note: {b: 'Same body.'}}), 2));
    const v1b = currentLogPage(store, ORGANIZER_NPUB)?.note?.version;
    // Same body (even from a different event) → same derived version.
    expect(v1b).toBe(v1a);

    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], JSON.stringify({note: {b: 'Different body.'}}), 3));
    const v2 = currentLogPage(store, ORGANIZER_NPUB)?.note?.version;
    expect(v2).toBeTruthy();
    expect(v2).not.toBe(v1a);
  });

  it('parses a welcome block with its duration and a `w`-prefixed version', () => {
    const store = new InMemoryEventStore();
    const wire = JSON.stringify({welcome: {ver: 'w1', t: 'Hello', s: 'glad you\'re here', b: 'Welcome aboard!', sig: '— us', dur: 172800}});
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], wire, 999));
    const doc = currentLogPage(store, ORGANIZER_NPUB)!;
    expect(doc.welcome).toMatchObject({
      title: 'Hello',
      subline: 'glad you\'re here',
      body: 'Welcome aboard!',
      signature: '— us',
      durSecs: 172800,
    });
    expect(doc.welcome!.version).toMatch(/^w1~w[0-9a-f]+$/);
  });

  it('welcome is undefined when its body is absent/blank', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], JSON.stringify({welcome: {t: 'Hi', dur: 3600}}), 1));
    expect(currentLogPage(store, ORGANIZER_NPUB)?.welcome).toBeUndefined();
  });

  it('welcome and note versions never collide for identical text (Point 3 hand-off)', () => {
    const store = new InMemoryEventStore();
    const wire = JSON.stringify({note: {b: 'X'}, welcome: {b: 'X', dur: 3600}});
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], wire, 999));
    const doc = currentLogPage(store, ORGANIZER_NPUB)!;
    expect(doc.note!.version).not.toBe(doc.welcome!.version);
    expect(doc.note!.version.startsWith('n')).toBe(true);
    expect(doc.welcome!.version.startsWith('w')).toBe(true);
  });

  it('drops non-hex and duplicate people pubkeys, and caps at MAX_LOG_PEOPLE', () => {
    const store = new InMemoryEventStore();
    const hexOf = (n: number): string => n.toString(16).padStart(64, '0');
    const people = [
      {p: PK, r: 'a'},
      {p: PK, r: 'dupe, dropped'}, // duplicate pubkey
      {p: 'npub1notdecoded', r: 'not hex, dropped'},
      {p: 'ABCDEF', r: 'too short, dropped'},
      ...Array.from({length: 20}, (_, i) => ({p: hexOf(i), r: `p${i}`})),
    ];
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], JSON.stringify({people})));
    const doc = currentLogPage(store, ORGANIZER_NPUB)!;
    expect(doc.people.length).toBeLessThanOrEqual(MAX_LOG_PEOPLE);
    expect(doc.people.length).toBe(MAX_LOG_PEOPLE);
    expect(doc.people.filter(p => p.pubkey === PK)).toHaveLength(1);
  });

  it('parses a bare {a,t} pick coordinate and dedupes repeated refs, capping at MAX_LOG_PICKS', () => {
    const store = new InMemoryEventStore();
    const many = Array.from({length: 20}, (_, i) => ({a: `30311:${OWNER}:c${i}`, t: 'channel'}));
    const picks = [
      {a: COORD, t: 'channel'},
      {a: COORD, t: 'channel'}, // duplicate, dropped
      ...many,
    ];
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], JSON.stringify({picks})));
    const doc = currentLogPage(store, ORGANIZER_NPUB)!;
    expect(doc.picks.length).toBe(MAX_LOG_PICKS);
    expect(doc.picks.filter(p => p.ref === COORD)).toHaveLength(1);
  });

  it('trims copy strings and turns empty ones into undefined', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], JSON.stringify({
      copy: {ph: '  Custom header  ', pph: '', mo: '   '},
    })));
    const {copy} = currentLogPage(store, ORGANIZER_NPUB)!;
    expect(copy.picksHeader).toBe('Custom header');
    expect(copy.peopleHeader).toBeUndefined();
    expect(copy.motto).toBeUndefined();
  });

  it('sp/au default to true and parse an explicit false', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], '{}', 1));
    expect(currentLogPage(store, ORGANIZER_NPUB)).toMatchObject({showPeople: true, aurora: true});

    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], JSON.stringify({sp: false, au: false}), 2));
    expect(currentLogPage(store, ORGANIZER_NPUB)).toMatchObject({showPeople: false, aurora: false});
  });

  it('returns undefined for malformed JSON', () => {
    const store = new InMemoryEventStore();
    store.save(appData(ORGANIZER_HEX, ORGANIZER_D_LOG_PAGE, [], 'not json'));
    expect(currentLogPage(store, ORGANIZER_NPUB)).toBeUndefined();
  });

  it('ignores a stiq:log-page doc signed by a non-organizer', () => {
    const store = new InMemoryEventStore();
    store.save(appData(MOD_A, ORGANIZER_D_LOG_PAGE, [], JSON.stringify({note: {b: 'Hi'}})));
    expect(currentLogPage(store, ORGANIZER_NPUB)).toBeUndefined();
  });
});

describe('organizerConfig — member roll (stiq:member-roll)', () => {
  const {encryptForSpace, mintGroupKey} = require('../channels/groupCrypto') as typeof import('../channels/groupCrypto');
  const {ORGANIZER_D_MEMBER_ROLL, currentMemberRoll} = require('./organizerConfig') as typeof import('./organizerConfig');
  const KEY = mintGroupKey();
  const M1 = 'd'.repeat(64);
  const M2 = 'e'.repeat(64);

  function rollDoc(members: unknown[], opts: {v?: number; key?: Uint8Array; author?: string} = {}): Event {
    const payload = JSON.stringify({v: opts.v ?? 1, members, updated_at: 1721000000});
    return appData(opts.author ?? ORGANIZER_HEX, ORGANIZER_D_MEMBER_ROLL, [], encryptForSpace(payload, opts.key ?? KEY));
  }

  it('decrypts + parses the organizer roll into a Set', () => {
    const store = new InMemoryEventStore();
    store.save(rollDoc([M1, M2, M1, 'junk', 'ff']));
    const roll = currentMemberRoll(store, ORGANIZER_NPUB, KEY);
    expect(roll).toBeDefined();
    expect([...roll!.members].sort()).toEqual([M1, M2]);
    expect(roll!.updatedAt).toBe(1721000000);
  });

  it('newest doc wins', () => {
    const store = new InMemoryEventStore();
    store.save(rollDoc([M1]));
    store.save(rollDoc([M2]));
    expect([...currentMemberRoll(store, ORGANIZER_NPUB, KEY)!.members]).toEqual([M2]);
  });

  it('defers (undefined) without the community key', () => {
    const store = new InMemoryEventStore();
    store.save(rollDoc([M1]));
    expect(currentMemberRoll(store, ORGANIZER_NPUB, null)).toBeUndefined();
  });

  it('ignores a roll doc not authored by the organizer', () => {
    const store = new InMemoryEventStore();
    store.save(rollDoc([M1], {author: M2}));
    expect(currentMemberRoll(store, ORGANIZER_NPUB, KEY)).toBeUndefined();
  });

  it('defers on wrong key, garbage ciphertext, unknown version, and empty members', () => {
    const store = new InMemoryEventStore();
    store.save(rollDoc([M1], {key: mintGroupKey()}));
    expect(currentMemberRoll(store, ORGANIZER_NPUB, KEY)).toBeUndefined();

    const store2 = new InMemoryEventStore();
    store2.save(appData(ORGANIZER_HEX, ORGANIZER_D_MEMBER_ROLL, [], 'not-nip44'));
    expect(currentMemberRoll(store2, ORGANIZER_NPUB, KEY)).toBeUndefined();

    const store3 = new InMemoryEventStore();
    store3.save(rollDoc([M1], {v: 2}));
    expect(currentMemberRoll(store3, ORGANIZER_NPUB, KEY)).toBeUndefined();

    const store4 = new InMemoryEventStore();
    store4.save(rollDoc(['junk-only']));
    expect(currentMemberRoll(store4, ORGANIZER_NPUB, KEY)).toBeUndefined();
  });
});
