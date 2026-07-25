import 'react-native';
import React from 'react';
import {Pressable} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {LogScreen, type LogScreenProps} from './LogScreen';
import {mergeLogPageCopy, type LogHearthData} from '../../channels/logPage';
import {ensureLogPagePrefsLoaded, setLogPagePrefsSlot} from '../logPagePrefs';
import type {ModLogEntry} from '../../moderation/modlog';

/**
 * The hearth — the Log tab's base view (logOpen=false): the owner's note card (collapsible to a
 * pill strip with a version-keyed persisted dismissal), the organizer-picked channels, the
 * people-worth-knowing rail, the doorway into the moderation record, and the motto.
 */

// Flattened rendered text, the house helper (matches GuideAndLog.featured.test.tsx / NotificationsScreen.test.tsx):
// walks every node rather than findAllByType(Text), which misses RN's nested text internals.
function textOf(tree: renderer.ReactTestRenderer): string {
  return tree.root
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c): c is string => typeof c === 'string')
    .join('|');
}

function baseHearth(overrides: Partial<LogHearthData> = {}): LogHearthData {
  return {
    note: {
      version: 'v1',
      title: 'A note from Mara',
      subline: 'started this community · npub1xxxx…yyyy',
      body: 'Welcome to our little corner of the internet.',
      signature: '— Mara ✦',
      gradient: null,
      seed: 'organizer',
    },
    rules: {
      body: 'Be kind. No spam. Report issues to a moderator.',
      eyebrow: 'Standing rules',
      meta: 'Set by the organizers · updated 2d ago',
      startExpanded: false,
    },
    picks: [
      {
        ref: 'ch1',
        name: 'General',
        kind: 'open',
        glyph: '🌐',
        reachable: true,
        seed: 'ch1',
        shape: 'octagon',
        blurb: 'the town square',
        chip: 'Open',
        membersLabel: '48 members',
      },
      {
        ref: 'g1',
        name: 'Organizers',
        kind: 'group-private',
        glyph: '🕶️',
        reachable: false,
        seed: 'g1',
        shape: 'diamond',
        blurb: 'staff only',
        chip: 'Private',
      },
    ],
    people: [
      {pubkey: 'a'.repeat(64), name: 'Alice', role: 'keeps the peace', gradient: null, seed: 'a'.repeat(64)},
      {pubkey: 'b'.repeat(64), name: 'Bob', role: 'answers questions', gradient: null, seed: 'b'.repeat(64)},
    ],
    copy: mergeLogPageCopy({}),
    showPeople: true,
    aurora: true,
    ...overrides,
  };
}

function modEntry(key: string, moderatorPubkey: string, moderatorNpub: string): ModLogEntry {
  return {
    key,
    action: 'hide',
    targetType: 'post',
    target: `target-${key}`,
    targetAuthorPubkey: 'f'.repeat(64),
    moderatorPubkey,
    moderatorNpub,
    timestamp: Math.floor(Date.now() / 1000) - 120,
    reason: 'Broke a rule.',
  };
}

// Two entries, two distinct moderators → doorway sub reads "2 actions · 2 moderators · ...".
const TWO_ENTRIES: ModLogEntry[] = [
  modEntry('1', 'c'.repeat(64), 'npub1mod1'),
  modEntry('2', 'd'.repeat(64), 'npub1mod2'),
];

function mount(hearth: LogHearthData | null, overrides: Partial<LogScreenProps> = {}): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <LogScreen
        isModerator={false}
        hearth={hearth}
        logOpen={false}
        onSetLogOpen={() => undefined}
        onOpenPick={() => undefined}
        entries={[]}
        openEntryKey={null}
        onOpenEntry={() => undefined}
        {...overrides}
      />,
    );
  });
  return tree;
}

/** Flush real microtasks + a macrotask tick — enough for the async dismiss/undismiss persistence
 *  chain (ensureLogPagePrefsLoaded → set mutation → AsyncStorage.setItem) to settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe('LogScreen — the hearth', () => {
  it('renders the note title, body and signature', () => {
    const hearth = baseHearth();
    const tree = mount(hearth);
    const all = textOf(tree);
    expect(all).toContain('A note from Mara');
    expect(all).toContain('Welcome to our little corner of the internet.');
    expect(all).toContain('— Mara ✦');
    tree.unmount();
  });

  it('renders picks in order with a curly-quoted blurb and the kind chip', () => {
    const hearth = baseHearth();
    const tree = mount(hearth);
    const all = textOf(tree);
    expect(all).toContain('General');
    expect(all).toContain('“the town square”');
    expect(all).toContain('Open');
    expect(all).toContain('Organizers');
    expect(all).toContain('“staff only”');
    expect(all).toContain('Private');
    // Organizer's order preserved.
    expect(all.indexOf('General')).toBeLessThan(all.indexOf('Organizers'));
    tree.unmount();
  });

  it('renders person names on the people rail', () => {
    const hearth = baseHearth();
    const tree = mount(hearth);
    const all = textOf(tree);
    expect(all).toContain('Alice');
    expect(all).toContain('keeps the peace');
    expect(all).toContain('Bob');
    expect(all).toContain('answers questions');
    tree.unmount();
  });

  it('fills the doorway sub-line with live action/moderator counts', () => {
    const hearth = baseHearth();
    const tree = mount(hearth, {entries: TWO_ENTRIES});
    const all = textOf(tree);
    expect(all).toContain('2 actions · 2 moderators · every one explained');
    tree.unmount();
  });

  it('renders the motto', () => {
    const hearth = baseHearth();
    const tree = mount(hearth);
    expect(textOf(tree)).toContain('✦ nothing here ever disappears quietly ✦');
    tree.unmount();
  });

  it('rules toggle initially reads "Read the standing rules"', () => {
    const hearth = baseHearth();
    const tree = mount(hearth);
    expect(textOf(tree)).toContain('Read the standing rules');
    tree.unmount();
  });

  it('tapping the reachable pick calls onOpenPick with the channel route + name', () => {
    const onOpenPick = jest.fn();
    const hearth = baseHearth();
    const tree = mount(hearth, {onOpenPick});
    const card = tree.root.findByProps({accessibilityLabel: 'General, Open channel, 48 members'});
    act(() => {
      card.props.onPress();
    });
    expect(onOpenPick).toHaveBeenCalledWith('ch1', 'channel', 'General');
    tree.unmount();
  });

  it('an unresolved (private, not-yet-joined) group pick still opens — the integrator routes it to the join dialog', () => {
    const onOpenPick = jest.fn();
    const hearth = baseHearth();
    const tree = mount(hearth, {onOpenPick});
    const card = tree.root
      .findAllByType(Pressable)
      .find(p => p.props.accessibilityLabel === 'Organizers, Private channel');
    expect(card).toBeTruthy();
    expect(card!.props.disabled).toBeFalsy();
    act(() => {
      card!.props.onPress();
    });
    expect(onOpenPick).toHaveBeenCalledWith('g1', 'group', 'Organizers');
    tree.unmount();
  });

  it('tapping a person calls onOpenPick with the user route', () => {
    const onOpenPick = jest.fn();
    const hearth = baseHearth();
    const tree = mount(hearth, {onOpenPick});
    const card = tree.root.findByProps({accessibilityLabel: 'Alice, keeps the peace'});
    act(() => {
      card.props.onPress();
    });
    expect(onOpenPick).toHaveBeenCalledWith('a'.repeat(64), 'user');
    tree.unmount();
  });

  it('tapping the doorway calls onSetLogOpen(true)', () => {
    const onSetLogOpen = jest.fn();
    const hearth = baseHearth();
    const tree = mount(hearth, {onSetLogOpen});
    const doorway = tree.root
      .findAllByType(Pressable)
      .find(p => String(p.props.accessibilityLabel ?? '').startsWith('Open the community log —'));
    expect(doorway).toBeTruthy();
    act(() => {
      doorway!.props.onPress();
    });
    expect(onSetLogOpen).toHaveBeenCalledWith(true);
    tree.unmount();
  });

  it('hearth=null renders the doorway with default copy and does not crash', () => {
    const tree = mount(null);
    const all = textOf(tree);
    expect(all).toContain('Open the community log');
    expect(all).toContain('✦ nothing here ever disappears quietly ✦');
    expect(all).toContain('0 actions · 0 moderators · every one explained');
    tree.unmount();
  });

  it('showPeople=false hides the people section entirely', () => {
    const hearth = baseHearth({showPeople: false});
    const tree = mount(hearth);
    const all = textOf(tree);
    expect(all).not.toContain('Alice');
    expect(all).not.toContain('Bob');
    expect(all).not.toContain(hearth.copy.peopleHeader);
    tree.unmount();
  });

  it('THE TUCK-AWAY CONTRACT: tuck persists across remounts; a new note version auto-reopens; reopen clears the dismissal', async () => {
    // Isolate this test's persisted dismissal state from every other test/file sharing the module.
    setLogPagePrefsSlot('hearth-tuck-contract');
    await ensureLogPagePrefsLoaded();

    const hearthV1 = baseHearth();
    const noteTitle = hearthV1.note!.title;

    // Initial mount: never dismissed → the full card renders, tuck control present.
    let tree = mount(hearthV1);
    expect(tree.root.findByProps({accessibilityLabel: 'Tuck this note away'})).toBeTruthy();
    expect(textOf(tree)).toContain(hearthV1.note!.body);

    // Tap "Tuck away".
    const tuckBtn = tree.root.findByProps({accessibilityLabel: 'Tuck this note away'});
    act(() => {
      tuckBtn.props.onPress();
    });
    // The collapsed pill strip renders immediately (local component state), containing the note
    // title and the "reopen" control.
    expect(tree.root.findByProps({accessibilityLabel: `${noteTitle} — collapsed. Reopen`})).toBeTruthy();
    expect(textOf(tree)).toContain(hearthV1.copy.reopenLabel);
    expect(() => tree.root.findByProps({accessibilityLabel: 'Tuck this note away'})).toThrow();

    // Let the async dismissNote() persistence (AsyncStorage mock + module cache) settle before
    // unmounting, so a FRESH mount reads the dismissal back.
    await flush();
    tree.unmount();

    // Fresh mount, SAME hearth (v1) → still collapsed (the persisted dismissal survives remount).
    tree = mount(hearthV1);
    expect(tree.root.findByProps({accessibilityLabel: `${noteTitle} — collapsed. Reopen`})).toBeTruthy();
    expect(() => tree.root.findByProps({accessibilityLabel: 'Tuck this note away'})).toThrow();
    tree.unmount();

    // A NEW note (a different version) must never be suppressed by the stale v1 dismissal — the
    // full card auto-expands.
    const hearthV2 = baseHearth({
      note: {...hearthV1.note!, version: 'v2', title: 'A note from Mara (updated)'},
    });
    tree = mount(hearthV2);
    expect(tree.root.findByProps({accessibilityLabel: 'Tuck this note away'})).toBeTruthy();
    tree.unmount();

    // Back on v1: a fresh mount is still collapsed (v1's dismissal is untouched by the v2 note).
    tree = mount(hearthV1);
    const reopenBtn = tree.root.findByProps({accessibilityLabel: `${noteTitle} — collapsed. Reopen`});
    act(() => {
      reopenBtn.props.onPress();
    });
    // Reopen expands the card immediately in this instance too.
    expect(tree.root.findByProps({accessibilityLabel: 'Tuck this note away'})).toBeTruthy();

    await flush();
    tree.unmount();

    // A fresh mount with v1 now stays expanded — the dismissal was cleared.
    tree = mount(hearthV1);
    expect(tree.root.findByProps({accessibilityLabel: 'Tuck this note away'})).toBeTruthy();
    tree.unmount();
  });
});
