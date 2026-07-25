/**
 * useInProgressDraft — the per-location autosave slot behind the compact chat composers
 * (ChannelView/GroupView/ConversationView). Phase 4 (draft-editor-overhaul) made ComposerScreen
 * itself a DraftStore participant for the FULL editor (see ComposerScreen.tsx's `draftLocation`
 * doc), but this hook remains the persistence path for the COMPACT composer's own keystrokes — the
 * one thing ComposerScreen can't reach, since it isn't mounted/visible until "expand" is tapped.
 * Both converge on the exact same DraftStore row (same `inProgressDraftId`), so these two writers
 * never fight over "the" draft for a location — there is still exactly one.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {useInProgressDraft} from './useInProgressDraft';
import {inProgressDraftId, type Draft, type DraftLocation} from './drafts';

const LOCATION: DraftLocation = {kind: 'channel', channelId: 'chan1', channelType: 'public', channelName: '#general'};

function recordingDraftStore() {
  const saved: Draft[] = [];
  const deleted: string[] = [];
  const rows = new Map<string, Draft>();
  return {
    saved,
    deleted,
    store: {
      all: () => Promise.resolve(Array.from(rows.values())),
      save: (d: Draft) => { saved.push(d); rows.set(d.id, d); return Promise.resolve(); },
      delete: (id: string) => { deleted.push(id); rows.delete(id); return Promise.resolve(); },
    },
  };
}

/** Mount a bare component just long enough to capture the hook's stable `slot` object. */
function mountSlot(
  draftStore: ReturnType<typeof recordingDraftStore>['store'] | undefined,
  location: DraftLocation = LOCATION,
): ReturnType<typeof useInProgressDraft> {
  let captured: ReturnType<typeof useInProgressDraft> | undefined;
  function Harness(): null {
    captured = useInProgressDraft(draftStore as never, location);
    return null;
  }
  act(() => { renderer.create(<Harness />); });
  return captured!;
}

describe('useInProgressDraft', () => {
  it('persist debounce-saves a Draft keyed by inProgressDraftId(location), carrying that location', () => {
    jest.useFakeTimers();
    const {saved, store} = recordingDraftStore();
    const slot = mountSlot(store);

    act(() => { slot.persist('hello there'); });
    expect(saved).toHaveLength(0); // debounced — not yet
    act(() => { jest.advanceTimersByTime(600); });

    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).toBe(inProgressDraftId(LOCATION));
    expect(saved[0]!.location).toEqual(LOCATION);
    expect(saved[0]!.content).toBe('hello there');
    jest.useRealTimers();
  });

  it('rapid persist calls collapse into a single debounced write of the LATEST content', () => {
    jest.useFakeTimers();
    const {saved, store} = recordingDraftStore();
    const slot = mountSlot(store);

    act(() => { slot.persist('h'); });
    act(() => { slot.persist('he'); });
    act(() => { slot.persist('hel'); });
    act(() => { jest.advanceTimersByTime(600); });

    expect(saved).toHaveLength(1);
    expect(saved[0]!.content).toBe('hel');
    jest.useRealTimers();
  });

  it('persisting empty/blank content deletes the slot instead of saving an empty draft', () => {
    jest.useFakeTimers();
    const {saved, deleted, store} = recordingDraftStore();
    const slot = mountSlot(store);

    act(() => { slot.persist('   '); });
    act(() => { jest.advanceTimersByTime(600); });

    expect(saved).toHaveLength(0);
    expect(deleted).toContain(inProgressDraftId(LOCATION));
    jest.useRealTimers();
  });

  it('clear() cancels a pending debounced save and deletes the slot immediately', () => {
    jest.useFakeTimers();
    const {saved, deleted, store} = recordingDraftStore();
    const slot = mountSlot(store);

    act(() => { slot.persist('will be discarded'); });
    slot.clear();
    act(() => { jest.advanceTimersByTime(600); });

    expect(saved).toHaveLength(0); // the pending timer never fired
    expect(deleted).toContain(inProgressDraftId(LOCATION));
    jest.useRealTimers();
  });

  it('load() resolves the persisted content for this location, or null when none is saved', async () => {
    const {store} = recordingDraftStore();
    const slot = mountSlot(store);

    expect(await slot.load()).toBeNull();

    await store.save({
      id: inProgressDraftId(LOCATION),
      title: '',
      content: 'resumed text',
      tags: [],
      savedAt: Date.now(),
      location: LOCATION,
    });
    expect(await slot.load()).toBe('resumed text');
  });

  it('with no draftStore, persist/clear are no-ops and load resolves null (standalone/tests fallback)', async () => {
    jest.useFakeTimers();
    const slot = mountSlot(undefined);
    act(() => { slot.persist('anything'); });
    act(() => { jest.advanceTimersByTime(600); }); // nothing to assert against — must not throw
    slot.clear();
    expect(await slot.load()).toBeNull();
    jest.useRealTimers();
  });
});
