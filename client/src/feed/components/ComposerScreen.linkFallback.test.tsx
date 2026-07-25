/**
 * ComposerScreen "Add a link" — the ref-unavailable fallback (see ComposerScreen.link.test.tsx for
 * the normal insertLink(text, url) forwarding path, and RichEditor.test.tsx for the OTHER half of
 * bug 4's fix — send() queuing a command issued before the page announces 'ready', instead of
 * silently dropping it).
 *
 * This file pins the one path that can't be fixed inside RichEditor itself: if the ref genuinely
 * isn't there (edRef.current is null), `edRef.current?.insertLink(...)` used to just no-op — the
 * user's link vanished with no trace, no error, nothing. insertLink() must now fall back to inserting
 * the markdown form straight into the body instead of dropping it.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@react-native-clipboard/clipboard', () => ({setString: jest.fn(), getString: jest.fn(() => Promise.resolve(''))}), {virtual: true});
jest.mock('react-native-webview', () => ({WebView: () => null}), {virtual: true});

// A RichEditor stand-in that never attaches an imperative handle — `ref.current` stays null for the
// whole test, exactly like a genuinely unavailable ref (as opposed to "not ready yet", which is
// RichEditor's OWN concern and doesn't reach ComposerScreen at all — see the module doc above).
jest.mock('./RichEditor', () => {
  const React = require('react');
  return {
    RichEditor: React.forwardRef((_props: {onChange: (md: string) => void; value: string}, _ref: React.Ref<unknown>) => null),
  };
});
jest.mock('./PictureComposer', () => ({PictureComposer: () => null}));
jest.mock('./VoiceComposer', () => ({VoiceComposer: () => null}));

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {ComposerScreen} from './ComposerScreen';

function pressByLabel(tree: renderer.ReactTestRenderer, label: string): void {
  const target = tree.root.findAll(n => n.props?.accessibilityLabel === label)[0];
  if (!target) throw new Error(`no pressable labelled "${label}"`);
  act(() => { target.props.onPress(); });
}
function pressByText(tree: renderer.ReactTestRenderer, label: string): void {
  const target = tree.root
    .findAll(n => typeof n.props?.onPress === 'function')
    .find(n => n.findAll(() => true)
      .flatMap(x => (Array.isArray(x.children) ? x.children : []))
      .filter((c): c is string => typeof c === 'string').join('').trim() === label);
  if (!target) throw new Error(`no pressable labelled "${label}"`);
  act(() => { target.props.onPress(); });
}
function fillLinkUrl(tree: renderer.ReactTestRenderer, url: string): void {
  const input = tree.root.findAll(n => n.props?.placeholder === 'https://…  or  stiq:…')[0];
  if (!input) throw new Error('link URL input not found — did the dialog open?');
  act(() => { input.props.onChangeText(url); });
}

describe('ComposerScreen "Add a link" — the ref-unavailable fallback never drops the link', () => {
  it('messageMode: falls back to the markdown form in the body, which still reaches onChangeDraft via Done', () => {
    const onChangeDraft = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={jest.fn()}
          headerTitle="Comment"
          value=""
          onChangeDraft={onChangeDraft}
          onSubmit={jest.fn()}
        />,
      );
    });
    pressByLabel(tree, 'Insert link');
    fillLinkUrl(tree, 'https://example.com');
    pressByText(tree, 'Add link');
    // Done flushes via edRef.current.requestMarkdown — but the ref is null here, so ComposerScreen's
    // own fallback (finish(content)) is what carries the body out, exactly the path a genuinely
    // ref-less composer would take.
    pressByText(tree, 'Done');
    expect(onChangeDraft).toHaveBeenCalledWith('[https://example.com](https://example.com)');
    act(() => { tree.unmount(); });
  });

  it('gives the link a visible label when the dialog title differs from the URL', () => {
    const onChangeDraft = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={jest.fn()}
          headerTitle="Comment"
          value="check this out"
          onChangeDraft={onChangeDraft}
          onSubmit={jest.fn()}
        />,
      );
    });
    pressByLabel(tree, 'Insert link');
    fillLinkUrl(tree, 'https://example.com/a');
    // No linkTitle typed in this pass — falls back to the URL as its own label (same default the
    // real insertLink(text, url) call uses: linkTitle.trim() || url).
    pressByText(tree, 'Add link');
    pressByText(tree, 'Done');
    // The pre-existing body is preserved; the link is appended, never silently dropped.
    expect(onChangeDraft).toHaveBeenCalledWith('check this out\n\n[https://example.com/a](https://example.com/a)');
    act(() => { tree.unmount(); });
  });

  it('normalizes a bare host to https:// in the fallback too (same scheme rule as the ref-present path)', () => {
    const onChangeDraft = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ComposerScreen
          visible
          messageMode
          onClose={jest.fn()}
          headerTitle="Comment"
          value=""
          onChangeDraft={onChangeDraft}
          onSubmit={jest.fn()}
        />,
      );
    });
    pressByLabel(tree, 'Insert link');
    fillLinkUrl(tree, 'example.com');
    pressByText(tree, 'Add link');
    pressByText(tree, 'Done');
    expect(onChangeDraft).toHaveBeenCalledWith('[https://example.com](https://example.com)');
    act(() => { tree.unmount(); });
  });
});
