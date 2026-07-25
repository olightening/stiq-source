import {getPublicKey, generateSecretKey} from 'nostr-tools/pure';
import {buildConversations} from './conversations';
import type {DirectMessage} from './dm';

const alice = getPublicKey(generateSecretKey());
const bob = getPublicKey(generateSecretKey());

function msg(id: string, sender: string, text: string, createdAt: number): DirectMessage {
  return {id, rumorId: `r${id}`, sender, text, createdAt};
}

describe('buildConversations', () => {
  it('groups messages by peer, newest conversation first', () => {
    const conversations = buildConversations([
      msg('1', alice, 'hi', 10),
      msg('2', bob, 'yo', 50),
      msg('3', alice, 'again', 30),
    ]);

    expect(conversations.map(c => c.peer)).toEqual([bob, alice]); // bob more recent
    const aliceConvo = conversations.find(c => c.peer === alice)!;
    expect(aliceConvo.messages.map(m => m.text)).toEqual(['hi', 'again']); // oldest first
    expect(aliceConvo.preview).toBe('again');
    expect(aliceConvo.peerNpub).toMatch(/^npub1/);
  });

  it('returns nothing for an empty inbox', () => {
    expect(buildConversations([])).toEqual([]);
  });

  it('drops conversations for peers the isHidden predicate flags (effective block)', () => {
    const conversations = buildConversations(
      [msg('1', alice, 'hi', 10), msg('2', bob, 'yo', 50)],
      peer => peer === bob, // e.g. AppRuntime.effectiveDmBlocked said bob is blocked
    );
    expect(conversations.map(c => c.peer)).toEqual([alice]);
  });
});
