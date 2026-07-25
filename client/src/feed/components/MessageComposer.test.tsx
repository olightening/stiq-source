/**
 * MessageComposer forwardRef (client-C: DM ConversationView chain, No.13b): the composer wraps
 * `React.forwardRef` exposing its internal `TextInput`, so a caller (e.g. ConversationView's
 * swipe-to-reply) can imperatively `.focus()` it. Existing ref-less callers (CommentComposer,
 * ChannelComposer) are unaffected since `ref` is optional.
 */
import 'react-native';
import React from 'react';
import {TextInput} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {MessageComposer} from './MessageComposer';

it('forwards a ref to the internal, focusable TextInput', () => {
  const ref = React.createRef<TextInput>();
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <MessageComposer ref={ref} value="" onChangeText={() => undefined} placeholder="Message…" onSend={() => undefined} />,
    );
  });
  expect(ref.current).not.toBeNull();
  expect(typeof ref.current?.focus).toBe('function');
  // Calling it should not throw — proves the ref is attached to a real focusable input, not a stray
  // wrapper object.
  expect(() => ref.current?.focus()).not.toThrow();
  tree!.unmount();
});

it('renders normally when no ref is passed (existing ref-less callers are unaffected)', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <MessageComposer value="" onChangeText={() => undefined} placeholder="Add a comment…" onSend={() => undefined} />,
    );
  });
  const input = tree!.root.findByProps({placeholder: 'Add a comment…'});
  expect(input).toBeDefined();
  tree!.unmount();
});

/**
 * The "Formatted draft" affordance. Done in the expanded editor syncs the body back HERE and closes
 * — the ↑ is what sends — so a table or a collapsible block lands in this compact input as raw pipes
 * and colons. The chip says what that is and offers the way back to the editor that can render it.
 *
 * It is deliberately ADDITIVE: the input keeps the real markdown and stays fully editable. Hiding
 * the body behind a chip would mean the writer can no longer see or correct what they are about to
 * send, and could not append a word without reopening a modal.
 */
describe('formatted-draft affordance', () => {
  const TABLE = 'here you go\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const render = (value: string, onExpand?: () => void): renderer.ReactTestRenderer => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <MessageComposer
          value={value}
          onChangeText={() => undefined}
          placeholder="Message…"
          onSend={() => undefined}
          onExpand={onExpand}
        />,
      );
    });
    return tree!;
  };
  const chipOf = (tree: renderer.ReactTestRenderer): renderer.ReactTestInstance | undefined =>
    tree.root.findAll(n => n.props?.accessibilityLabel === 'composer-rich-draft')[0];

  it('offers the chip for a draft carrying block markdown', () => {
    const tree = render(TABLE, () => undefined);
    expect(chipOf(tree)).toBeDefined();
    tree.unmount();
  });

  it('stays out of the way for an ordinary message', () => {
    const tree = render('see you at six', () => undefined);
    expect(chipOf(tree)).toBeUndefined();
    tree.unmount();
  });

  it('opens the editor when tapped', () => {
    const onExpand = jest.fn();
    const tree = render(TABLE, onExpand);
    act(() => { chipOf(tree)!.props.onPress(); });
    expect(onExpand).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  it('is withheld when the caller wired no editor to open', () => {
    // Nowhere to go — a chip promising an editor that does not exist would be a dead end.
    const tree = render(TABLE, undefined);
    expect(chipOf(tree)).toBeUndefined();
    tree.unmount();
  });

  it('leaves the input holding the REAL markdown, still editable', () => {
    const tree = render(TABLE, () => undefined);
    const input = tree.root.findByType(TextInput);
    expect(input.props.value).toBe(TABLE);
    expect(input.props.editable).not.toBe(false);
    tree.unmount();
  });
});
