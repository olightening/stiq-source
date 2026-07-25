import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {ChatBubble} from './ChatBubble';
import {GradientAvatar} from '../../../ui/GradientAvatar';
import type {GradientSpec} from '../../../media/gradient';

// B12 routing: ChatBubble must forward the SAME two callback prop names RichText declares
// (onLookupEvent/onOpenNostrPost) into every RichText call — stub RichText so we can inspect
// exactly what it was handed, independent of RichText's own (separately-tested) rendering.
const capturedProps: Array<Record<string, unknown>> = [];
jest.mock('../../../feed/components/RichText', () => ({
  RichText: (props: Record<string, unknown>) => {
    capturedProps.push(props);
    const ReactLib = require('react');
    const {Text} = require('react-native');
    return ReactLib.createElement(Text, null, 'rich-text-stub');
  },
}));

beforeEach(() => {
  capturedProps.length = 0;
});

function render(props: React.ComponentProps<typeof ChatBubble>): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<ChatBubble {...props} />);
  });
  return tree!;
}

describe('ChatBubble → RichText embed routing (B12)', () => {
  it('forwards onLookupEvent/onOpenNostrPost into RichText for an outgoing (mine) bubble', () => {
    const onLookupEvent = jest.fn();
    const onOpenNostrPost = jest.fn();
    render({mine: true, content: 'hello nostr:nevent1xyz', onLookupEvent, onOpenNostrPost});
    expect(capturedProps).toHaveLength(1);
    expect(capturedProps[0]!.onLookupEvent).toBe(onLookupEvent);
    expect(capturedProps[0]!.onOpenNostrPost).toBe(onOpenNostrPost);
  });

  it('forwards onLookupEvent/onOpenNostrPost into RichText for an incoming (theirs) bubble', () => {
    const onLookupEvent = jest.fn();
    const onOpenNostrPost = jest.fn();
    render({mine: false, content: 'hey there', senderName: 'Bob', onLookupEvent, onOpenNostrPost});
    expect(capturedProps).toHaveLength(1);
    expect(capturedProps[0]!.onLookupEvent).toBe(onLookupEvent);
    expect(capturedProps[0]!.onOpenNostrPost).toBe(onOpenNostrPost);
  });

  it('omitting the callbacks leaves RichText with undefined (never dead-wires a stray function)', () => {
    render({mine: true, content: 'hello'});
    expect(capturedProps[0]!.onLookupEvent).toBeUndefined();
    expect(capturedProps[0]!.onOpenNostrPost).toBeUndefined();
  });
});

// GradientAvatar is React.memo'd with the default (null) comparator, so React collapses it to a
// "simple memo component" whose fiber `.type` is the INNER render function, not the outer memo()
// wrapper object — findAllByType(GradientAvatar) would never match. Compare against the inner
// function instead (same pattern as ChannelDetail.test.tsx).
const gradientAvatarInner = (GradientAvatar as unknown as {type: React.ComponentType}).type;
function findAvatars(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(n => n.type === gradientAvatarInner);
}

describe('ChatBubble → theirs-avatar identity (bug #3: DM bubble avatar must match the real gradient)', () => {
  it('renders the theirs avatar with the given senderGradient/senderSeed even when senderName is omitted', () => {
    // DMs are 1:1 and pass no senderName (no name label over every incoming message), but the
    // per-message avatar must still render the peer's REAL gradient — not fall back to a default
    // derived from an empty/undefined seed. Regression for the DM bubble avatar bug.
    const gradient: GradientSpec = {type: 'linear', angle: 90, stops: ['#abcdef', '#123456']};
    const tree = render({mine: false, content: 'hey', senderGradient: gradient, senderSeed: 'npub1peer'});
    const avatars = findAvatars(tree);
    expect(avatars).toHaveLength(1);
    expect(avatars[0]!.props.gradient).toBe(gradient);
    expect(avatars[0]!.props.seed).toBe('npub1peer');
  });

  it('does not render a default/empty-seed avatar when senderGradient/senderSeed are simply absent vs. provided', () => {
    const gradient: GradientSpec = {type: 'linear', angle: 45, stops: ['#111111', '#222222']};
    const withGradient = render({mine: false, content: 'hey', senderGradient: gradient, senderSeed: 'npub1peer'});
    const without = render({mine: false, content: 'hey'});
    const jsonWith = JSON.stringify(withGradient.toJSON()).toLowerCase();
    const jsonWithout = JSON.stringify(without.toJSON()).toLowerCase();
    expect(jsonWith).toContain('#111111');
    expect(jsonWithout).not.toContain('#111111');
  });
});
