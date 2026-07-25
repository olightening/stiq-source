import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Pressable} from 'react-native';
import {MessageBody} from './MessageBody';
import {encodeSpaceEmbed} from '../../spaceEmbed';

/**
 * Chunk 2 — MessageBody (channel/group message bodies) must extract a `stiq:space:…` token
 * alongside nostr: refs/http links and route it to ReferencedCard, which renders the offline
 * channel/space card and taps through with the FULL raw token.
 */
describe('MessageBody — stiq:space token extraction (chunk 2)', () => {
  const token = encodeSpaceEmbed({kind: 30311, owner: 'a'.repeat(64), identifier: 'd', name: 'General', private: false});

  it('extracts a stiq:space token from a mixed body and renders the carried name as a card', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<MessageBody content={`check this out ${token} thanks`} />);
    });
    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('check this out');
    expect(json).toContain('thanks');
    expect(json).toContain('General');
    expect(json).not.toContain('stiq:space:');
  });

  it('taps through to onOpenRef with the FULL raw token', () => {
    const onOpenRef = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<MessageBody content={`join here ${token}`} onOpenRef={onOpenRef} />);
    });
    tree!.root.findByType(Pressable).props.onPress();
    expect(onOpenRef).toHaveBeenCalledWith(token);
  });

  it('still handles an ordinary nostr: ref alongside plain text (existing behavior preserved)', () => {
    const nevent = 'nostr:nevent1qqstna2yrezu5wghjvswqqculvvwxsrcvu7uc0f78gan4xqhvz49d9spr3mhxue69uhkummnw3ezuamfdejsyg8s7cpm4dyv';
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<MessageBody content={`look ${nevent} at this`} />);
    });
    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('look');
    expect(json).toContain('at this');
  });

  it('renders no card (graceful) for a garbage stiq:space token, keeping surrounding text', () => {
    const garbage = 'stiq:space:zzz-not-valid-base64url-json';
    let tree: renderer.ReactTestRenderer | undefined;
    expect(() => {
      act(() => {
        tree = renderer.create(<MessageBody content={`before ${garbage} after`} />);
      });
    }).not.toThrow();
    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('before');
    expect(json).toContain('after');
    expect(json).not.toContain('stiq:space:');
  });
});

/**
 * A message body is RICH now — the same markdown dialect the feed uses. MessageBody lifts machine
 * tokens and pasted links out of the text before handing the rest to RichText, and that lifting used
 * to be indiscriminate (`https?://[^\s]+` anywhere in the body). Against rich text that was
 * destructive: it ate the closing paren of a markdown link and punched holes in table rows.
 *
 * The rule these pin: a URL is lifted ONLY when it stands alone on its own line. Anywhere else it
 * stays in the prose for RichText to render inline.
 */
describe('MessageBody — link lifting must not mangle rich text', () => {
  const render = (content: string): string => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => { tree = renderer.create(<MessageBody content={content} />); });
    return JSON.stringify(tree!.toJSON());
  };

  it('leaves a markdown link intact instead of eating its closing paren', () => {
    const json = render('read the [Docs](https://example.com) first');
    // The bug: `https://example.com)` was lifted out, stranding a literal "[Docs](" in the message.
    expect(json).not.toContain('[Docs](');
    expect(json).toContain('Docs');
    expect(json).toContain('read the');
    expect(json).toContain('first');
  });

  it('keeps a table row whole when a cell contains a URL', () => {
    const json = render(['| site | url |', '|---|---|', '| Example | https://example.com |'].join('\n'));
    // Both header cells and BOTH body cells must survive — lifting the URL used to leave "| Example |  |".
    expect(json).toContain('site');
    expect(json).toContain('url');
    expect(json).toContain('Example');
    expect(json).toContain('example.com');
  });

  it('keeps a URL inside a list item in the list', () => {
    const json = render(['- first', '- see https://example.com now', '- last'].join('\n'));
    expect(json).toContain('see');
    expect(json).toContain('now');
    expect(json).toContain('last');
  });

  it('still lifts a link that stands alone on its own line', () => {
    // The case the LinkChip card exists for: someone pasted a link. LinkChip renders the domain.
    const json = render(['look at this', 'https://example.com', 'neat'].join('\n'));
    expect(json).toContain('look at this');
    expect(json).toContain('neat');
    expect(json).toContain('example.com');
  });

  it('routes a standalone stiq://channel invite to the invite card, not the link chip', () => {
    const onOpenInviteLink = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <MessageBody content={'join us\nstiq://channel/abc123'} onOpenInviteLink={onOpenInviteLink} />,
      );
    });
    // The invite alternative precedes the http one, so it never falls into the external-link chip.
    tree!.root.findByType(Pressable).props.onPress();
    expect(onOpenInviteLink).toHaveBeenCalledWith('stiq://channel/abc123');
  });
});
