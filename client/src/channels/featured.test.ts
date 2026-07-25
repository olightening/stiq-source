import {resolveFeatured, featuredGlyph} from './featured';
import type {Channel} from './channels';
import type {GroupState} from './groups';
import type {FeaturedSpace} from '../moderation/organizerConfig';

const OWNER = 'a'.repeat(64);
const COORD = `30311:${OWNER}:general`;

function channel(over: Partial<Channel> = {}): Channel {
  return {id: COORD, owner: OWNER, name: 'General', ...over} as Channel;
}
function group(over: Partial<GroupState> = {}): GroupState {
  return {id: 'g1', name: 'Team', closed: false, private: false, ...over} as GroupState;
}

describe('resolveFeatured', () => {
  it('returns [] for an absent or empty featured list', () => {
    expect(resolveFeatured(undefined, [], [])).toEqual([]);
    expect(resolveFeatured([], [channel()], [group()])).toEqual([]);
  });

  it("renders the OWNER's live name, not the organizer's snapshot", () => {
    // The organizer curated this row when the channel was still called "Old name". The owner has
    // since renamed it; the rail must follow the owner.
    const featured: FeaturedSpace[] = [{ref: COORD, type: 'channel', name: 'Old name'}];
    const [row] = resolveFeatured(featured, [channel({name: 'Renamed by owner'})], []);
    expect(row!.name).toBe('Renamed by owner');
    expect(row!.reachable).toBe(true);
  });

  it("keeps the organizer's label alongside the owner's name", () => {
    const featured: FeaturedSpace[] = [{ref: COORD, type: 'channel', label: 'Start here'}];
    const [row] = resolveFeatured(featured, [channel()], []);
    expect(row).toMatchObject({name: 'General', label: 'Start here'});
  });

  it("preserves the organizer's order exactly", () => {
    const c2 = `30311:${OWNER}:second`;
    const featured: FeaturedSpace[] = [
      {ref: 'g1', type: 'group'},
      {ref: c2, type: 'channel'},
      {ref: COORD, type: 'channel'},
    ];
    const rows = resolveFeatured(featured, [channel(), channel({id: c2, name: 'Second'})], [group()]);
    expect(rows.map(r => r.name)).toEqual(['Team', 'Second', 'General']);
  });

  it('falls back to the snapshot name and marks unreachable for an off-firehose group', () => {
    // A non-member has no 39000 for a featured private group — the row still renders, but the
    // caller needs to know it can't be opened yet.
    const featured: FeaturedSpace[] = [{ref: 'g-private', type: 'group', name: 'Organizers'}];
    const [row] = resolveFeatured(featured, [], []);
    expect(row).toMatchObject({name: 'Organizers', reachable: false});
  });

  it('degrades to a type stand-in when neither live metadata nor a snapshot exists', () => {
    const rows = resolveFeatured(
      [{ref: 'g-x', type: 'group'}, {ref: 'c-x', type: 'channel'}],
      [],
      [],
    );
    expect(rows.map(r => r.name)).toEqual(['Group', 'Channel']);
    // A group with no live 39000 and no member view stays inert; a channel is ALWAYS reachable —
    // tapping it fetches the 30311 by coordinate, so it must not render as a dead row.
    expect(rows[0]!.reachable).toBe(false);
    expect(rows[1]!.reachable).toBe(true);
  });

  it('keeps an unsynced channel reachable and paints it from the carried snapshot name + gradient', () => {
    // The 30311 for this featured channel hasn't reached the firehose window yet (byChannel miss).
    // The row must still render the curated name/gradient and stay tappable (fetch-on-open).
    const carried = {} as never; // opaque GradientSpec passed straight through
    const featured: FeaturedSpace[] = [
      {ref: COORD, type: 'channel', name: 'Blue hour', gradient: carried, label: 'Start here'},
    ];
    const [row] = resolveFeatured(featured, [], []);
    expect(row).toMatchObject({
      ref: COORD,
      name: 'Blue hour',
      gradient: carried,
      reachable: true,
      shape: 'square',
      seed: COORD,
    });
  });

  it('prefers the live channel gradient over the carried snapshot once the 30311 is known', () => {
    const live = {} as never;
    const carried = {} as never;
    const featured: FeaturedSpace[] = [{ref: COORD, type: 'channel', name: 'Snapshot', gradient: carried}];
    const [row] = resolveFeatured(featured, [channel({name: 'Live', gradient: live})], []);
    expect(row).toMatchObject({name: 'Live', gradient: live});
  });

  it('paints an unresolved (off-firehose) group from its carried snapshot gradient', () => {
    const carried = {} as never;
    const featured: FeaturedSpace[] = [{ref: 'g-priv', type: 'group', name: 'Organizers', gradient: carried}];
    const [row] = resolveFeatured(featured, [], []);
    expect(row).toMatchObject({name: 'Organizers', gradient: carried, reachable: false});
  });

  it('distinguishes an open community from an owner-voiced channel', () => {
    const rows = resolveFeatured(
      [{ref: COORD, type: 'channel'}],
      [channel({openCommunity: true})],
      [],
    );
    expect(rows[0]!.kind).toBe('open');
    expect(rows[0]!.glyph).toBe(featuredGlyph('open'));
  });

  it('narrows group kinds, with private winning over closed and broadcast', () => {
    const featured: FeaturedSpace[] = [
      {ref: 'g-open', type: 'group'},
      {ref: 'g-closed', type: 'group'},
      {ref: 'g-priv', type: 'group'},
      {ref: 'g-bc', type: 'group'},
    ];
    const groups = [
      group({id: 'g-open'}),
      group({id: 'g-closed', closed: true}),
      group({id: 'g-priv', private: true, closed: true, broadcast: true}),
      group({id: 'g-bc', broadcast: true}),
    ];
    expect(resolveFeatured(featured, [], groups).map(r => r.kind)).toEqual([
      'group',
      'group-closed',
      'group-private',
      'group-broadcast',
    ]);
  });

  it('assigns the same avatar shape + gradient the Channels tab uses (channels & groups)', () => {
    const c2 = `30311:${OWNER}:open`;
    const chGrad = {} as never;
    const gGrad = {} as never;
    const featured: FeaturedSpace[] = [
      {ref: COORD, type: 'channel'},
      {ref: c2, type: 'channel'},
      {ref: 'g-plain', type: 'group'},
      {ref: 'g-bc', type: 'group'},
      {ref: 'g-priv-bc', type: 'group'},
    ];
    const rows = resolveFeatured(
      featured,
      [channel({gradient: chGrad}), channel({id: c2, openCommunity: true})],
      [
        group({id: 'g-plain', gradient: gGrad}),
        group({id: 'g-bc', broadcast: true}),
        group({id: 'g-priv-bc', broadcast: true, private: true}),
      ],
    );
    // channel → square, open community → octagon (mirrors MainScreen channelRow).
    expect(rows[0]).toMatchObject({shape: 'square', seed: COORD, gradient: chGrad});
    expect(rows[1]!.shape).toBe('octagon');
    // plain group → hexagon, broadcast → octagon, broadcast+private → diamond (mirrors groupRow).
    expect(rows[2]).toMatchObject({shape: 'hexagon', gradient: gGrad});
    expect(rows[3]!.shape).toBe('octagon');
    expect(rows[4]!.shape).toBe('diamond');
  });

  it('gives every kind a distinct glyph', () => {
    const kinds = ['channel', 'open', 'group', 'group-closed', 'group-private', 'group-broadcast', 'user'] as const;
    const glyphs = kinds.map(featuredGlyph);
    expect(new Set(glyphs).size).toBe(kinds.length);
  });

  it("resolves a featured user to the viewer's learned identity, and is always reachable", () => {
    const PK = 'e'.repeat(64);
    const grad = {} as never; // opaque GradientSpec — resolveFeatured only passes it through
    const featured: FeaturedSpace[] = [{ref: PK, type: 'user', label: 'Ask me', name: 'Snapshot'}];
    const [row] = resolveFeatured(featured, [], [], pk =>
      pk === PK ? {name: 'Live name', gradient: grad} : undefined,
    );
    expect(row).toMatchObject({ref: PK, name: 'Live name', label: 'Ask me', kind: 'user', reachable: true});
    // Renders like a channel row: seeded avatar (circle), the resolved gradient passed straight through.
    expect(row).toMatchObject({seed: PK, shape: 'circle', gradient: grad});
    expect(row!.glyph).toBe(featuredGlyph('user'));
  });

  it('falls back to the organizer snapshot then a stand-in when a user name is unknown', () => {
    const featured: FeaturedSpace[] = [
      {ref: 'e'.repeat(64), type: 'user', name: 'Snapshot'},
      {ref: 'f'.repeat(64), type: 'user'},
    ];
    // No name resolver at all — still reachable (any pubkey opens a profile).
    const rows = resolveFeatured(featured, [], []);
    expect(rows.map(r => r.name)).toEqual(['Snapshot', 'Member']);
    expect(rows.every(r => r.reachable)).toBe(true);
  });
});
