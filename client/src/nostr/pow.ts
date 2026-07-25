import type {Event} from 'nostr-tools/pure';
import type {UnsignedEvent, SecureKeyStore} from '../keys/keystore';
import {mineEventPow} from '../dm/nip13';

/** A subset of SecureKeyStore needed for signing. */
export interface Signer {
  sign(unsigned: UnsignedEvent): Promise<Event>;
}

/**
 * Wraps a SecureKeyStore to transparently mine a NIP-13 PoW before signing.
 * Used when the client connects via the blind proxy, so all events satisfy
 * the relay's spam-prevention checks.
 */
export function createPoWSigner(keystore: SecureKeyStore, targetDifficulty: number): Signer {
  return {
    async sign(unsigned: UnsignedEvent): Promise<Event> {
      if (targetDifficulty <= 0) {
        return keystore.sign(unsigned);
      }
      
      const pubkey = await keystore.publicKey();
      
      const minable = {
        pubkey,
        kind: unsigned.kind,
        created_at: unsigned.created_at,
        tags: unsigned.tags,
        content: unsigned.content,
      };

      const mined = await mineEventPow(minable, targetDifficulty);
      
      // Pass the mined tags back to the keystore for actual signing
      return keystore.sign({
        kind: mined.kind,
        created_at: mined.created_at,
        tags: mined.tags,
        content: mined.content,
      });
    }
  };
}
