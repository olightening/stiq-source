import {
  computeDomainStatuses,
  computeWalletRows,
  filterTokenFailures,
  EMPTY_TOKEN_WALLET_COUNTS,
  EMPTY_TOKEN_STATUS,
  type TokenWalletCounts,
} from './tokenEconomyStatus';
import {defaultRelayCapabilities, type RelayCapabilities} from '../nostr/capabilities';
import type {LogEntry} from '../util/log';

/** A full RelayCapabilities fixture, overridable per test — mirrors the fallback shape (T5.1 tests
 *  don't need a parsed NIP-11 doc, just the typed shape computeWalletRows/computeDomainStatuses read). */
function caps(over: Partial<RelayCapabilities> = {}): RelayCapabilities {
  return {...defaultRelayCapabilities(), ...over};
}

const COUNTS: TokenWalletCounts = {
  post: 12,
  read: 0,
  pictureWrite: 3,
  pictureRead: 0,
  audioWrite: 0,
  audioRead: 0,
  spaceWrite: 40,
};

describe('computeWalletRows', () => {
  it('carries every purpose count through unchanged, in the fixed display order', () => {
    const rows = computeWalletRows(COUNTS, caps());
    expect(rows.map(r => r.purpose)).toEqual([
      'post',
      'spaceWrite',
      'read',
      'pictureWrite',
      'pictureRead',
      'audioWrite',
      'audioRead',
    ]);
    expect(rows.map(r => r.count)).toEqual([12, 40, 0, 3, 0, 0, 0]);
  });

  it('post is always active regardless of caps', () => {
    const [postRow] = computeWalletRows(EMPTY_TOKEN_WALLET_COUNTS, caps());
    expect(postRow).toMatchObject({purpose: 'post', active: true});
  });

  it('pictureRead/audioRead are always inactive — no consumer anywhere (F12)', () => {
    const rows = computeWalletRows(
      COUNTS,
      caps({mediaWriteDomains: {picture: true, audio: true}, enforcedFlags: {...defaultRelayCapabilities().enforcedFlags, contentEncryption: true}}),
    );
    const byPurpose = Object.fromEntries(rows.map(r => [r.purpose, r.active]));
    expect(byPurpose.pictureRead).toBe(false);
    expect(byPurpose.audioRead).toBe(false);
  });

  it('spaceWrite/read/pictureWrite/audioWrite track their own relay gate', () => {
    const allOff = computeWalletRows(COUNTS, caps());
    const offByPurpose = Object.fromEntries(allOff.map(r => [r.purpose, r.active]));
    expect(offByPurpose.spaceWrite).toBe(false);
    expect(offByPurpose.read).toBe(false);
    expect(offByPurpose.pictureWrite).toBe(false);
    expect(offByPurpose.audioWrite).toBe(false);

    const allOn = computeWalletRows(
      COUNTS,
      caps({
        enforcedFlags: {...defaultRelayCapabilities().enforcedFlags, spaceTokensRequired: true, contentEncryption: true},
        mediaWriteDomains: {picture: true, audio: true},
      }),
    );
    const onByPurpose = Object.fromEntries(allOn.map(r => [r.purpose, r.active]));
    expect(onByPurpose.spaceWrite).toBe(true);
    expect(onByPurpose.read).toBe(true);
    expect(onByPurpose.pictureWrite).toBe(true);
    expect(onByPurpose.audioWrite).toBe(true);
  });
});

describe('computeDomainStatuses (T1.4/C5 per-domain drift verdict)', () => {
  it('MATCH: wallet fingerprint matches a relay-advertised entry → ok', () => {
    const [posting] = computeDomainStatuses(
      caps({purposeKeyFingerprints: {posting: ['abcd1234']}}),
      {posting: 'abcd1234'},
    );
    expect(posting).toMatchObject({domain: 'posting', advertised: true, relayKeyCount: 1, verdict: 'ok'});
  });

  it('ROTATION OVERLAP: a wallet key matching a NON-FIRST array entry is NOT flagged stale (T1.4/B3)', () => {
    const [posting] = computeDomainStatuses(
      caps({purposeKeyFingerprints: {posting: ['newkey0000', 'abcd1234']}}),
      {posting: 'abcd1234'},
    );
    expect(posting).toMatchObject({verdict: 'ok', relayKeyCount: 2});
  });

  it('STALE: a wallet key matching NO entry in the array IS flagged (the swk failure mode)', () => {
    const [posting] = computeDomainStatuses(
      caps({purposeKeyFingerprints: {posting: ['wrongA', 'wrongB']}}),
      {posting: 'abcd1234'},
    );
    expect(posting).toMatchObject({verdict: 'stale', relayKeyCount: 2, walletFingerprint: 'abcd1234'});
  });

  it('UNKNOWN: relay advertises nothing for the domain → unknown, not stale', () => {
    const [posting] = computeDomainStatuses(caps(), {posting: 'abcd1234'});
    expect(posting).toMatchObject({advertised: false, relayKeyCount: 0, verdict: 'unknown'});
  });

  it('UNKNOWN: relay advertises the domain but this device carries no key for it → unknown', () => {
    const [posting] = computeDomainStatuses(caps({purposeKeyFingerprints: {posting: ['abcd1234']}}), {});
    expect(posting).toMatchObject({verdict: 'unknown', walletFingerprint: undefined});
  });

  it('covers all five tracked domains in a stable order', () => {
    const domains = computeDomainStatuses(caps(), {}).map(d => d.domain);
    expect(domains).toEqual(['posting', 'space_write', 'picture', 'audio', 'read']);
  });

  it('space-write/picture/audio domains verdict independently of each other', () => {
    const rows = computeDomainStatuses(
      caps({
        purposeKeyFingerprints: {
          spaceWrite: ['sw-good'],
          picture: ['pic-good'],
          audio: ['aud-bad'],
        },
      }),
      {spaceWrite: 'sw-good', picture: 'pic-good', audio: 'aud-good'},
    );
    const byDomain = Object.fromEntries(rows.map(r => [r.domain, r.verdict]));
    expect(byDomain.space_write).toBe('ok');
    expect(byDomain.picture).toBe('ok');
    expect(byDomain.audio).toBe('stale'); // aud-good doesn't prefix-match aud-bad
  });

  it('read (single-string legacy shape) still verdicts via the normalized one-entry array', () => {
    const okRow = computeDomainStatuses(caps({purposeKeyFingerprints: {read: 'readkeyFULLHASH'}}), {
      read: 'readkey',
    }).find(d => d.domain === 'read')!;
    expect(okRow).toMatchObject({advertised: true, relayKeyCount: 1, verdict: 'ok'});

    const staleRow = computeDomainStatuses(caps({purposeKeyFingerprints: {read: 'somethingElse'}}), {
      read: 'readkey',
    }).find(d => d.domain === 'read')!;
    expect(staleRow.verdict).toBe('stale');
  });
});

describe('filterTokenFailures', () => {
  function entry(over: Partial<LogEntry> = {}): LogEntry {
    return {ts: 1000, level: 'warn', scope: 'wallet', msg: 'something failed', ...over};
  }

  it('keeps only token-relevant scopes (wallet/draw/caps/media), drops others (e.g. relay)', () => {
    const out = filterTokenFailures([
      entry({scope: 'wallet', msg: 'a'}),
      entry({scope: 'relay', msg: 'b'}),
      entry({scope: 'draw', msg: 'c'}),
      entry({scope: 'unrelated', msg: 'd'}),
      entry({scope: 'caps', msg: 'e'}),
      entry({scope: 'media', msg: 'f'}),
    ]);
    expect(out.map(o => o.message)).toEqual(['f', 'e', 'c', 'a']); // newest-first, non-token scopes dropped
  });

  it('drops info-level entries (not a failure) even in a token scope', () => {
    const out = filterTokenFailures([entry({level: 'info', msg: 'fyi'}), entry({level: 'warn', msg: 'real'})]);
    expect(out.map(o => o.message)).toEqual(['real']);
  });

  it('returns newest-first (the ring buffer itself is oldest-first)', () => {
    const out = filterTokenFailures([
      entry({ts: 1, msg: 'first'}),
      entry({ts: 2, msg: 'second'}),
      entry({ts: 3, msg: 'third'}),
    ]);
    expect(out.map(o => o.message)).toEqual(['third', 'second', 'first']);
  });

  it('caps at `limit`, keeping the most recent', () => {
    const entries = Array.from({length: 30}, (_, i) => entry({ts: i, msg: `m${i}`}));
    const out = filterTokenFailures(entries, 5);
    expect(out).toHaveLength(5);
    expect(out.map(o => o.message)).toEqual(['m29', 'm28', 'm27', 'm26', 'm25']);
  });

  it('empty ring buffer → empty result', () => {
    expect(filterTokenFailures([])).toEqual([]);
  });
});

describe('EMPTY_TOKEN_STATUS / EMPTY_TOKEN_WALLET_COUNTS', () => {
  it('is an all-zero, all-empty default (safe pre-init fallback)', () => {
    expect(EMPTY_TOKEN_STATUS.wallets).toEqual(EMPTY_TOKEN_WALLET_COUNTS);
    expect(Object.values(EMPTY_TOKEN_WALLET_COUNTS).every(n => n === 0)).toBe(true);
    expect(EMPTY_TOKEN_STATUS.walletRows).toEqual([]);
    expect(EMPTY_TOKEN_STATUS.domains).toEqual([]);
    expect(EMPTY_TOKEN_STATUS.recentFailures).toEqual([]);
    expect(EMPTY_TOKEN_STATUS.communityKeyError).toBeUndefined();
  });
});
