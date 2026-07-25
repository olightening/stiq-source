import {
  LOG_PAGE_COPY_DEFAULTS,
  mergeLogPageCopy,
  fillDoorwaySub,
  legacyLogPageDoc,
  resolveLogPage,
  type ResolveLogPageOpts,
} from './logPage';
import type {LogPageDoc, GuideDoc, FeaturedSpace} from '../moderation/organizerConfig';
import type {GradientSpec} from '../media/gradient';
import type {Channel} from './channels';
import type {GroupState} from './groups';
import {shortenNpub, safeNpubEncode} from '../util/npub';

const OWNER = 'a'.repeat(64);
const COORD = `30311:${OWNER}:general`;

function channel(over: Partial<Channel> = {}): Channel {
  return {id: COORD, owner: OWNER, name: 'General', ...over} as Channel;
}
function group(over: Partial<GroupState> = {}): GroupState {
  return {id: 'g1', name: 'Team', closed: false, private: false, ...over} as GroupState;
}

function emptyDoc(over: Partial<LogPageDoc> = {}): LogPageDoc {
  return {
    note: undefined,
    rules: undefined,
    picks: [],
    people: [],
    copy: {},
    showPeople: true,
    aurora: true,
    updatedAt: 0,
    ...over,
  };
}

function baseOpts(over: Partial<ResolveLogPageOpts> = {}): ResolveLogPageOpts {
  return {
    channels: [],
    groups: [],
    nowMs: 1_700_000_000_000,
    ...over,
  };
}

describe('mergeLogPageCopy', () => {
  it('returns every default verbatim for {}', () => {
    const copy = mergeLogPageCopy({});
    expect(copy).toEqual(LOG_PAGE_COPY_DEFAULTS);
    expect(copy.picksHeader).toBe('Picked by the organizers');
    expect(copy.motto).toBe('✦ nothing here ever disappears quietly ✦');
    expect(copy.doorwaySub).toBe('{n} actions · {m} moderators · every one explained');
  });

  it('returns defaults for undefined overrides too', () => {
    expect(mergeLogPageCopy(undefined)).toEqual(LOG_PAGE_COPY_DEFAULTS);
  });

  it('overrides replace only their own slot, leaving the rest at defaults', () => {
    const copy = mergeLogPageCopy({motto: 'Custom motto'});
    expect(copy.motto).toBe('Custom motto');
    expect(copy.picksHeader).toBe(LOG_PAGE_COPY_DEFAULTS.picksHeader);
    expect(copy.doorwayTitle).toBe(LOG_PAGE_COPY_DEFAULTS.doorwayTitle);
  });

  it('an empty-string override keeps the default (not blanked)', () => {
    const copy = mergeLogPageCopy({motto: '', picksHeader: '   '});
    expect(copy.motto).toBe(LOG_PAGE_COPY_DEFAULTS.motto);
    expect(copy.picksHeader).toBe(LOG_PAGE_COPY_DEFAULTS.picksHeader);
  });
});

describe('fillDoorwaySub', () => {
  it('replaces every {n} and {m} occurrence', () => {
    expect(fillDoorwaySub('{n} actions · {m} moderators · every one explained', 12, 3)).toBe(
      '12 actions · 3 moderators · every one explained',
    );
  });

  it('replaces repeated placeholders', () => {
    expect(fillDoorwaySub('{n}/{n} by {m}/{m}', 5, 2)).toBe('5/5 by 2/2');
  });
});

describe('legacyLogPageDoc', () => {
  it('maps the guide to rules body + updatedAt', () => {
    const guide: GuideDoc = {title: 'House rules', content: 'Be kind. No spam.', updatedAt: 12345};
    const doc = legacyLogPageDoc(guide, undefined);
    expect(doc.rules).toEqual({body: 'Be kind. No spam.', updatedAt: 12345, startExpanded: false});
    expect(doc.updatedAt).toBe(12345);
    expect(doc.note).toBeUndefined();
  });

  it('maps featured channels/groups to picks, organizer label → blurb', () => {
    const featured: FeaturedSpace[] = [
      {ref: COORD, type: 'channel', label: 'Start here', name: 'General'},
      {ref: 'g1', type: 'group', label: 'Staff only', name: 'Team'},
    ];
    const doc = legacyLogPageDoc(undefined, featured);
    expect(doc.picks).toEqual([
      {ref: COORD, type: 'channel', blurb: 'Start here', name: 'General', gradient: undefined},
      {ref: 'g1', type: 'group', blurb: 'Staff only', name: 'Team', gradient: undefined},
    ]);
  });

  it('maps featured users to people, organizer label → role', () => {
    const PK = 'e'.repeat(64);
    const featured: FeaturedSpace[] = [{ref: PK, type: 'user', label: 'Ask me anything', name: 'Alice'}];
    const doc = legacyLogPageDoc(undefined, featured);
    expect(doc.people).toEqual([{pubkey: PK, role: 'Ask me anything', name: 'Alice'}]);
    expect(doc.picks).toEqual([]);
  });

  it('empty/absent inputs produce no rules and empty arrays', () => {
    const doc = legacyLogPageDoc(undefined, undefined);
    expect(doc.rules).toBeUndefined();
    expect(doc.picks).toEqual([]);
    expect(doc.people).toEqual([]);
    expect(doc.updatedAt).toBe(0);
    expect(doc.showPeople).toBe(true);
    expect(doc.aurora).toBe(true);
  });

  it('an empty-content guide is treated as no rules (upstream already normalizes this, but stay defensive)', () => {
    const guide: GuideDoc = {title: 'X', content: '', updatedAt: 1};
    const doc = legacyLogPageDoc(guide, []);
    expect(doc.rules).toBeUndefined();
  });
});

describe('resolveLogPage — note', () => {
  it("derives the note title 'A note from <name>' and a subline containing a shortened npub, when unconfigured", () => {
    const doc = emptyDoc({note: {version: 'v1', body: 'Hello there.'}});
    const opts = baseOpts({organizer: {pubkey: OWNER, name: 'Mara', gradient: null}});
    const {note} = resolveLogPage(doc, opts);
    expect(note?.title).toBe('A note from Mara');
    const shortened = shortenNpub(safeNpubEncode(OWNER), {lead: 12, tail: 4});
    expect(note?.subline).toContain(shortened);
    expect(note?.body).toBe('Hello there.');
  });

  it('falls back to a generic title when the organizer name is unknown', () => {
    const doc = emptyDoc({note: {version: 'v1', body: 'Hi.'}});
    const {note} = resolveLogPage(doc, baseOpts());
    expect(note?.title).toBe('A note from the organizer');
    expect(note?.subline).toBe('started this community');
  });

  it('an explicit title/subline always wins over the derived ones', () => {
    const doc = emptyDoc({
      note: {version: 'v1', title: 'Custom title', subline: 'Custom sub', body: 'Hi.'},
    });
    const {note} = resolveLogPage(doc, baseOpts({organizer: {pubkey: OWNER, name: 'Mara'}}));
    expect(note?.title).toBe('Custom title');
    expect(note?.subline).toBe('Custom sub');
  });

  it('carries the organizer gradient and version through untouched', () => {
    const grad = {} as never;
    const doc = emptyDoc({note: {version: 'v7', body: 'Hi.'}});
    const {note} = resolveLogPage(doc, baseOpts({organizer: {pubkey: OWNER, gradient: grad}}));
    expect(note?.version).toBe('v7');
    expect(note?.gradient).toBe(grad);
    expect(note?.seed).toBe(OWNER);
  });

  it("the note's own hand-picked gradient wins over the organizer's live profile gradient", () => {
    const picked: GradientSpec = {type: 'linear', angle: 90, stops: ['#111111', '#222222']};
    const live: GradientSpec = {type: 'radial', angle: 0, stops: ['#333333', '#444444']};
    const doc = emptyDoc({note: {version: 'v1', body: 'Hi.', gradient: picked}});
    const {note} = resolveLogPage(doc, baseOpts({organizer: {pubkey: OWNER, gradient: live}}));
    expect(note?.gradient).toBe(picked);
  });

  it('is undefined when the doc has no note', () => {
    expect(resolveLogPage(emptyDoc(), baseOpts()).note).toBeUndefined();
  });
});

describe('resolveLogPage — welcome window (Point 6)', () => {
  // baseOpts nowMs = 1_700_000_000_000 → nowSec = 1_700_000_000.
  const NOW_SEC = 1_700_000_000;
  const letter = {version: 'n1', body: 'The standing letter.'};
  const welcome = {version: 'w1', body: 'Welcome aboard!', durSecs: 3600};

  it('shows the welcome inside the window for a tracked member', () => {
    const doc = emptyDoc({note: letter, welcome});
    const {note} = resolveLogPage(doc, baseOpts({firstEnteredAt: NOW_SEC - 100}));
    expect(note?.body).toBe('Welcome aboard!');
    expect(note?.version).toBe('w1');
  });

  it('hands over to the letter after the window (distinct version → auto-reopen)', () => {
    const doc = emptyDoc({note: letter, welcome});
    const {note} = resolveLogPage(doc, baseOpts({firstEnteredAt: NOW_SEC - 7200}));
    expect(note?.body).toBe('The standing letter.');
    expect(note?.version).toBe('n1');
  });

  it('never shows the welcome to an untracked member (firstEnteredAt 0)', () => {
    const doc = emptyDoc({note: letter, welcome});
    const {note} = resolveLogPage(doc, baseOpts({firstEnteredAt: 0}));
    expect(note?.body).toBe('The standing letter.');
  });

  it('untracked member with only a welcome sees NO card', () => {
    const doc = emptyDoc({welcome});
    expect(resolveLogPage(doc, baseOpts({firstEnteredAt: 0})).note).toBeUndefined();
  });

  it('the welcome stays when there is no letter yet (tracked, in window)', () => {
    const doc = emptyDoc({welcome});
    const {note} = resolveLogPage(doc, baseOpts({firstEnteredAt: NOW_SEC - 100}));
    expect(note?.body).toBe('Welcome aboard!');
  });

  it('derives a welcome-flavored title from the organizer name', () => {
    const doc = emptyDoc({welcome});
    const {note} = resolveLogPage(doc, baseOpts({firstEnteredAt: NOW_SEC - 100, organizer: {pubkey: OWNER, name: 'Mara'}}));
    expect(note?.title).toBe('A welcome from Mara');
  });
});

describe('resolveLogPage — pick unread (Point 2)', () => {
  it('carries an unread count from unreadOf onto the pick', () => {
    const doc = emptyDoc({picks: [{ref: COORD, type: 'channel'}]});
    const {picks} = resolveLogPage(doc, baseOpts({
      channels: [channel()],
      unreadOf: ref => (ref === COORD ? 3 : 0),
    }));
    expect(picks[0]?.unread).toBe(3);
  });

  it('omits the bubble when unreadOf returns 0', () => {
    const doc = emptyDoc({picks: [{ref: COORD, type: 'channel'}]});
    const {picks} = resolveLogPage(doc, baseOpts({channels: [channel()], unreadOf: () => 0}));
    expect(picks[0]?.unread).toBeUndefined();
  });
});

describe('resolveLogPage — chip derivation', () => {
  it("derives 'Open' for an open-community channel pick", () => {
    const doc = emptyDoc({picks: [{ref: COORD, type: 'channel'}]});
    const opts = baseOpts({channels: [channel({openCommunity: true})]});
    expect(resolveLogPage(doc, opts).picks[0]!.chip).toBe('Open');
  });

  it("derives 'Private' for a private-group pick", () => {
    const doc = emptyDoc({picks: [{ref: 'g1', type: 'group'}]});
    const opts = baseOpts({groups: [group({private: true})]});
    expect(resolveLogPage(doc, opts).picks[0]!.chip).toBe('Private');
  });

  it('a per-pick chip override wins over the derived kind chip', () => {
    const doc = emptyDoc({picks: [{ref: COORD, type: 'channel', chip: 'Custom'}]});
    const opts = baseOpts({channels: [channel({openCommunity: true})]});
    expect(resolveLogPage(doc, opts).picks[0]!.chip).toBe('Custom');
  });
});

describe('resolveLogPage — pick membersLabel', () => {
  it("shows '1 member' / 'N members' from memberCountOf", () => {
    const doc = emptyDoc({
      picks: [
        {ref: 'g1', type: 'group'},
        {ref: 'g2', type: 'group'},
      ],
    });
    const opts = baseOpts({
      groups: [group({id: 'g1'}), group({id: 'g2', name: 'Big'})],
      memberCountOf: (ref: string) => (ref === 'g1' ? 1 : 42),
    });
    const picks = resolveLogPage(doc, opts).picks;
    expect(picks[0]!.membersLabel).toBe('1 member');
    expect(picks[1]!.membersLabel).toBe('42 members');
  });

  it('is absent when memberCountOf returns undefined', () => {
    const doc = emptyDoc({picks: [{ref: COORD, type: 'channel'}]});
    const opts = baseOpts({channels: [channel()], memberCountOf: () => undefined});
    expect(resolveLogPage(doc, opts).picks[0]!.membersLabel).toBeUndefined();
  });

  it('is absent when memberCountOf is not supplied at all', () => {
    const doc = emptyDoc({picks: [{ref: COORD, type: 'channel'}]});
    const opts = baseOpts({channels: [channel()]});
    expect(resolveLogPage(doc, opts).picks[0]!.membersLabel).toBeUndefined();
  });
});

describe('resolveLogPage — people identity fallback', () => {
  const PK = 'e'.repeat(64);

  it('falls back to the configured snapshot name when unresolved', () => {
    const doc = emptyDoc({people: [{pubkey: PK, name: 'Snapshot'}]});
    expect(resolveLogPage(doc, baseOpts()).people[0]!.name).toBe('Snapshot');
  });

  it('falls back to a shortened npub when neither live identity nor a snapshot is known', () => {
    const doc = emptyDoc({people: [{pubkey: PK}]});
    const {people} = resolveLogPage(doc, baseOpts());
    expect(people[0]!.name).toBe(shortenNpub(safeNpubEncode(PK), {lead: 12, tail: 4}));
  });

  it('prefers the live learned identity over the configured snapshot', () => {
    const doc = emptyDoc({people: [{pubkey: PK, name: 'Snapshot'}]});
    const opts = baseOpts({userInfo: pk => (pk === PK ? {name: 'Live name'} : undefined)});
    expect(resolveLogPage(doc, opts).people[0]!.name).toBe('Live name');
  });
});

describe('resolveLogPage — rules meta', () => {
  it("derives 'Set by the organizers · updated Xd ago' from rules.updatedAt", () => {
    const doc = emptyDoc({rules: {body: 'Body', startExpanded: false, updatedAt: 1_699_827_200}});
    const opts = baseOpts({nowMs: 1_700_000_000_000});
    const {rules} = resolveLogPage(doc, opts);
    expect(rules?.meta).toMatch(/^Set by the organizers · updated \d+[mhd] ago$/);
  });

  it('falls back to the doc-level updatedAt when rules.updatedAt is absent', () => {
    const doc = emptyDoc({rules: {body: 'Body', startExpanded: false}, updatedAt: 1_699_827_200});
    const {rules} = resolveLogPage(doc, baseOpts({nowMs: 1_700_000_000_000}));
    expect(rules?.meta).toMatch(/updated \d+[mhd] ago$/);
  });

  it('has no age suffix when neither timestamp is known', () => {
    const doc = emptyDoc({rules: {body: 'Body', startExpanded: false}});
    const {rules} = resolveLogPage(doc, baseOpts());
    expect(rules?.meta).toBe('Set by the organizers');
  });

  it('an explicit meta override wins', () => {
    const doc = emptyDoc({rules: {body: 'Body', startExpanded: true, meta: 'Custom meta line'}});
    const {rules} = resolveLogPage(doc, baseOpts());
    expect(rules?.meta).toBe('Custom meta line');
    expect(rules?.startExpanded).toBe(true);
  });

  it("defaults the eyebrow to 'Standing rules'", () => {
    const doc = emptyDoc({rules: {body: 'Body', startExpanded: false}});
    const {rules} = resolveLogPage(doc, baseOpts());
    expect(rules?.eyebrow).toBe('Standing rules');
  });
});
