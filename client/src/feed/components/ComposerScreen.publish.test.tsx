/**
 * ComposerScreen publish flow — closes on publish, and NEVER claims an outcome it doesn't wait for.
 *
 * The composer used to hold a blocking "Posting to the community…" overlay for the whole write and
 * then reveal a "Posted ✓ — Your post is live in the community feed" recap. Both were wrong:
 *  - the write includes a blind-token draw over Tor (PoW + round-trips, many seconds), so the tap
 *    hung while the post already sat durably in the feed BEHIND the overlay — the user-reported
 *    "clicking publish lags" bug; and
 *  - once the composer stops waiting for the write (it must, to stop hanging), it has no outcome to
 *    report — so a success recap would announce "live in the community feed" for posts that go on to
 *    FAIL, immediately before App.tsx's "Couldn't post right now" Alert contradicts it.
 *
 * So: publishing closes the composer as soon as the write is UNDER WAY and says nothing. The honest
 * feedback comes from the surfaces that outlive this screen and therefore know the real answer — the
 * feed's durable send indicator ('sending' ring → 'failed' + Retry), and App.tsx's root "✓ Posted"
 * Toast once the relay has actually taken the post (AppSnapshot.postsDelivered; pinned in
 * src/app/postConfirmation.test.ts and src/ui/Toast.test.tsx). That confirmation is deliberately NOT
 * reachable from here: a screen that doesn't wait for the outcome must not be the one announcing it.
 * These tests pin the composer's half of that contract — no success claim, no spinner, always closes
 * — plus the two cases where closing would be wrong or impossible:
 *  - REFUSED before the write started (onSubmit rejects — App.tsx's synchronous rate-limit gate):
 *    nothing was published, so the composer keeps its text AND draft and re-arms Publish.
 *  - a contract-violating onSubmit that never settles: PUBLISH_CEILING_MS closes anyway, so the
 *    composer can never be hung open by re-wiring onSubmit back to the write's promise.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@react-native-clipboard/clipboard', () => ({setString: jest.fn(), getString: jest.fn(() => Promise.resolve(''))}), {virtual: true});
jest.mock('react-native-webview', () => ({WebView: () => null}), {virtual: true});

const rich: {flushCb?: (md: string) => void} = {};
jest.mock('./RichEditor', () => {
  const React = require('react');
  return {
    RichEditor: React.forwardRef((props: {onChange: (md: string) => void; value: string}, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({
        cmd() {}, insertLink() {}, paste() {}, focus() {}, insertToken() {},
        requestMarkdown(cb: (md: string) => void) { rich.flushCb = cb; },
      }));
      return null;
    }),
  };
});
jest.mock('./PictureComposer', () => ({PictureComposer: () => null}));
jest.mock('./VoiceComposer', () => ({VoiceComposer: () => null}));

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {ComposerScreen} from './ComposerScreen';

/** Concatenated text under a node (react-test-renderer). */
function textOf(node: renderer.ReactTestInstance): string {
  return node.findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c): c is string => typeof c === 'string')
    .join('');
}

/** Press the pill/button whose visible label exactly equals `label`. */
function press(tree: renderer.ReactTestRenderer, label: string): void {
  const target = tree.root
    .findAll(n => typeof n.props?.onPress === 'function')
    .find(n => textOf(n).trim() === label);
  if (!target) throw new Error(`no pressable labelled "${label}"`);
  act(() => { target.props.onPress(); });
}

function hasText(tree: renderer.ReactTestRenderer, needle: string): boolean {
  return tree.root.findAll(() => true).some(n =>
    Array.isArray(n.children) && n.children.some(c => typeof c === 'string' && c.includes(needle)),
  );
}

/** Assert the composer is making no claim about the post's fate, in any wording. */
function expectNoOutcomeClaim(tree: renderer.ReactTestRenderer): void {
  expect(hasText(tree, 'Posted')).toBe(false);
  expect(hasText(tree, 'live in the community feed')).toBe(false);
  expect(hasText(tree, 'Posting to the community')).toBe(false);
}

/** A draft store that records deletes, so we can prove a refused write never discards the post. */
function recordingDraftStore() {
  const deleted: string[] = [];
  const saved: {id: string; content: string}[] = [];
  return {
    deleted,
    saved,
    store: {
      all: () => Promise.resolve([]),
      save: (d: {id: string; content: string}) => { saved.push({id: d.id, content: d.content}); return Promise.resolve(); },
      delete: (id: string) => { deleted.push(id); return Promise.resolve(); },
    },
  };
}

function baseProps(onSubmit: (...args: unknown[]) => void | Promise<unknown>, onClose: jest.Mock) {
  return {
    visible: true,
    onClose,
    onSubmit,
    initialDraft: {id: 'd1', title: '', content: 'hello world', tags: ['art'], label: null, savedAt: 0},
  };
}

/** Drive the composer from step 1 through to a submitted Publish tap (incl. the editor flush). */
function submit(tree: renderer.ReactTestRenderer): void {
  press(tree, 'Next');
  press(tree, 'Publish');
  act(() => { rich.flushCb!('hello world'); });
}

// NOTE: fake timers are installed INSIDE each test that needs them, never in a beforeEach. Jest arms
// its own 5s per-test timeout on a real timer around the whole test (hooks included); installing the
// fakes before that point lets advanceTimersByTime() run the fake clock straight through jest's
// timeout and fail the test spuriously. Installing them inside the test body avoids that.
describe('ComposerScreen publish — closes immediately, claims nothing', () => {
  it('closes on publish without ever claiming success — even though the write is still in flight', async () => {
    jest.useFakeTimers();
    try {
      const onClose = jest.fn();
      // The real wiring (App.tsx): fire the write off and return — the promise, and therefore the
      // outcome, is deliberately NOT handed back to the composer.
      const onSubmit = jest.fn();
      const {deleted, store} = recordingDraftStore();
      let tree!: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(<ComposerScreen {...baseProps(onSubmit, onClose)} draftStore={store as never} />);
      });

      submit(tree);
      await act(async () => { await Promise.resolve(); });

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1); // handed off to the feed's durable send indicator
      expect(deleted).toContain('d1'); // the write is under way, so the draft is retired
      expectNoOutcomeClaim(tree);

      // And no recap appears on a delay either: the old flow revealed "Posted ✓" only after a
      // POST_DELAY_MS (900ms) floor once onSubmit settled — which is exactly how a post that later
      // FAILED still got announced as "live in the community feed". Past that floor: still nothing.
      await act(async () => { jest.advanceTimersByTime(3_000); });
      expectNoOutcomeClaim(tree);
      act(() => { tree.unmount(); });
    } finally {
      jest.useRealTimers();
    }
    // 20s budget: this is the suite's FIRST test, so it pays the cold module require + first mount
    // of the whole composer tree; that broke jest's default 5s on a loaded machine even BEFORE the
    // v2 editor work (verified by running this suite against the pre-change component). The budget
    // is about logic, not perf — the same flow re-runs warm in <200ms in the tests below.
  }, 20_000);

  it('keeps the composer, its text and its draft when the write is REFUSED before it starts', async () => {
    const onClose = jest.fn();
    // App.tsx's synchronous rate-limit gate: it alerts ("Limit reached") and rejects WITHOUT starting
    // the write. Nothing was published, so closing here would silently throw the post away.
    const onSubmit = jest.fn(() => Promise.reject(new Error('Limit reached')));
    const {deleted, store} = recordingDraftStore();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<ComposerScreen {...baseProps(onSubmit, onClose)} draftStore={store as never} />);
    });

    submit(tree);
    await act(async () => { await Promise.resolve(); });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled(); // stays open — the post is not lost
    expect(deleted).not.toContain('d1'); // and neither is its draft
    expectNoOutcomeClaim(tree);

    // Publish is re-armed, so the user can simply try again once the limit passes.
    press(tree, 'Publish');
    act(() => { rich.flushCb!('hello world'); });
    await act(async () => { await Promise.resolve(); });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    act(() => { tree.unmount(); });
  });

  it('never hangs open: an onSubmit that never settles hits the ceiling, closes, and still claims nothing', async () => {
    jest.useFakeTimers();
    try {
      const onClose = jest.fn();
      // A contract violation — e.g. onSubmit re-wired to return AppRuntime.post()'s promise, which
      // awaits the multi-second Tor blind draw. That is the original "publish tap hangs" bug; the
      // ceiling is what stops it from ever hanging the composer open again.
      const onSubmit = jest.fn(() => new Promise(() => {}));
      let tree!: renderer.ReactTestRenderer;
      act(() => { tree = renderer.create(<ComposerScreen {...baseProps(onSubmit, onClose)} />); });

      submit(tree);
      await act(async () => { await Promise.resolve(); });
      expect(onClose).not.toHaveBeenCalled(); // still waiting on the refusal verdict

      await act(async () => { jest.advanceTimersByTime(2_000); }); // PUBLISH_CEILING_MS
      expect(onClose).toHaveBeenCalledTimes(1); // closed rather than hung
      expectNoOutcomeClaim(tree); // and the fallback is a close, never a fabricated success
      act(() => { tree.unmount(); });
    } finally {
      jest.useRealTimers();
    }
  });

  it('a second Publish tap during the editor flush cannot start a second publish', async () => {
    const onClose = jest.fn();
    const onSubmit = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<ComposerScreen {...baseProps(onSubmit, onClose)} />); });

    // The flush is an async round-trip to the RichEditor WebView. Publishing no longer raises a
    // blocking overlay over that window, so the in-flight latch is the only thing preventing a
    // double-tap from publishing the post twice.
    press(tree, 'Next');
    press(tree, 'Publish');
    press(tree, 'Publish');
    act(() => { rich.flushCb!('hello world'); });
    await act(async () => { await Promise.resolve(); });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });
});
