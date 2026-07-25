/**
 * ComposerScreen "Add a link" — stiq: deep-link scheme handling.
 *
 * Ported from the retired FullMessageEditor's own copy of this test when FullMessageEditor was
 * deleted (its insert bar/link dialog were absorbed into ComposerScreen's messageMode — see
 * ComposerScreen.tsx's messageMode doc). The bug this guards: the link dialog's typed URL fed
 * through a check that only recognized `https?://` — any other scheme (including our own `stiq:`
 * deep links, e.g. `stiq://join?c=…`) fell into the "no scheme" branch and got `https://`
 * PREPENDED, corrupting `stiq://join?c=…` into `https://stiq://join?c=…` before it even reached the
 * WebView editor's own allowlist (richEditorHtml.ts — see richEditorHtml.test.ts for that half of
 * the round-trip). Ordinary bare-host input (e.g. "example.com") must still get https:// prepended.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@react-native-clipboard/clipboard', () => ({setString: jest.fn(), getString: jest.fn(() => Promise.resolve(''))}), {virtual: true});
jest.mock('react-native-webview', () => ({WebView: () => null}), {virtual: true});

// Capture exactly what the component hands to the RichEditor's imperative insertLink(text, url).
const rich: {links: {text: string; url: string}[]} = {links: []};
jest.mock('./RichEditor', () => {
  const React = require('react');
  return {
    RichEditor: React.forwardRef((_props: {onChange: (md: string) => void; value: string}, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({
        cmd() {}, paste() {}, focus() {}, insertToken() {},
        insertLink(text: string, url: string) { rich.links.push({text, url}); },
        requestMarkdown(cb: (md: string) => void) { cb(''); },
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

/** Press the pressable whose accessibilityLabel matches (the insert bar is icon-only). */
function pressByLabel(tree: renderer.ReactTestRenderer, label: string): void {
  const target = tree.root.findAll(n => n.props?.accessibilityLabel === label)[0];
  if (!target) throw new Error(`no pressable labelled "${label}"`);
  act(() => { target.props.onPress(); });
}

/** Press the pressable whose visible text exactly equals `label` (the link dialog's own buttons). */
function pressByText(tree: renderer.ReactTestRenderer, label: string): void {
  const target = tree.root
    .findAll(n => typeof n.props?.onPress === 'function')
    .find(n => n.findAll(() => true)
      .flatMap(x => (Array.isArray(x.children) ? x.children : []))
      .filter((c): c is string => typeof c === 'string').join('').trim() === label);
  if (!target) throw new Error(`no pressable labelled "${label}"`);
  act(() => { target.props.onPress(); });
}

/** Type into the link dialog's URL field (matched by its placeholder — it carries no test id). */
function fillLinkUrl(tree: renderer.ReactTestRenderer, url: string): void {
  const input = tree.root.findAll(n => n.props?.placeholder === 'https://…  or  stiq:…')[0];
  if (!input) throw new Error('link URL input not found — did the dialog open?');
  act(() => { input.props.onChangeText(url); });
}

function renderEditor(): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ComposerScreen
        visible
        messageMode
        onClose={jest.fn()}
        headerTitle="Comment"
        value=""
        onChangeDraft={jest.fn()}
        onSubmit={jest.fn()}
      />,
    );
  });
  return tree;
}

describe('ComposerScreen "Add a link" — scheme handling', () => {
  beforeEach(() => { rich.links.length = 0; });

  it('forwards a stiq: deep link to the editor byte-for-byte (no https:// mangling)', () => {
    const tree = renderEditor();
    pressByLabel(tree, 'Insert link');
    fillLinkUrl(tree, 'stiq://join?c=abc123');
    pressByText(tree, 'Add link');
    expect(rich.links).toEqual([{text: 'stiq://join?c=abc123', url: 'stiq://join?c=abc123'}]);
    act(() => { tree.unmount(); });
  });

  it('still normalizes a bare host to https:// (unchanged behavior for ordinary links)', () => {
    const tree = renderEditor();
    pressByLabel(tree, 'Insert link');
    fillLinkUrl(tree, 'example.com');
    pressByText(tree, 'Add link');
    expect(rich.links).toEqual([{text: 'https://example.com', url: 'https://example.com'}]);
    act(() => { tree.unmount(); });
  });

  it('passes an explicit https:// URL through unchanged', () => {
    const tree = renderEditor();
    pressByLabel(tree, 'Insert link');
    fillLinkUrl(tree, 'https://example.com/path');
    pressByText(tree, 'Add link');
    expect(rich.links).toEqual([{text: 'https://example.com/path', url: 'https://example.com/path'}]);
    act(() => { tree.unmount(); });
  });
});
