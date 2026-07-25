import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Pressable} from 'react-native';
import {ReferencedCard} from './ReferencedCard';
import {encodeSpaceEmbed} from '../../spaceEmbed';
import {safeNpubEncode, shortenNpub} from '../../../util/npub';

/**
 * Chunk 2 — ReferencedCard must recognize a `stiq:space:…` token dropped into a channel/group
 * message body and render the offline channel/space card, tappable with the FULL raw token (per
 * the tap contract), and degrade gracefully (render nothing) for a malformed token.
 */
describe('ReferencedCard — stiq:space token (chunk 2)', () => {
  it('renders a public channel card from the carried name, with no onLookup call', () => {
    const token = encodeSpaceEmbed({kind: 30311, owner: 'a'.repeat(64), identifier: 'd', name: 'General', private: false});
    const onLookup = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<ReferencedCard uri={token} onLookup={onLookup} />);
    });
    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('General');
    expect(json.toUpperCase()).toContain('CHANNEL');
    expect(onLookup).not.toHaveBeenCalled();
  });

  it('renders a private-space card with the "Request to join" hint', () => {
    const token = encodeSpaceEmbed({kind: 39000, owner: 'b'.repeat(64), identifier: 'grp1', name: 'Inner Circle', private: true});
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<ReferencedCard uri={token} />);
    });
    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('Inner Circle');
    expect(json).toContain('Request to join');
    expect(json.toUpperCase()).toContain('PRIVATE SPACE');
  });

  it('is tappable and hands onOpenRef the FULL raw token, not a decoded coordinate', () => {
    const token = encodeSpaceEmbed({kind: 30311, owner: 'c'.repeat(64), identifier: 'd2', name: 'Announcements', private: false});
    const onOpenRef = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<ReferencedCard uri={token} onOpenRef={onOpenRef} />);
    });
    const pressable = tree!.root.findByType(Pressable);
    expect(pressable.props.disabled).toBe(false);
    pressable.props.onPress();
    expect(onOpenRef).toHaveBeenCalledWith(token);
    expect(onOpenRef).not.toHaveBeenCalledWith('30311:' + 'c'.repeat(64) + ':d2');
  });

  it('is non-interactive (disabled) when no onOpenRef handler is provided', () => {
    const token = encodeSpaceEmbed({kind: 30311, owner: 'a'.repeat(64), identifier: 'd', name: 'General', private: false});
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<ReferencedCard uri={token} />);
    });
    expect(tree!.root.findByType(Pressable).props.disabled).toBe(true);
  });

  it('renders the owner npub on a space card so a spoof is distinguishable from the real space', () => {
    const owner = 'a'.repeat(64);
    const token = encodeSpaceEmbed({kind: 30311, owner, identifier: 'd', name: 'General', private: false});
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<ReferencedCard uri={token} />);
    });
    const json = JSON.stringify(tree!.toJSON());
    const expectedOwnerNpub = shortenNpub(safeNpubEncode(owner), {lead: 10, tail: 4});
    expect(json).toContain(expectedOwnerNpub);
  });

  it('renders nothing for a garbage stiq:space token instead of throwing', () => {
    const garbage = 'stiq:space:zzz-not-valid-base64url-json';
    let tree: renderer.ReactTestRenderer | undefined;
    expect(() => {
      act(() => {
        tree = renderer.create(<ReferencedCard uri={garbage} />);
      });
    }).not.toThrow();
    expect(tree!.toJSON()).toBeNull();
  });
});
