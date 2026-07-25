import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {getPublicKey, generateSecretKey} from 'nostr-tools/pure';
import {InboxList} from './InboxList';
import {buildConversations} from '../conversations';

it('renders conversations with previews', () => {
  const peer = getPublicKey(generateSecretKey());
  const conversations = buildConversations([
    {id: '1', rumorId: 'r1', sender: peer, text: 'hello there', createdAt: 1},
  ]);

  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<InboxList conversations={conversations} onOpen={() => undefined} />);
  });
  expect(JSON.stringify(tree!.toJSON())).toContain('hello there');
});
