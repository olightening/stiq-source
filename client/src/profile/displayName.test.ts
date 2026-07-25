import {
  DisplayNameStore,
  encodeNameHeader,
  encodeIdentityHeader,
  encodeInviteHeader,
  decodeNameHeader,
  decodeInviteHeader,
  sanitizeName,
  MAX_DISPLAY_NAME,
} from './displayName';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('name header', () => {
  it('round-trips a name + text', () => {
    const body = encodeNameHeader('hello world', 'Ada');
    const {name, text} = decodeNameHeader(body);
    expect(name).toBe('Ada');
    expect(text).toBe('hello world');
  });

  it('is a no-op when the name is empty', () => {
    expect(encodeNameHeader('hi', '')).toBe('hi');
    expect(decodeNameHeader('hi')).toEqual({text: 'hi'});
  });

  it('sanitizes control chars and clamps length', () => {
    expect(sanitizeName('Ada')).toBe('Ada');
    expect(sanitizeName('x'.repeat(100)).length).toBe(MAX_DISPLAY_NAME);
  });

  it('a header injected mid-text is NOT decoded (only a leading header counts)', () => {
    expect(decodeNameHeader('hi nEve')).toEqual({text: 'hi nEve'});
  });
});

describe('space-invite header (SOH-i frame, membership handoff)', () => {
  it('round-trips the wire and strips it from the visible text', () => {
    const body = encodeInviteHeader('You are invited', 'AbC_d-123');
    expect(decodeInviteHeader(body)).toBe('AbC_d-123');
    // EVERY text renderer goes through decodeNameHeader — the frame must vanish there too.
    expect(decodeNameHeader(body)).toEqual({text: 'You are invited'});
  });

  it('composes with the identity headers in any order', () => {
    const body = encodeIdentityHeader(encodeInviteHeader('come join', 'Zz9-_'), 'Maeve R.', '');
    expect(decodeNameHeader(body)).toEqual({name: 'Maeve R.', text: 'come join'});
    expect(decodeInviteHeader(body)).toBe('Zz9-_');
  });

  it('refuses a wire that could break the framing (non-base64url or oversized)', () => {
    expect(encodeInviteHeader('hi', 'has spaces!')).toBe('hi');
    // Oversized past the frame budget (1600 — sized to carry an optional invite grant) is refused.
    expect(encodeInviteHeader('hi', 'x'.repeat(1601))).toBe('hi');
    expect(encodeInviteHeader('hi', 'x'.repeat(1600))).not.toBe('hi'); // exactly at the limit is OK
    expect(encodeInviteHeader('hi', '')).toBe('hi');
  });

  it('a frame injected mid-text is NOT decoded', () => {
    expect(decodeInviteHeader('hello iAbc world')).toBeUndefined();
  });
});

describe('DisplayNameStore — longest-held-wins', () => {
  it('learns a name and renders it for its owner', async () => {
    const s = new DisplayNameStore(null);
    await s.learn(A, 'Ada', 100);
    expect(s.nameFor(A)).toBe('Ada');
    expect(s.nameFor(B)).toBeUndefined();
  });

  it('gives a clashed name to the earliest claimant; later claimant shows npub', async () => {
    const s = new DisplayNameStore(null);
    await s.learn(A, 'Ada', 100); // A claims first
    await s.learn(B, 'Ada', 200); // B claims the same name later
    expect(s.nameFor(A)).toBe('Ada');
    expect(s.nameFor(B)).toBeUndefined();
    expect(s.ownerOf('Ada')).toBe(A);
  });

  it('ownership is order-independent (B learned before A still loses)', async () => {
    const s = new DisplayNameStore(null);
    await s.learn(B, 'Ada', 200); // learned first, but claimed later
    await s.learn(A, 'Ada', 100); // learned second, but claimed earlier
    expect(s.nameFor(A)).toBe('Ada');
    expect(s.nameFor(B)).toBeUndefined();
  });

  it('keeps only the earliest claim time when the same pubkey re-claims', async () => {
    const s = new DisplayNameStore(null);
    await s.learn(A, 'Ada', 300);
    await s.learn(A, 'Ada', 100); // earlier sighting wins
    await s.learn(B, 'Ada', 200);
    expect(s.nameFor(A)).toBe('Ada'); // A now beats B (100 < 200)
    expect(s.nameFor(B)).toBeUndefined();
  });

  it('frees a vacated name for the next-earliest claimant when the owner renames', async () => {
    const s = new DisplayNameStore(null);
    await s.learn(A, 'Ada', 100);
    await s.learn(B, 'Ada', 200); // B blocked by A
    expect(s.nameFor(B)).toBeUndefined();
    await s.learn(A, 'Bob', 300); // A abandons "Ada"
    expect(s.nameFor(A)).toBe('Bob');
    expect(s.nameFor(B)).toBe('Ada'); // B inherits the freed name
  });

  it('breaks exact-time ties deterministically by pubkey order', async () => {
    const s = new DisplayNameStore(null);
    await s.learn(C, 'Ada', 100);
    await s.learn(A, 'Ada', 100);
    expect(s.ownerOf('Ada')).toBe(A); // 'aaa…' < 'ccc…'
    expect(s.nameFor(C)).toBeUndefined();
  });

  it('persists and reloads the phonebook with claim times', async () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: async (k: string) => mem.get(k) ?? null,
      setItem: async (k: string, v: string) => void mem.set(k, v),
      removeItem: async (k: string) => void mem.delete(k),
    };
    const s1 = new DisplayNameStore(storage);
    await s1.load();
    await s1.learn(A, 'Ada', 100);
    await s1.learn(B, 'Ada', 200);
    await s1.flush(); // persist is debounced; force the write before reload

    const s2 = new DisplayNameStore(storage);
    await s2.load();
    expect(s2.nameFor(A)).toBe('Ada');
    expect(s2.nameFor(B)).toBeUndefined();
  });
});

describe('DisplayNameStore.nameConflict — surfacing the silent loss', () => {
  const NOW = 1_000;

  it('reports nothing when nobody else claims the name', async () => {
    const s = new DisplayNameStore(null);
    await s.setMyName('Ada');
    expect(s.nameConflict(A, undefined, NOW)).toBeUndefined();
  });

  it('reports nothing when the viewer has no name set', async () => {
    const s = new DisplayNameStore(null);
    await s.learn(B, 'Ada', 100);
    expect(s.nameConflict(A, undefined, NOW)).toBeUndefined();
  });

  it('reports the earlier claimant when the viewer has definitively lost', async () => {
    const s = new DisplayNameStore(null);
    await s.setMyName('Ada');
    await s.learn(B, 'Ada', 100); // B was using it before us
    await s.learn(A, 'Ada', 200); // our own content round-tripped, claiming later
    expect(s.nameConflict(A, undefined, NOW)).toEqual({name: 'Ada', owner: B, ownerSince: 100});
    // ...and this is exactly the state where the community renders us as a bare npub:
    expect(s.nameFor(A)).toBeUndefined();
  });

  it('reports nothing when the viewer is the earlier claimant (they keep the name)', async () => {
    const s = new DisplayNameStore(null);
    await s.setMyName('Ada');
    await s.learn(A, 'Ada', 100); // we claimed first
    await s.learn(B, 'Ada', 200); // a later impersonator
    expect(s.nameConflict(A, undefined, NOW)).toBeUndefined();
    expect(s.nameFor(A)).toBe('Ada');
  });

  it('agrees with ownerOf whenever the viewer has already authored under the name', async () => {
    // The two must never disagree: nameConflict is ownerOf's arbitration, seeded with our claim.
    for (const [myAt, theirAt] of [[100, 200], [200, 100], [150, 150]]) {
      const s = new DisplayNameStore(null);
      await s.setMyName('Ada');
      await s.learn(A, 'Ada', myAt!);
      await s.learn(B, 'Ada', theirAt!);
      const lost = s.ownerOf('Ada') !== A;
      expect(!!s.nameConflict(A, undefined, NOW)).toBe(lost);
    }
  });

  it('breaks an exact timestamp tie the same way ownerOf does (lower hex wins)', async () => {
    const s = new DisplayNameStore(null);
    await s.setMyName('Ada');
    await s.learn(B, 'Ada', 100);
    await s.learn(C, 'Ada', 100); // same instant as B; A is 'aaa…' so A would win a tie
    // C ('ccc…') claims at the same second as us — we win on hex order, so no conflict.
    await s.learn(A, 'Ada', 100);
    expect(s.ownerOf('Ada')).toBe(A);
    expect(s.nameConflict(A, undefined, NOW)).toBeUndefined();
  });

  it('picks the OLDEST rival when several hold the name', async () => {
    const s = new DisplayNameStore(null);
    await s.setMyName('Ada');
    await s.learn(B, 'Ada', 300);
    await s.learn(C, 'Ada', 50); // the true owner
    await s.learn(A, 'Ada', 400);
    expect(s.nameConflict(A, undefined, NOW)).toEqual({name: 'Ada', owner: C, ownerSince: 50});
  });

  it('treats a name we have chosen but never posted under as claimed from "now"', async () => {
    // The subtle one. Our claim is absent from the phonebook until our own content round-trips, so
    // it must be modelled as starting now — every existing claimant is therefore earlier, which is
    // the truth: peers cannot award us a name on the strength of content they've never seen.
    const s = new DisplayNameStore(null);
    await s.setMyName('Ada');
    await s.learn(B, 'Ada', 100);
    expect(s.nameConflict(A, undefined, NOW)).toEqual({name: 'Ada', owner: B, ownerSince: 100});
  });

  it('does NOT use "now" once our own earlier claim is known (no false positive)', async () => {
    // The false-positive guard for the case above: our claim IS in the book and predates theirs,
    // so we must be told we're fine even though `now` is later than both.
    const s = new DisplayNameStore(null);
    await s.setMyName('Ada');
    await s.learn(A, 'Ada', 100);
    await s.learn(B, 'Ada', 200);
    expect(s.nameConflict(A, undefined, NOW)).toBeUndefined();
  });

  it('models a not-yet-published RENAME from "now", ignoring our claim on the old name', async () => {
    // We're recorded under 'Ada' (an old, still-unrevised claim) but have just chosen 'Bea'
    // locally. Our 'Ada' timestamp says nothing about 'Bea' — that claim starts now.
    const s = new DisplayNameStore(null);
    await s.learn(A, 'Ada', 100);
    await s.learn(B, 'Bea', 500);
    await s.setMyName('Bea');
    expect(s.nameConflict(A, undefined, NOW)).toEqual({name: 'Bea', owner: B, ownerSince: 500});
  });

  it('answers for an explicit name, not just the viewer\'s own', async () => {
    const s = new DisplayNameStore(null);
    await s.setMyName('Ada');
    await s.learn(B, 'Bea', 100);
    expect(s.nameConflict(A, 'Bea', NOW)).toEqual({name: 'Bea', owner: B, ownerSince: 100});
    expect(s.nameConflict(A, 'Cy', NOW)).toBeUndefined();
  });

  it('compares sanitized names, so header-breaking input can\'t dodge a real clash', async () => {
    const s = new DisplayNameStore(null);
    await s.learn(B, 'Ada', 100);
    expect(s.nameConflict(A, '  Ada  ', NOW)).toEqual({name: 'Ada', owner: B, ownerSince: 100});
  });

  it('reports nothing for an empty pubkey or name', async () => {
    const s = new DisplayNameStore(null);
    await s.learn(B, 'Ada', 100);
    expect(s.nameConflict('', 'Ada', NOW)).toBeUndefined();
    expect(s.nameConflict(A, '', NOW)).toBeUndefined();
  });
});
