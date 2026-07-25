/**
 * CommentComposer's "Expand to editor" embed picker — a saved SPACE (channel/private group) must
 * show up in ComposerScreen's (message-mode) "SAVED · TAP TO EMBED" picker as a channel-card row
 * (label + name, no post snippet) and insert its `stiq:space:…` token verbatim, mirroring channels/
 * groups/DMs.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@react-native-clipboard/clipboard', () => ({setString: jest.fn(), getString: jest.fn(() => Promise.resolve(''))}), {virtual: true});
jest.mock('react-native-webview', () => ({WebView: () => null}), {virtual: true});

const rich: {inserted: string[]} = {inserted: []};
jest.mock('./RichEditor', () => {
  const React = require('react');
  return {
    RichEditor: React.forwardRef((_props: {onChange: (md: string) => void; value: string}, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({
        cmd() {}, paste() {}, focus() {}, insertLink() {},
        insertToken(t: string) { rich.inserted.push(t); },
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
import {CommentComposer} from './CommentComposer';
import {saveChannelEmbed, removeEmbed} from '../../channels/savedEmbeds';

/** Walk UP from a matching title Text node to the nearest onPress ancestor (the sheet's backdrop
 *  Pressable also wraps every row's title text and would otherwise match first). */
function pressSavedRow(tree: renderer.ReactTestRenderer, title: string): void {
  const textNode = tree.root.findAll(n => (n.type as unknown) === 'Text' && n.props.children === title)[0];
  if (!textNode) throw new Error(`no saved row titled "${title}"`);
  let node: typeof textNode | null = textNode.parent;
  while (node && typeof node.props?.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`no pressable ancestor for "${title}"`);
  act(() => { node!.props.onPress(); });
}

describe('CommentComposer "Expand to editor" saved-embed picker', () => {
  const owner = 'a'.repeat(64);

  afterEach(async () => {
    await removeEmbed(`30311:${owner}:general`);
  });

  it('renders a saved CHANNEL as a channel-card row and inserts the stiq:space token verbatim', async () => {
    await saveChannelEmbed({id: `30311:${owner}:general`, owner, name: 'General Chat'}, 1);
    rich.inserted.length = 0;

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(<CommentComposer onSubmit={jest.fn()} />);
    });

    // `+` → "Expand to editor" opens ComposerScreen (message-mode) with savedEmbedTokens wired in.
    act(() => { tree!.root.findAll(n => n.props.accessibilityLabel === 'composer-add')[0]!.props.onPress(); });
    act(() => { tree!.root.findAll(n => n.props.accessibilityLabel === 'composer-add-Expand to editor')[0]!.props.onPress(); });
    act(() => { tree!.root.findAll(n => n.props.accessibilityLabel === 'Embed a saved post')[0]!.props.onPress(); });

    const text = JSON.stringify(tree!.toJSON());
    expect(text).toContain('CHANNEL');
    expect(text).toContain('General Chat');

    pressSavedRow(tree!, 'General Chat');
    expect(rich.inserted).toEqual([expect.stringMatching(/^stiq:space:/)]);
  });
});
