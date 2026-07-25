/**
 * ComposerScreen messageMode — the chat-composer variant that replaced FullMessageEditor in
 * channels/groups/DMs/comments (see ComposerScreen.tsx's messageMode doc). Two properties are
 * load-bearing and specific to this mode (neither existed for plain bodyOnly, which stayed
 * uncontrolled/uses initialBody):
 *  - The body is CONTROLLED: every edit round-trips through onChangeDraft, exactly like the
 *    retired FullMessageEditor's onChangeDraft, so the caller's own draft state / autosave slot
 *    never falls behind what's on screen.
 *  - Because of that, Cancel closes immediately with NO discard confirmation — unlike plain
 *    bodyOnly (Events), which still confirms since it only hands content back on Done.
 * Also pins: the right pill uses `submitLabel`, no word-ceiling meter renders, and long-pressing
 * "Drafts" calls the caller's `onLongPressDrafts` (not the internal DraftStore path bodyOnly/post
 * mode use) and flashes "Saved ✓".
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@react-native-clipboard/clipboard', () => ({setString: jest.fn(), getString: jest.fn(() => Promise.resolve(''))}), {virtual: true});
jest.mock('react-native-webview', () => ({WebView: () => null}), {virtual: true});

const rich: {onChangeCb?: (md: string) => void} = {};
jest.mock('./RichEditor', () => {
  const React = require('react');
  return {
    RichEditor: React.forwardRef((props: {onChange: (md: string) => void; value: string}, ref: React.Ref<unknown>) => {
      rich.onChangeCb = props.onChange;
      React.useImperativeHandle(ref, () => ({
        cmd() {}, insertLink() {}, paste() {}, focus() {}, insertToken() {},
        requestMarkdown(cb: (md: string) => void) { cb(props.value); },
      }));
      return null;
    }),
  };
});
jest.mock('./PictureComposer', () => ({PictureComposer: () => null}));
jest.mock('./VoiceComposer', () => ({VoiceComposer: () => null}));

import 'react-native';
import React from 'react';
import {Alert} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {ComposerScreen} from './ComposerScreen';
import {inProgressDraftId, type Draft, type DraftLocation} from '../drafts';

function textOf(node: renderer.ReactTestInstance): string {
  return node.findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c): c is string => typeof c === 'string')
    .join('');
}
function press(tree: renderer.ReactTestRenderer, label: string): void {
  const target = tree.root
    .findAll(n => typeof n.props?.onPress === 'function')
    .find(n => textOf(n).trim() === label);
  if (!target) throw new Error(`no pressable labelled "${label}"`);
  act(() => { target.props.onPress(); });
}
function findByLabel(tree: renderer.ReactTestRenderer, label: string): renderer.ReactTestInstance | undefined {
  return tree.root.findAll(n => n.props?.accessibilityLabel === label)[0];
}
function hasText(tree: renderer.ReactTestRenderer, needle: string): boolean {
  return tree.root.findAll(() => true).some(n =>
    Array.isArray(n.children) && n.children.some(c => typeof c === 'string' && c.includes(needle)),
  );
}

describe('ComposerScreen messageMode', () => {
  beforeEach(() => { rich.onChangeCb = undefined; });

  it('seeds the body from the controlled `value` prop on open, behind a DONE pill', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={jest.fn()}
          headerTitle="#general"
          value="already typed in the bubble"
          onChangeDraft={jest.fn()}
          // A caller cannot relabel the pill into a send it does not perform.
          submitLabel="Send"
        />,
      );
    });
    expect(hasText(tree, 'Done')).toBe(true);
    expect(hasText(tree, 'Send')).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('pushes every edit back to the caller via onChangeDraft (controlled, not uncontrolled)', () => {
    const onChangeDraft = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={jest.fn()}
          headerTitle="#general"
          value=""
          onChangeDraft={onChangeDraft}
          onSubmit={jest.fn()}
        />,
      );
    });
    act(() => { rich.onChangeCb?.('hello there'); });
    expect(onChangeDraft).toHaveBeenCalledWith('hello there');
    act(() => { tree.unmount(); });
  });

  it('Cancel closes immediately with NO discard confirmation (unlike plain bodyOnly)', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const onClose = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={onClose}
          headerTitle="#general"
          value="a half-written message"
          onChangeDraft={jest.fn()}
          onSubmit={jest.fn()}
        />,
      );
    });
    act(() => { rich.onChangeCb?.('edited further'); });
    press(tree, 'Cancel');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    alertSpy.mockRestore();
    act(() => { tree.unmount(); });
  });

  it('plain bodyOnly (Events) still confirms discard on Cancel — unaffected by messageMode', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const onClose = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          bodyOnly
          onClose={onClose}
          headerTitle="Description"
          initialBody=""
          onSubmit={jest.fn()}
        />,
      );
    });
    act(() => { rich.onChangeCb?.('some description text'); });
    press(tree, 'Cancel');
    expect(alertSpy).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    alertSpy.mockRestore();
    act(() => { tree.unmount(); });
  });

  it('hides the word-ceiling meter (a chat message is not an article)', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={jest.fn()}
          headerTitle="#general"
          value="hi"
          onChangeDraft={jest.fn()}
          onSubmit={jest.fn()}
        />,
      );
    });
    expect(hasText(tree, 'words left')).toBe(false);
    expect(hasText(tree, 'Up to')).toBe(false);
    act(() => { tree.unmount(); });
  });

  it('long-pressing "Drafts" calls onLongPressDrafts (the caller\'s own flush) and flashes "Saved ✓"', () => {
    jest.useFakeTimers();
    const onLongPressDrafts = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={jest.fn()}
          headerTitle="#general"
          value="draft in progress"
          onChangeDraft={jest.fn()}
          onSubmit={jest.fn()}
          onOpenDrafts={jest.fn()}
          onLongPressDrafts={onLongPressDrafts}
        />,
      );
    });
    const draftsBtn = findByLabel(tree, 'view drafts');
    expect(draftsBtn).toBeTruthy();
    act(() => { draftsBtn!.props.onLongPress(); });
    expect(onLongPressDrafts).toHaveBeenCalledTimes(1);
    expect(hasText(tree, 'Saved ✓')).toBe(true);
    act(() => { jest.advanceTimersByTime(1600); });
    expect(hasText(tree, 'Saved ✓')).toBe(false);
    jest.useRealTimers();
    act(() => { tree.unmount(); });
  });
});

/**
 * ComposerScreen messageMode — Phase 4 (`draftStore` + `draftLocation`): the screen becomes a real
 * DraftStore participant for channel/group/DM composers, instead of a dumb controlled text box that
 * only ever hands text back up through `onChangeDraft`. A recording fake store (matching the shape
 * ComposerScreen.publish.test.tsx already uses for the post-mode equivalent) lets these tests assert
 * on exactly which id/location a save landed under, without needing the real SecureStorage-backed
 * DraftStore (that round-trip is already covered in full by drafts.test.ts).
 */
describe('ComposerScreen messageMode — Phase 4 (self-persisting DraftStore drafts)', () => {
  const LOCATION: DraftLocation = {kind: 'channel', channelId: 'chan1', channelType: 'public', channelName: '#general'};

  function recordingDraftStore() {
    const saved: Draft[] = [];
    const deleted: string[] = [];
    return {
      saved,
      deleted,
      store: {
        all: () => Promise.resolve([]),
        save: (d: Draft) => { saved.push(d); return Promise.resolve(); },
        delete: (id: string) => { deleted.push(id); return Promise.resolve(); },
      },
    };
  }

  it('autosave writes a Draft keyed by inProgressDraftId(location), carrying that location', () => {
    jest.useFakeTimers();
    const {saved, store} = recordingDraftStore();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={jest.fn()}
          headerTitle="#general"
          value=""
          onChangeDraft={jest.fn()}
          onSubmit={jest.fn()}
          draftStore={store as never}
          draftLocation={LOCATION}
        />,
      );
    });
    act(() => { rich.onChangeCb?.('hello there'); });
    act(() => { jest.advanceTimersByTime(900); }); // > AUTOSAVE_DEBOUNCE_MS
    expect(saved.length).toBeGreaterThan(0);
    const last = saved[saved.length - 1]!;
    expect(last.id).toBe(inProgressDraftId(LOCATION));
    expect(last.location).toEqual(LOCATION);
    expect(last.content).toBe('hello there');
    jest.useRealTimers();
    act(() => { tree.unmount(); });
  });

  it('one draft per location: further edits keep updating the SAME id, never a second stray draft', () => {
    jest.useFakeTimers();
    const {saved, store} = recordingDraftStore();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={jest.fn()}
          headerTitle="#general"
          value=""
          onChangeDraft={jest.fn()}
          onSubmit={jest.fn()}
          draftStore={store as never}
          draftLocation={LOCATION}
        />,
      );
    });
    act(() => { rich.onChangeCb?.('first pass'); });
    act(() => { jest.advanceTimersByTime(900); });
    act(() => { rich.onChangeCb?.('second pass'); });
    act(() => { jest.advanceTimersByTime(900); });
    expect(saved.length).toBeGreaterThanOrEqual(2);
    expect(new Set(saved.map(d => d.id)).size).toBe(1); // exactly one slot for this location
    expect(saved[saved.length - 1]!.content).toBe('second pass');
    jest.useRealTimers();
    act(() => { tree.unmount(); });
  });

  /**
   * DONE IS NOT SEND. The editor is a bigger way to WRITE; the message is posted by the composer
   * bubble's ↑, the same path a message typed without ever opening the editor takes. Two things
   * follow, and both are what this pins:
   *
   *  - `onSubmit` is never called. If it were, a surface would have two send paths to keep in
   *    agreement forever — and each call site's own `send()` is the one that knows about edit-vs-new,
   *    reply targets and slot clearing.
   *  - the draft slot is NOT deleted. Nothing was sent, so the writing has to survive Done.
   */
  it('Done hands the body back and closes — it does not send, and does not retire the draft', () => {
    const {deleted, store} = recordingDraftStore();
    const onSubmit = jest.fn();
    const onChangeDraft = jest.fn();
    const onClose = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={onClose}
          headerTitle="#general"
          value="ready to send"
          onChangeDraft={onChangeDraft}
          onSubmit={onSubmit}
          draftStore={store as never}
          draftLocation={LOCATION}
        />,
      );
    });
    press(tree, 'Done');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChangeDraft).toHaveBeenCalledWith('ready to send');
    expect(deleted).not.toContain(inProgressDraftId(LOCATION));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  it('Done stays available on an emptied body (nothing to trap the writer behind)', () => {
    const onClose = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen visible messageMode onClose={onClose} headerTitle="#general" value="" onChangeDraft={jest.fn()} />,
      );
    });
    // A writer who deletes everything must still be able to leave by the front door; the bubble's ↑
    // is what refuses to send an empty message.
    press(tree, 'Done');
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  it('long-pressing "Drafts" self-saves via the DraftStore (NOT onLongPressDrafts) once a location is wired, and flashes "Saved ✓"', () => {
    jest.useFakeTimers();
    const onLongPressDrafts = jest.fn();
    const {saved, store} = recordingDraftStore();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={jest.fn()}
          headerTitle="#general"
          value="draft in progress"
          onChangeDraft={jest.fn()}
          onSubmit={jest.fn()}
          onOpenDrafts={jest.fn()}
          onLongPressDrafts={onLongPressDrafts}
          draftStore={store as never}
          draftLocation={LOCATION}
        />,
      );
    });
    const draftsBtn = findByLabel(tree, 'view drafts');
    act(() => { draftsBtn!.props.onLongPress(); });
    expect(onLongPressDrafts).not.toHaveBeenCalled(); // self-saved instead of delegating
    expect(saved.some(d => d.id === inProgressDraftId(LOCATION) && d.content === 'draft in progress')).toBe(true);
    expect(hasText(tree, 'Saved ✓')).toBe(true);
    act(() => { jest.advanceTimersByTime(1600); });
    expect(hasText(tree, 'Saved ✓')).toBe(false);
    jest.useRealTimers();
    act(() => { tree.unmount(); });
  });
});
