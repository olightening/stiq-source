import {createPoWSigner} from './pow';
import {getEventHash, type Event} from 'nostr-tools/pure';
import {countLeadingZeroBits} from '../dm/nip13';
import type {SecureKeyStore, UnsignedEvent} from '../keys/keystore';

describe('createPoWSigner', () => {
  const dummyPubkey = 'a'.repeat(64);
  const unsigned: UnsignedEvent = {
    kind: 1,
    created_at: 1234567890,
    tags: [],
    content: 'hello proxy',
  };

  const mockKeystore: SecureKeyStore = {
    enroll: jest.fn(),
    isEnrolled: jest.fn(),
    reset: jest.fn(),
    useSecretKey: jest.fn(),
    publicKey: jest.fn().mockResolvedValue(dummyPubkey),
    sign: jest.fn().mockImplementation(async (u: UnsignedEvent) => {
      // Mock signing: just return an Event shape with a dummy signature
      return {
        ...u,
        pubkey: dummyPubkey,
        id: getEventHash({ ...u, pubkey: dummyPubkey }),
        sig: 'sig',
      } as Event;
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('bypasses mining if difficulty is 0', async () => {
    const signer = createPoWSigner(mockKeystore, 0);
    const event = await signer.sign(unsigned);
    expect(mockKeystore.publicKey).not.toHaveBeenCalled();
    expect(event.tags.find(t => t[0] === 'nonce')).toBeUndefined();
  });

  it('mines NIP-13 PoW before signing if difficulty > 0', async () => {
    // We use a small difficulty so tests don't hang
    const difficulty = 8; 
    const signer = createPoWSigner(mockKeystore, difficulty);
    const event = await signer.sign(unsigned);
    
    expect(mockKeystore.publicKey).toHaveBeenCalled();
    const nonceTag = event.tags.find(t => t[0] === 'nonce');
    expect(nonceTag).toBeDefined();
    expect(nonceTag![2]).toBe(difficulty.toString());
    
    // Verify the PoW
    const hash = getEventHash({
      pubkey: dummyPubkey,
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags,
      content: event.content,
    });
    expect(countLeadingZeroBits(hash)).toBeGreaterThanOrEqual(difficulty);
  });
});
