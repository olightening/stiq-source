/**
 * TokenPool (T4.2) — replaces mediaWallets.test.ts + readWallet.test.ts (the SpaceWallet-equivalent
 * coverage, previously only exercised indirectly via app/spaceWrites.durable.test.ts, is folded in
 * here too). Proves the pool's SIX auxiliary purposes (read, the four media write/read domains, and
 * space-write) each behave exactly like the posting {@link EpochWallet} — draw/spend FIFO, persist,
 * per-slot silo, issuer-key self-heal — while never colliding with each other, the posting wallet, or
 * across namespaces. The underlying EpochWallet is untouched by T4.2 (this suite is a consumer test,
 * not a wallet.test.ts change) — every guarantee here already held before the pool existed; what's new
 * is that ONE class constructs/holds/wipes all six instead of three separate shim files.
 */
import {EpochWallet, walletKeyFingerprint, type Token, type MintToken} from './wallet';
import {
  TokenPool,
  POOL_PURPOSES,
  POOL_WALLET_ITEMS,
  MEDIA_PURPOSES,
  makePoolWallet,
  tokenPoolStorageKeys,
  type PoolPurpose,
} from './tokenPool';
import {Purpose} from '../contracts';
import type {SecureStorage} from '../keys/keystore';

class InMemoryStorage implements SecureStorage {
  m = new Map<string, string>();
  async setItem(k: string, v: string): Promise<void> {
    this.m.set(k, v);
  }
  async getItem(k: string): Promise<string | null> {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  async removeItem(k: string): Promise<void> {
    this.m.delete(k);
  }
}

function countingMint(): MintToken {
  let n = 0;
  return async (): Promise<Token> => {
    const i = n++;
    return {token: Uint8Array.of(i), sig: Uint8Array.of(255 - i), secret: Uint8Array.of(i, 1)};
  };
}

describe('TokenPool', () => {
  it('constructs one EpochWallet per pooled purpose', () => {
    const pool = new TokenPool(new InMemoryStorage(), 'slot');
    for (const purpose of POOL_PURPOSES) {
      expect(pool.get(purpose)).toBeInstanceOf(EpochWallet);
    }
  });

  it('returns the SAME wallet instance on repeated get() calls (stable, not re-constructed)', () => {
    const pool = new TokenPool(new InMemoryStorage(), 'slot');
    expect(pool.get(Purpose.SpaceWrite)).toBe(pool.get(Purpose.SpaceWrite));
    expect(pool.get(Purpose.Read)).toBe(pool.get(Purpose.Read));
  });

  it('keeps each of the six budgets independent (no cross-domain bleed)', async () => {
    const pool = new TokenPool(new InMemoryStorage(), 'slot');
    const draw: Record<PoolPurpose, number> = {
      [Purpose.Read]: 4,
      [Purpose.PictureWrite]: 5,
      [Purpose.PictureRead]: 3,
      [Purpose.AudioWrite]: 2,
      [Purpose.AudioRead]: 1,
      [Purpose.SpaceWrite]: 6,
    };
    for (const purpose of POOL_PURPOSES) {
      await pool.get(purpose).draw(1, draw[purpose], countingMint());
    }
    for (const purpose of POOL_PURPOSES) {
      expect(await pool.get(purpose).count()).toBe(draw[purpose]);
    }
  });

  it('setKeyFingerprint(purpose, fp) binds only that purpose, leaving siblings unbound', async () => {
    const storage = new InMemoryStorage();
    const pool = new TokenPool(storage, 'c');
    const FP = walletKeyFingerprint('K_space');
    await pool.get(Purpose.SpaceWrite).draw(1, 3, countingMint());
    await pool.get(Purpose.Read).draw(1, 3, countingMint());
    pool.setKeyFingerprint(Purpose.SpaceWrite, FP);
    // Binding a fresh (previously-unbound) fingerprint on an already-hydrated wallet reconciles
    // immediately (EpochWallet.setKeyFingerprint) — an unstamped batch is legacy/unknown provenance,
    // so it is discarded exactly like a rotation mismatch (see wallet.ts reconcileKey).
    expect(await pool.get(Purpose.SpaceWrite).count()).toBe(0);
    // The sibling Read wallet was never bound, so its batch is untouched.
    expect(await pool.get(Purpose.Read).count()).toBe(3);
  });

  it('clearAll() wipes every pooled wallet', async () => {
    const pool = new TokenPool(new InMemoryStorage(), 'slot');
    for (const purpose of POOL_PURPOSES) {
      await pool.get(purpose).draw(1, 2, countingMint());
    }
    await pool.clearAll();
    for (const purpose of POOL_PURPOSES) {
      expect(await pool.get(purpose).count()).toBe(0);
    }
  });

  it('throws a clear error for an invalid purpose (defensive — should never happen from typed code)', () => {
    const pool = new TokenPool(new InMemoryStorage(), 'slot');
    expect(() => pool.get('bogus-purpose' as PoolPurpose)).toThrow();
  });
});

describe('pooled wallets (makePoolWallet) — each behaves exactly like the posting EpochWallet', () => {
  for (const purpose of POOL_PURPOSES) {
    describe(`purpose "${purpose}"`, () => {
      it('draws, spends FIFO, and reports count + epoch like the posting wallet', async () => {
        const w = makePoolWallet(purpose, new InMemoryStorage());
        expect(await w.count()).toBe(0);
        expect(await w.lastEpoch()).toBe(-1);

        await w.draw(4, 3, countingMint());
        expect(await w.count()).toBe(3);
        expect(await w.lastEpoch()).toBe(4);

        const a = await w.spend();
        const b = await w.spend();
        expect(a!.token[0]).toBe(0); // oldest first
        expect(b!.token[0]).toBe(1);
        expect(await w.count()).toBe(1);
      });

      it('deposits a pre-drawn batch (the Tor draw) and spends it', async () => {
        const w = makePoolWallet(purpose, new InMemoryStorage());
        const batch: Token[] = [
          {token: Uint8Array.of(10), sig: Uint8Array.of(20), secret: Uint8Array.of(30)},
          {token: Uint8Array.of(11), sig: Uint8Array.of(21), secret: Uint8Array.of(31)},
        ];
        expect(await w.add(5, batch)).toBe(2);
        expect((await w.spend())!.token[0]).toBe(10);
        expect(await w.count()).toBe(1);
      });

      it('persists across instances (survives app restart)', async () => {
        const storage = new InMemoryStorage();
        await makePoolWallet(purpose, storage).draw(2, 4, countingMint());
        const reopened = makePoolWallet(purpose, storage);
        expect(await reopened.count()).toBe(4);
        expect(await reopened.lastEpoch()).toBe(2);
      });

      it('siloes tokens by namespace (per-account budget)', async () => {
        const storage = new InMemoryStorage();
        const a = makePoolWallet(purpose, storage, 'accountA');
        const b = makePoolWallet(purpose, storage, 'accountB');
        await a.draw(1, 3, countingMint());
        expect(await a.count()).toBe(3);
        expect(await b.count()).toBe(0); // B's namespace untouched
      });

      it('self-heals on an issuer-key rotation / domain-sep cutover (discards the stale batch)', async () => {
        const storage = new InMemoryStorage();
        const FP_OLD = walletKeyFingerprint(`K_${purpose}_old`);
        const FP_NEW = walletKeyFingerprint(`K_${purpose}_new`);

        await makePoolWallet(purpose, storage, 'c', FP_OLD).draw(1, 3, countingMint());
        expect(await makePoolWallet(purpose, storage, 'c', FP_OLD).count()).toBe(3);

        // A wallet bound to the rotated key sees the old batch as unspendable → discards it, then the
        // next draw refills under the new key with no re-enroll.
        const rotated = makePoolWallet(purpose, storage, 'c', FP_NEW);
        expect(await rotated.count()).toBe(0);
        await rotated.draw(2, 2, countingMint());
        expect(await makePoolWallet(purpose, storage, 'c', FP_NEW).count()).toBe(2);
      });
    });
  }
});

describe('storage isolation', () => {
  it('does NOT collide with the posting wallet or any sibling pooled purpose in the same store', async () => {
    const storage = new InMemoryStorage();
    const post = new EpochWallet(storage, 'slot');
    const pool = new TokenPool(storage, 'slot');
    await post.draw(1, 7, countingMint());
    const draw: Record<PoolPurpose, number> = {
      [Purpose.Read]: 4,
      [Purpose.PictureWrite]: 2,
      [Purpose.PictureRead]: 0,
      [Purpose.AudioWrite]: 0,
      [Purpose.AudioRead]: 0,
      [Purpose.SpaceWrite]: 6,
    };
    for (const purpose of POOL_PURPOSES) {
      if (draw[purpose] > 0) await pool.get(purpose).draw(1, draw[purpose], countingMint());
    }
    expect(await post.count()).toBe(7);
    for (const purpose of POOL_PURPOSES) {
      expect(await pool.get(purpose).count()).toBe(draw[purpose]);
    }
  });

  it('persists each pooled purpose under a distinct, correctly-namespaced storage base', async () => {
    const storage = new InMemoryStorage();
    const pool = new TokenPool(storage, 'slot');
    await pool.get(Purpose.AudioRead).draw(1, 1, countingMint());
    // audio-read tokens land under their own base+namespace key, nothing else.
    const audReadKey = `${POOL_WALLET_ITEMS[Purpose.AudioRead].tokens}.slot`;
    expect(await storage.getItem(audReadKey)).not.toBeNull();
    expect(await storage.getItem(`${POOL_WALLET_ITEMS[Purpose.PictureWrite].tokens}.slot`)).toBeNull();
    // The exported wipe keys cover all six pools' three items each (18 keys), all namespaced.
    const keys = tokenPoolStorageKeys('slot');
    expect(keys).toHaveLength(POOL_PURPOSES.length);
    for (const k of keys) {
      expect(k.tokens.endsWith('.slot')).toBe(true);
      expect(k.epoch.endsWith('.slot')).toBe(true);
      expect(k.keyfp.endsWith('.slot')).toBe(true);
    }
  });

  it('pins the exact pre-T4.2 storage-key strings (byte-identical — no migration for existing wallets)', () => {
    // These literal strings are the wire/storage contract: an already-deployed wallet must be found
    // under the SAME keys after this refactor. Do not "clean up" these strings without a migration.
    expect(POOL_WALLET_ITEMS[Purpose.Read].tokens).toBe('stiq.readwallet.tokens');
    expect(POOL_WALLET_ITEMS[Purpose.Read].epoch).toBe('stiq.readwallet.epoch');
    expect(POOL_WALLET_ITEMS[Purpose.Read].keyfp).toBe('stiq.readwallet.keyfp');
    expect(POOL_WALLET_ITEMS[Purpose.SpaceWrite].tokens).toBe('stiq.spacewallet.tokens');
    expect(POOL_WALLET_ITEMS[Purpose.PictureWrite].tokens).toBe('stiq.picwritewallet.tokens');
    expect(POOL_WALLET_ITEMS[Purpose.PictureRead].tokens).toBe('stiq.picreadwallet.tokens');
    expect(POOL_WALLET_ITEMS[Purpose.AudioWrite].tokens).toBe('stiq.audwritewallet.tokens');
    expect(POOL_WALLET_ITEMS[Purpose.AudioRead].tokens).toBe('stiq.audreadwallet.tokens');
    // And none of them ever equal the posting wallet's own (unsuffixed) base.
    for (const purpose of POOL_PURPOSES) {
      expect(POOL_WALLET_ITEMS[purpose].tokens).not.toBe('stiq.wallet.tokens');
    }
  });

  it('MEDIA_PURPOSES stays the exact four-domain subset (drawExchange.DrawPurpose depends on this)', () => {
    expect([...MEDIA_PURPOSES].sort()).toEqual(
      [Purpose.PictureWrite, Purpose.PictureRead, Purpose.AudioWrite, Purpose.AudioRead].sort(),
    );
  });
});
