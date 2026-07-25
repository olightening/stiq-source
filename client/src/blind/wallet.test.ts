import {EpochWallet, walletKeyFingerprint, type Token, type MintToken} from './wallet';
import type {SecureStorage} from '../keys/keystore';
import {bytesToBase64, base64ToBytes} from '../util/base64';

// The raw storage keys the wallet persists under (default namespace). Tests read these directly to
// assert the *persisted* state, and to plant legacy data in the exact on-disk format.
const WALLET_KEY = 'stiq.wallet.tokens';
const EPOCH_KEY = 'stiq.wallet.epoch';

class InMemoryStorage implements SecureStorage {
  private m = new Map<string, string>();
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

/**
 * A storage whose reads/writes each resolve on a later macrotask, forcing overlapping operations to
 * truly interleave. Under a naive load→mutate→save wallet this lets two concurrent calls both read
 * the same snapshot before either writes, so the second save clobbers the first (the lost update the
 * refactor fixes). The in-memory-first wallet must survive it with both mutations landing.
 */
class SlowStorage implements SecureStorage {
  private m = new Map<string, string>();
  private tick(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  async setItem(k: string, v: string): Promise<void> {
    await this.tick();
    this.m.set(k, v);
  }
  async getItem(k: string): Promise<string | null> {
    await this.tick();
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  async removeItem(k: string): Promise<void> {
    await this.tick();
    this.m.delete(k);
  }
}

/** A deterministic mint: token bytes encode a counter so we can assert FIFO ordering. */
function countingMint(): MintToken {
  let n = 0;
  return async (): Promise<Token> => {
    const i = n++;
    return {token: Uint8Array.of(i), sig: Uint8Array.of(255 - i), secret: Uint8Array.of(i, 1)};
  };
}

describe('EpochWallet', () => {
  it('draws N tokens, reports count + epoch', async () => {
    const w = new EpochWallet(new InMemoryStorage());
    expect(await w.count()).toBe(0);
    expect(await w.lastEpoch()).toBe(-1);

    const total = await w.draw(7, 5, countingMint());
    expect(total).toBe(5);
    expect(await w.count()).toBe(5);
    expect(await w.lastEpoch()).toBe(7);
  });

  it('spends FIFO and depletes', async () => {
    const w = new EpochWallet(new InMemoryStorage());
    await w.draw(1, 3, countingMint());

    const a = await w.spend();
    const b = await w.spend();
    expect(a!.token[0]).toBe(0); // oldest first
    expect(b!.token[0]).toBe(1);
    expect(await w.count()).toBe(1);

    await w.spend();
    expect(await w.count()).toBe(0);
    expect(await w.spend()).toBeNull();
  });

  it('spendMany takes N tokens FIFO, all-or-nothing', async () => {
    const w = new EpochWallet(new InMemoryStorage());
    await w.draw(1, 5, countingMint());

    const three = await w.spendMany(3);
    expect(three).toHaveLength(3);
    expect(three!.map(t => t.token[0])).toEqual([0, 1, 2]); // oldest three, in order
    expect(await w.count()).toBe(2);

    // Asking for more than held spends NONE (all-or-nothing, mirrors the relay's SpendAll).
    expect(await w.spendMany(3)).toBeNull();
    expect(await w.count()).toBe(2); // unchanged

    expect(await w.spendMany(0)).toEqual([]); // zero is a no-op
    expect(await w.count()).toBe(2);
  });

  it('persists across instances (survives app restart)', async () => {
    const storage = new InMemoryStorage();
    await new EpochWallet(storage).draw(2, 4, countingMint());
    const reopened = new EpochWallet(storage);
    expect(await reopened.count()).toBe(4);
    expect(await reopened.lastEpoch()).toBe(2);
  });

  it('keeps partially-drawn tokens if the issuer fails mid-batch', async () => {
    const w = new EpochWallet(new InMemoryStorage());
    let n = 0;
    const flakyMint: MintToken = async () => {
      if (n === 2) throw new Error('issuer offline');
      const i = n++;
      return {token: Uint8Array.of(i), sig: Uint8Array.of(i), secret: Uint8Array.of(i, 2)};
    };
    await expect(w.draw(9, 5, flakyMint)).rejects.toThrow('issuer offline');
    expect(await w.count()).toBe(2); // the two that succeeded are kept
  });

  it('isolates wallets by namespace', async () => {
    const storage = new InMemoryStorage();
    const a = new EpochWallet(storage, 'communityA');
    const b = new EpochWallet(storage, 'communityB');
    await a.draw(1, 3, countingMint());
    expect(await a.count()).toBe(3);
    expect(await b.count()).toBe(0);
  });

  it('deposits a pre-drawn batch (the Tor draw path) and spends it', async () => {
    const w = new EpochWallet(new InMemoryStorage());
    const batch: Token[] = [
      {token: Uint8Array.of(10), sig: Uint8Array.of(20), secret: Uint8Array.of(30)},
      {token: Uint8Array.of(11), sig: Uint8Array.of(21), secret: Uint8Array.of(31)},
    ];
    const total = await w.add(5, batch);
    expect(total).toBe(2);
    expect(await w.lastEpoch()).toBe(5);
    const first = await w.spend();
    expect(first!.token[0]).toBe(10);
    expect(await w.count()).toBe(1);
  });

  // F10 (durable draw staging): the marker-recovery path may call add() twice with the identical
  // finalized batch if a kill lands between a prior add() and its marker being cleared (the resumed
  // draw re-fetches + re-finalizes the SAME organizer response deterministically). add() must not
  // double-credit the wallet in that case.
  it('add() is idempotent: re-adding an already-held batch does not double-credit', async () => {
    const w = new EpochWallet(new InMemoryStorage());
    const batch: Token[] = [
      {token: Uint8Array.of(50), sig: Uint8Array.of(60), secret: Uint8Array.of(70)},
      {token: Uint8Array.of(51), sig: Uint8Array.of(61), secret: Uint8Array.of(71)},
    ];
    await w.add(9, batch);
    expect(await w.count()).toBe(2);

    // Replay the identical batch (same token bytes) a second time.
    const total = await w.add(9, batch);
    expect(total).toBe(2);
    expect(await w.count()).toBe(2);

    // A genuinely NEW batch (distinct token bytes) still deposits normally alongside the deduped one.
    const more: Token[] = [{token: Uint8Array.of(52), sig: Uint8Array.of(62), secret: Uint8Array.of(72)}];
    await w.add(9, more);
    expect(await w.count()).toBe(3);
  });

  it('add() dedup is checked against the PERSISTED snapshot too, not just the in-memory batch', async () => {
    const storage = new InMemoryStorage();
    const w1 = new EpochWallet(storage);
    const batch: Token[] = [{token: Uint8Array.of(80), sig: Uint8Array.of(90), secret: Uint8Array.of(100)}];
    await w1.add(3, batch);

    // A second, independent EpochWallet instance bound to the SAME storage (mirrors how the wallet
    // is reconstructed on a fresh AppRuntime instance after a restart) must still recognise the token
    // as already held once it hydrates from the shared storage.
    const w2 = new EpochWallet(storage);
    const total = await w2.add(3, batch);
    expect(total).toBe(1);
    expect(await w2.count()).toBe(1);
  });

  it('clears on reset', async () => {
    const w = new EpochWallet(new InMemoryStorage());
    await w.draw(1, 3, countingMint());
    await w.clear();
    expect(await w.count()).toBe(0);
    expect(await w.lastEpoch()).toBe(-1);
  });

  // Regression for the bearer-value lost-update race: wallet.add() (fires on every relay connect)
  // and wallet.spendMany() (fires on every post) overlap constantly. With a load→mutate→save wallet
  // one clobbers the other — spent tokens resurrect or drawn ones vanish. Interleaving them over a
  // storage that forces reads/writes to overlap must leave BOTH mutations in the persisted state.
  it('does not lose an add() or a spendMany() when they run concurrently', async () => {
    const storage = new SlowStorage();
    const w = new EpochWallet(storage);
    await w.draw(1, 5, countingMint()); // seed t0..t4

    const deposit: Token[] = [
      {token: Uint8Array.of(100), sig: Uint8Array.of(200), secret: Uint8Array.of(210)},
      {token: Uint8Array.of(101), sig: Uint8Array.of(201), secret: Uint8Array.of(211)},
    ];
    const [addTotal, spent] = await Promise.all([w.add(1, deposit), w.spendMany(3)]);

    // The spend took the three oldest tokens (0,1,2), regardless of which op ran first.
    expect(spent).not.toBeNull();
    expect(spent!.map(t => t.token[0]).sort((a, b) => a! - b!)).toEqual([0, 1, 2]);
    // add()'s return reflects the shared live list at the moment it ran, so it is 7 (it appended
    // before the spend) or 4 (it appended after) — both legal interleavings, never a lost update.
    // The authoritative check is the persisted state below: exactly 5 - 3 + 2 = 4.
    expect([4, 7]).toContain(addTotal);

    // Assert the PERSISTED state (a fresh instance re-reads storage) — no lost update either way:
    // the two deposited tokens are present AND the three spent tokens are gone.
    const reopened = new EpochWallet(storage);
    expect(await reopened.count()).toBe(4);
    const drained: number[] = [];
    for (let i = 0; i < 4; i++) {
      const t = await reopened.spend();
      drained.push(t!.token[0]!);
    }
    expect(drained).toEqual([3, 4, 100, 101]); // survivors, FIFO; spent 0,1,2 absent
    expect(await reopened.count()).toBe(0);
  });

  it('leaves no spent token in the persisted state after spendMany', async () => {
    const storage = new InMemoryStorage();
    const w = new EpochWallet(storage);
    await w.draw(1, 4, countingMint()); // t0..t3

    const taken = await w.spendMany(2);
    expect(taken!.map(t => t.token[0])).toEqual([0, 1]);

    // Read the raw persisted blob and decode: the two spent tokens must be gone, only t2,t3 remain.
    const raw = await storage.getItem(WALLET_KEY);
    const persisted = (JSON.parse(raw!) as {t: string; s: string; e: number; k: string}[]).map(
      x => base64ToBytes(x.t)[0],
    );
    expect(persisted).toEqual([2, 3]);
    expect(persisted).not.toContain(0);
    expect(persisted).not.toContain(1);
  });

  it('round-trips a wallet persisted in the current (holder-bound) on-disk format', async () => {
    const storage = new InMemoryStorage();
    // {t,s,e,k} base64 records plus a numeric epoch string under the same keys — `k` (base64 q) is
    // the P3 addition; everything else is unchanged from the pre-P3 shape.
    const current = [
      {t: bytesToBase64(Uint8Array.of(9)), s: bytesToBase64(Uint8Array.of(90)), e: 3, k: bytesToBase64(Uint8Array.of(19))},
      {t: bytesToBase64(Uint8Array.of(8)), s: bytesToBase64(Uint8Array.of(80)), e: 3, k: bytesToBase64(Uint8Array.of(18))},
    ];
    await storage.setItem(WALLET_KEY, JSON.stringify(current));
    await storage.setItem(EPOCH_KEY, '3');

    const w = new EpochWallet(storage);
    expect(await w.count()).toBe(2);
    expect(await w.lastEpoch()).toBe(3);

    const first = await w.spend();
    expect(first!.token[0]).toBe(9); // FIFO: oldest token first
    expect(first!.sig[0]).toBe(90);
    expect(first!.secret[0]).toBe(19);

    // A mutation re-persists in the identical format — same keys, same {t,s,e,k} record shape.
    const raw = await storage.getItem(WALLET_KEY);
    expect(JSON.parse(raw!)).toEqual([
      {t: bytesToBase64(Uint8Array.of(8)), s: bytesToBase64(Uint8Array.of(80)), e: 3, k: bytesToBase64(Uint8Array.of(18))},
    ]);
  });

  // P3 clean cutover (contract §2.7/2.1): a pre-P3 bearer token has no `k` (secret) field, so
  // isStoredToken filters it out on hydrate — it is discarded, never "repaired" or spent as if it
  // were holder-bound. The wallet then reads as empty, which is what drives the normal low-watermark
  // top-up / on-exhaustion redraw (no separate migration code path).
  it('discards a legacy (k-less) bearer-token batch on hydrate — the clean P3 cutover', async () => {
    const storage = new InMemoryStorage();
    // Exactly what pre-P3 code wrote: {t,s,e} with NO k field.
    const legacyBearer = [
      {t: bytesToBase64(Uint8Array.of(9)), s: bytesToBase64(Uint8Array.of(90)), e: 3},
      {t: bytesToBase64(Uint8Array.of(8)), s: bytesToBase64(Uint8Array.of(80)), e: 3},
    ];
    await storage.setItem(WALLET_KEY, JSON.stringify(legacyBearer));
    await storage.setItem(EPOCH_KEY, '3');

    const w = new EpochWallet(storage);
    expect(await w.count()).toBe(0); // discarded, not "repaired" or spent
    expect(await w.spend()).toBeNull();
  });

  // Robustness (contract §2.7): if an operator flips `holderProofRequired` WITHOUT rotating K_post
  // (so the wallet's own fingerprint reconciliation never fires), the k-field filter is the
  // backstop — a wallet full of pre-P3 tokens still reads empty (never stalls), so the ordinary
  // exhaustion path redraws a fresh, holder-bound batch under the SAME key.
  it('a flag-flip-without-rotation still empties the wallet (k-filter backstop) and a redraw refills it', async () => {
    const storage = new InMemoryStorage();
    const legacyBearer = [{t: bytesToBase64(Uint8Array.of(1)), s: bytesToBase64(Uint8Array.of(2)), e: 5}];
    await storage.setItem(WALLET_KEY, JSON.stringify(legacyBearer));
    await storage.setItem(EPOCH_KEY, '5');

    const w = new EpochWallet(storage);
    expect(await w.count()).toBe(0); // empty despite storage holding a (now-unspendable) legacy batch

    // The normal top-up (draw) refills it with holder-bound tokens under the same wallet.
    const total = await w.draw(6, 2, countingMint());
    expect(total).toBe(2);
    expect(await w.count()).toBe(2);
  });
});

describe('EpochWallet — posting-key fingerprint siloing (self-heal on issuer-key rotation)', () => {
  const FP_ENROLL = walletKeyFingerprint('K_enroll'); // pre-domain-separation / single-key deployment
  const FP_POST = walletKeyFingerprint('K_post'); // after a domain-sep cutover / key rotation

  it('(a) discards stale tokens when the issuer key changes, and the next top-up redraws under the new key', async () => {
    const storage = new InMemoryStorage();
    // Draw a batch under the OLD posting key.
    await new EpochWallet(storage, 'c', FP_ENROLL).draw(1, 3, countingMint());
    expect(await new EpochWallet(storage, 'c', FP_ENROLL).count()).toBe(3);

    // Domain-sep cutover: the community's posting key is now K_post. A wallet bound to the new
    // fingerprint (SAME cid namespace, i.e. the same re-enrolled community) sees the old batch as
    // unspendable and discards it on load — no re-enroll, no user action.
    const rotated = new EpochWallet(storage, 'c', FP_POST);
    expect(await rotated.count()).toBe(0);

    // The normal top-up now draws a fresh batch under the new key; it is stamped and kept.
    await rotated.draw(2, 4, countingMint());
    expect(await new EpochWallet(storage, 'c', FP_POST).count()).toBe(4);
    expect(await new EpochWallet(storage, 'c', FP_POST).lastEpoch()).toBe(2);
  });

  it('(b) keeps tokens when the posting key is unchanged', async () => {
    const storage = new InMemoryStorage();
    await new EpochWallet(storage, 'c', FP_POST).draw(1, 3, countingMint());
    // Reopen under the SAME fingerprint (app restart, same community/key) → tokens survive.
    const reopened = new EpochWallet(storage, 'c', FP_POST);
    expect(await reopened.count()).toBe(3);
    expect(await reopened.lastEpoch()).toBe(1);
    // A subsequent spend still works (proves the tokens weren't quietly discarded).
    expect((await reopened.spend())!.token[0]).toBe(0);
  });

  it('(c) discards a legacy wallet that holds tokens but carries NO fingerprint stamp, on first load', async () => {
    const storage = new InMemoryStorage();
    // Simulate a batch written by a build that predates this mechanism: tokens, but no stamp.
    await new EpochWallet(storage, 'c').draw(1, 5, countingMint());
    expect(await new EpochWallet(storage, 'c').count()).toBe(5); // still visible to an UNBOUND wallet

    // The first fingerprint-bound load treats the unknown-provenance batch as stale → discards it.
    const healed = new EpochWallet(storage, 'c', FP_POST);
    expect(await healed.count()).toBe(0);
    // And the discard is durable: reopening under the same key keeps it empty until a fresh draw.
    expect(await new EpochWallet(storage, 'c', FP_POST).count()).toBe(0);
  });

  it('(e) siloes per namespace even under the SAME issuer fingerprint (no cross-cid bleed)', async () => {
    const storage = new InMemoryStorage();
    const a = new EpochWallet(storage, 'A', FP_POST);
    const b = new EpochWallet(storage, 'B', FP_POST);
    await a.draw(1, 3, countingMint());
    expect(await a.count()).toBe(3);
    expect(await b.count()).toBe(0); // B's namespace is untouched by A's draw
  });

  it('binding the fingerprint later (setKeyFingerprint) also triggers the stale-token discard', async () => {
    const storage = new InMemoryStorage();
    await new EpochWallet(storage, 'c', FP_ENROLL).draw(1, 3, countingMint());
    const w = new EpochWallet(storage, 'c'); // constructed unbound (mirrors rebuildIdentity)
    expect(await w.count()).toBe(3); // unbound → sees the old tokens
    w.setKeyFingerprint(FP_POST); // runtime binds the current key after resolving the community
    expect(await w.count()).toBe(0); // now reconciled → discarded
  });

  it('clear() wipes the fingerprint stamp so a same-key wallet starts clean afterwards', async () => {
    const storage = new InMemoryStorage();
    const w = new EpochWallet(storage, 'c', FP_POST);
    await w.draw(1, 3, countingMint());
    await w.clear();
    // No stamp remains: a freshly drawn batch under the same key is accepted cleanly.
    await w.draw(2, 2, countingMint());
    expect(await new EpochWallet(storage, 'c', FP_POST).count()).toBe(2);
  });
});
