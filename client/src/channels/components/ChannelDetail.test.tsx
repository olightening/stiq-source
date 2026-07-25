import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import * as nip19 from 'nostr-tools/nip19';
import {ChannelDetail} from './ChannelDetail';
import {GradientAvatar} from '../../ui/GradientAvatar';
import type {Channel} from '../channels';

// B9: gradient seeds must be npub-encoded everywhere (the same convention feed/profile/DM/channel
// posts use) — a raw hex pubkey seed hashes to a DIFFERENT gradient than the npub form, so the same
// user rendered different colours depending on which screen you're looking at.
const OWNER = 'a'.repeat(64);
const ADMIN = 'b'.repeat(64);
const MEMBER = 'c'.repeat(64);

function render(el: React.ReactElement): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(el);
  });
  return tree!;
}

// GradientAvatar is React.memo'd with the default (null) comparator, so React collapses it to a
// "simple memo component" whose fiber `.type` is the INNER render function, not the outer memo()
// wrapper object — findAllByType(GradientAvatar) would never match. Compare against the inner
// function instead.
const gradientAvatarInner = (GradientAvatar as unknown as {type: React.ComponentType}).type;
function avatarSeeds(tree: renderer.ReactTestRenderer): unknown[] {
  return tree.root.findAll(n => n.type === gradientAvatarInner).map(n => n.props.seed);
}

describe('ChannelDetail gradient seeds (B9)', () => {
  it('npub-encodes the owner and admin avatar seeds (admin roster)', () => {
    // The admin roster comes off `channel.admins` (seeded into the component's own state).
    const channel = {id: 'c1', owner: OWNER, name: 'Dispatch', admins: [ADMIN]} as Channel;
    const tree = render(
      <ChannelDetail channel={channel} isOwner onSaveChannel={jest.fn()} channelType="public" />,
    );
    const seeds = avatarSeeds(tree);
    expect(seeds).toContain(nip19.npubEncode(OWNER));
    expect(seeds).toContain(nip19.npubEncode(ADMIN));
    // Never the raw hex — that was the bug (different gradient than every other npub-seeded avatar).
    expect(seeds).not.toContain(OWNER);
    expect(seeds).not.toContain(ADMIN);
  });

  it('npub-encodes each member avatar seed (group roster)', () => {
    const channel = {id: 'c2', owner: OWNER, name: 'Builders'} as Channel;
    const tree = render(
      <ChannelDetail
        channel={channel}
        channelType="group"
        members={[{pubkey: MEMBER, name: 'Carol'}]}
      />,
    );
    const seeds = avatarSeeds(tree);
    expect(seeds).toContain(nip19.npubEncode(MEMBER));
    expect(seeds).not.toContain(MEMBER);
  });
});

describe('ChannelDetail save-to-embed row', () => {
  const channel = {id: 'c3', owner: OWNER, name: 'Dispatch'} as Channel;

  it('renders the "Save channel to embed" button when onSaveToEmbed is provided and calls it on press', () => {
    const onSaveToEmbed = jest.fn();
    const tree = render(<ChannelDetail channel={channel} onSaveToEmbed={onSaveToEmbed} />);
    const button = tree.root.findByProps({accessibilityLabel: 'save channel to embed'});
    const texts = button.findAllByType(Text).map(n => n.props.children);
    expect(texts).toContain('Save channel to embed');
    act(() => {
      button.props.onPress();
    });
    expect(onSaveToEmbed).toHaveBeenCalledTimes(1);
  });

  it('hides the row when onSaveToEmbed is absent', () => {
    const tree = render(<ChannelDetail channel={channel} />);
    expect(() => tree.root.findByProps({accessibilityLabel: 'save channel to embed'})).toThrow();
  });

  it('no longer renders the old invite-link card', () => {
    const tree = render(<ChannelDetail channel={channel} onSaveToEmbed={jest.fn()} />);
    const allText = tree.root
      .findAllByType(Text)
      .map(n => (typeof n.props.children === 'string' ? n.props.children : ''));
    expect(allText.some(t => t.includes('INVITE LINK'))).toBe(false);
    expect(allText.some(t => t.includes('Share ↗'))).toBe(false);
  });
});
