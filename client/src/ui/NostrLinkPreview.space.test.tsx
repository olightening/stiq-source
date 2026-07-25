import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Pressable} from 'react-native';
import {NostrLinkPreview} from './NostrLinkPreview';
import {encodeSpaceEmbed} from '../channels/spaceEmbed';

/**
 * Chunk 2 — NostrLinkPreview must recognize a `stiq:space:…` token and render a channel/space card
 * FULLY OFFLINE (no onLookup needed), carrying the name+gradient straight out of the token, and must
 * hand the FULL raw token (not a decoded id/coordinate) to onOpen per the tap contract.
 */
describe('NostrLinkPreview — stiq:space token (chunk 2)', () => {
  it('renders a public channel card from the carried name, with no onLookup call', () => {
    const token = encodeSpaceEmbed({kind: 30311, owner: 'a'.repeat(64), identifier: 'd', name: 'General', private: false});
    const onLookup = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<NostrLinkPreview uri={token} onLookup={onLookup} />);
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
      tree = renderer.create(<NostrLinkPreview uri={token} />);
    });
    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('Inner Circle');
    expect(json).toContain('Request to join');
    expect(json.toUpperCase()).toContain('PRIVATE SPACE');
  });

  it('taps call onOpen with the FULL raw token, not a decoded coordinate', () => {
    const token = encodeSpaceEmbed({kind: 30311, owner: 'c'.repeat(64), identifier: 'd2', name: 'Announcements', private: false});
    const onOpen = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<NostrLinkPreview uri={token} onOpen={onOpen} />);
    });
    tree!.root.findByType(Pressable).props.onPress();
    expect(onOpen).toHaveBeenCalledWith(token);
    expect(onOpen).not.toHaveBeenCalledWith('30311:' + 'c'.repeat(64) + ':d2');
  });

  it('renders nothing for a garbage stiq:space token instead of throwing', () => {
    const garbage = 'stiq:space:zzz-not-valid-base64url-json';
    expect(() => {
      act(() => {
        renderer.create(<NostrLinkPreview uri={garbage} />);
      });
    }).not.toThrow();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<NostrLinkPreview uri={garbage} />);
    });
    expect(tree!.toJSON()).toBeNull();
  });
});
