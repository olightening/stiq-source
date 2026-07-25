/**
 * EventDetailHost — token-based partial detail (2026-07-22): when a `stiq:event:…` embed token is
 * opened before its full kind-31923 doc has resolved (api.doc() → null), the host now builds a
 * degraded StiqEvent VM straight from the decoded EventRef (title/type/when/cover/host + the `de`
 * description snippet) and renders the REAL EventDetailScreen with a small "Fetching full
 * details…" banner, instead of the old bare "Fetching event…" skeleton. It upgrades to the real
 * doc-backed VM in place the moment the doc lands — see detailVm.ts's degradedEventFrom/
 * detailEventFrom.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {EventDetailHost} from './EventDetailHost';
import {encodeEventEmbed, parseEventEmbed} from '../eventEmbed';
import type {EventsApi} from '../api';
import type {EventDocView} from '../eventsStore';

const PK = 'a'.repeat(64);
const ADDR = {pubkey: PK, d: 'my-event'};
const COORD = `31923:${PK}:my-event`;
const noop = (): void => undefined;

function safeStringify(tree: renderer.ReactTestRenderer): string {
  return JSON.stringify(
    tree.toJSON(),
    (seen => (_k: string, v: unknown) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    })(new WeakSet<object>()),
  );
}

function makeApi(overrides: Partial<EventsApi> = {}): EventsApi {
  return {
    live: () => null,
    doc: () => null,
    myRsvp: () => null,
    token: () => null,
    tokenForDraft: () => null,
    myPubkey: () => PK,
    viewerIdentity: () => ({name: 'Viewer', npub: 'npub1viewer', grad: ''}),
    channelsIRun: () => [],
    forwardTargets: () => ({channels: [], groups: [], peers: []}),
    toggleInterested: async () => {},
    apply: async () => {},
    withdraw: async () => {},
    joinWaitlist: async () => {},
    leaveWaitlist: async () => {},
    forwardTo: async () => {},
    applications: () => [],
    guests: () => [],
    waitlist: () => [],
    stats: () => ({interested: 0, pending: 0, going: 0, waitlist: 0}),
    approve: async () => {},
    decline: async () => {},
    undoDecision: async () => {},
    offerSpot: async () => {},
    messageAll: async () => 0,
    cancel: async () => {},
    publish: async () => null,
    listEntries: async () => [],
    getEntry: async () => null,
    saveEntry: async () => {},
    removeEntry: async () => {},
    republishMine: () => {},
    ...overrides,
  };
}

const tokenRef = () =>
  parseEventEmbed(
    encodeEventEmbed({
      addr: ADDR,
      title: 'Rooftop meetup',
      description: 'DEGRADED-SNIPPET-TEXT: bring your own drinks.',
      type: 'inperson',
      hostName: 'Alice',
      waitlistEnabled: false,
    }),
  )!;

const fullDoc = (): EventDocView => ({
  addr: ADDR,
  coordinate: COORD,
  createdAt: 100,
  public: {
    title: 'Rooftop meetup',
    type: 'inperson',
    description: 'FULL-DOC-DESCRIPTION-TEXT: the complete write-up, longer than any snippet.',
    recurrence: 'none',
    waitlistEnabled: false,
    cover: {mode: 'gradient'},
    external: false,
    hostName: 'Alice',
  },
  going: 3,
  waitlistCount: 0,
  cancelled: false,
});

describe('EventDetailHost — degraded VM from a token', () => {
  it('renders the real detail screen (title + `de` snippet) with a fetching banner when the doc has not landed', () => {
    const ref = tokenRef();
    const api = makeApi({doc: () => null});

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EventDetailHost api={api} coordinate={COORD} eventRef={ref} onClose={noop} onOpenPeer={noop} />,
      );
    });

    const str = safeStringify(tree);
    expect(str).toContain('Rooftop meetup');
    expect(str).toContain('DEGRADED-SNIPPET-TEXT');
    expect(str).toContain('Fetching full details');
    // The OLD bare-skeleton copy must be gone now that a real screen renders.
    expect(str).not.toContain('Fetching event…');
  });

  it('falls back to the bare skeleton when there is neither a doc nor a token ref (raw-coordinate open)', () => {
    const api = makeApi({doc: () => null});

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EventDetailHost api={api} coordinate={COORD} eventRef={null} onClose={noop} onOpenPeer={noop} />,
      );
    });

    const str = safeStringify(tree);
    expect(str).toContain('Fetching event…');
    expect(str).not.toContain('Rooftop meetup');
  });

  it('upgrades the degraded VM to the real one in place once the doc lands, dropping the banner', () => {
    const ref = tokenRef();
    let doc: EventDocView | null = null;
    const api = makeApi({doc: () => doc});

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EventDetailHost api={api} coordinate={COORD} eventRef={ref} onClose={noop} onOpenPeer={noop} />,
      );
    });
    expect(safeStringify(tree)).toContain('DEGRADED-SNIPPET-TEXT');
    expect(safeStringify(tree)).toContain('Fetching full details');

    // The doc lands (a store version bump upstream would re-render MainScreen → this host with the
    // same coordinate/eventRef props but a now-non-null api.doc()).
    doc = fullDoc();
    act(() => {
      tree.update(
        <EventDetailHost api={api} coordinate={COORD} eventRef={ref} onClose={noop} onOpenPeer={noop} />,
      );
    });

    const str = safeStringify(tree);
    expect(str).toContain('FULL-DOC-DESCRIPTION-TEXT');
    expect(str).not.toContain('DEGRADED-SNIPPET-TEXT');
    expect(str).not.toContain('Fetching full details');
    expect(str).not.toContain('Fetching event…');
  });

  it('ignores a stale eventRef whose coordinate no longer matches the open coordinate', () => {
    const ref = tokenRef(); // coordinate === COORD
    const otherCoord = `31923:${PK}:some-other-event`;
    const api = makeApi({doc: () => null});

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <EventDetailHost api={api} coordinate={otherCoord} eventRef={ref} onClose={noop} onOpenPeer={noop} />,
      );
    });

    // ref describes a DIFFERENT coordinate than the one open — must not be used as its degraded VM.
    const str = safeStringify(tree);
    expect(str).toContain('Fetching event…');
    expect(str).not.toContain('Rooftop meetup');
  });
});
