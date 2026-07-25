/**
 * ComposerScreen inline-media bridge guard. Proves the placeholder fix end-to-end at the component
 * level: inserting a picture / voice clip feeds the RichEditor ONLY a compact placeholder (never the
 * multi-KB base64 that the WebView bridge drops), and Publish reassembles the FULL token for onSubmit.
 * See INLINE_MEDIA_POST_FAILURE.md §0.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@react-native-clipboard/clipboard', () => ({setString: jest.fn(), getString: jest.fn(() => Promise.resolve(''))}), {virtual: true});
jest.mock('react-native-webview', () => ({WebView: () => null}), {virtual: true});

// Capture the RichEditor imperative interactions + its controlled `value`.
const rich: {inserted: string[]; onChange?: (md: string) => void; flushCb?: (md: string) => void; values: string[]} = {
  inserted: [],
  values: [],
};
jest.mock('./RichEditor', () => {
  const React = require('react');
  return {
    RichEditor: React.forwardRef((props: {onChange: (md: string) => void; value: string}, ref: React.Ref<unknown>) => {
      rich.onChange = props.onChange;
      rich.values.push(props.value);
      React.useImperativeHandle(ref, () => ({
        cmd() {}, insertLink() {}, paste() {}, focus() {},
        insertToken(t: string) { rich.inserted.push(t); },
        requestMarkdown(cb: (md: string) => void) { rich.flushCb = cb; },
      }));
      return null;
    }),
  };
});
// Capture the media-composer callbacks so we can trigger an insert without opening their UIs.
const media: {onAdd?: (t: string) => void; onSend?: (v: unknown) => void} = {};
jest.mock('./PictureComposer', () => ({
  PictureComposer: (props: {onAdd: (t: string) => void}) => { media.onAdd = props.onAdd; return null; },
}));
jest.mock('./VoiceComposer', () => ({
  VoiceComposer: (props: {onSend: (v: unknown) => void}) => { media.onSend = props.onSend; return null; },
}));

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {ComposerScreen} from './ComposerScreen';
import {encodeInlineVoice, type VoiceMessage} from '../voice';

const BIG_PIC_B64 = 'A'.repeat(60 * 1024);
const FULL_PIC = `[[pic:16;4;l=art;${BIG_PIC_B64}]]`;

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

function baseProps(onSubmit: jest.Mock) {
  return {
    visible: true,
    onClose: jest.fn(),
    onSubmit,
    // Pre-fill a tag so the Details step passes without driving the tag input.
    initialDraft: {id: 'd1', title: '', content: '', tags: ['art'], label: null, savedAt: 0},
    allowVoice: true,
    pictureRules: {allow: true, maxRes: 256, maxColours: 64, maxBytes: 64 * 1024, periodHours: 24, periodBytes: 0} as never,
    pictureSpentBytes: 0,
  };
}

describe('ComposerScreen — inline media never crosses the WebView bridge as base64', () => {
  it('inserts a picture as a PLACEHOLDER and publishes the FULL token', () => {
    const onSubmit = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<ComposerScreen {...baseProps(onSubmit)} />); });

    // 1) Insert a 60KB picture (as the PictureComposer would).
    act(() => { media.onAdd!(FULL_PIC); });

    // The editor received ONLY a compact placeholder — the base64 never touched the bridge.
    expect(rich.inserted).toHaveLength(1);
    const placeholder = rich.inserted[0]!;
    expect(placeholder).toContain('STIQMEDIAREF');
    expect(placeholder).not.toContain(BIG_PIC_B64);
    expect(placeholder.length).toBeLessThan(64);

    // 2) The editor reflects that placeholder back as its content (the real 'change' event).
    act(() => { rich.onChange!(placeholder); });
    // The controlled `value` handed to the editor is ALWAYS the placeholder — never reassembled base64.
    expect(rich.values.every(v => !v.includes(BIG_PIC_B64))).toBe(true);

    // 3) Next → Publish. The flush returns the placeholder body (tiny, so it survives the bridge).
    press(tree, 'Next');
    press(tree, 'Publish');
    expect(typeof rich.flushCb).toBe('function');
    act(() => { rich.flushCb!(placeholder); });

    // onSubmit gets the FULL base64 token reassembled — the published note carries the real picture.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submittedBody = onSubmit.mock.calls[0][0] as string;
    expect(submittedBody).toBe(FULL_PIC);
    expect(submittedBody).toContain(BIG_PIC_B64);
    expect(submittedBody).not.toContain('STIQMEDIAREF');

    act(() => { tree.unmount(); });
  });

  it('after publishing, a re-armed autosave cannot resurrect the draft or persist a dangling placeholder', async () => {
    jest.useFakeTimers();
    try {
      const saved: {id: string; content: string}[] = [];
      const deleted: string[] = [];
      const draftStore = {
        all: () => Promise.resolve([]),
        save: (d: {id: string; content: string}) => { saved.push({id: d.id, content: d.content}); return Promise.resolve(); },
        delete: (id: string) => { deleted.push(id); return Promise.resolve(); },
      };
      const onSubmit = jest.fn();
      let tree!: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(<ComposerScreen {...baseProps(onSubmit)} draftStore={draftStore as never} />);
      });

      act(() => { media.onAdd!(FULL_PIC); });
      const placeholder = rich.inserted[0]!;
      act(() => { rich.onChange!(placeholder); });

      press(tree, 'Next');
      press(tree, 'Publish');
      // Faithfully reproduce the RichEditor 'flushed' path: onChange (re-arms the autosave) THEN the
      // publish callback (deletes the draft). This is the exact ordering that used to leave a zombie
      // timer armed after the draft was deleted.
      // The draft is deleted on doPublish's CLOSING path — which waits one microtask for onSubmit's
      // "refused?" verdict, since a refused write must keep its draft — so flush microtasks before
      // asserting the delete landed.
      await act(async () => { rich.onChange!(placeholder); rich.flushCb!(placeholder); await Promise.resolve(); });

      expect(onSubmit.mock.calls[0][0]).toBe(FULL_PIC); // published with the real picture
      expect(deleted).toContain('d1');

      // Simulate reopening the composer for a NEW post within the autosave window (swaps the media map).
      act(() => { tree.update(<ComposerScreen {...baseProps(onSubmit)} draftStore={draftStore as never} visible={false} />); });
      act(() => { tree.update(<ComposerScreen {...{...baseProps(onSubmit), initialDraft: undefined}} draftStore={draftStore as never} />); });
      act(() => { jest.advanceTimersByTime(2000); }); // fire any lingering autosave

      // No autosave ever persisted a dangling placeholder, and the published draft was not resurrected.
      expect(saved.every(d => !d.content.includes('STIQMEDIAREF'))).toBe(true);
      act(() => { tree.unmount(); });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reassembles a media-only note (no prose) so it is never published empty', () => {
    const onSubmit = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<ComposerScreen {...baseProps(onSubmit)} />); });

    // A freshly recorded clip: bytes in hand, so an `inline` source (feed/voice.ts). The composer
    // always embeds inline; the payload is moved out to a blob later, at publish.
    const audio = 'B'.repeat(200 * 1024);
    const clip: VoiceMessage = {
      source: {kind: 'inline', payloadBase64: audio},
      mimeType: 'audio/mp4',
      durationSec: 20,
      weightBytes: audio.length,
    };
    const voiceFull = encodeInlineVoice(clip);
    act(() => { media.onSend!(clip); });
    const placeholder = rich.inserted[0]!;
    expect(placeholder).not.toContain('B'.repeat(1024));
    act(() => { rich.onChange!(placeholder); });

    press(tree, 'Next');
    press(tree, 'Publish');
    act(() => { rich.flushCb!(placeholder); });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe(voiceFull); // full audio token, not empty, not a placeholder
    act(() => { tree.unmount(); });
  });
});
