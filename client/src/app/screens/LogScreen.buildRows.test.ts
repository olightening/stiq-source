import {buildRows} from './LogScreen';
import type {ModLogEntry} from '../../moderation/modlog';
import type {GradientSpec} from '../../media/gradient';

const MOD = 'a'.repeat(64);
const AUTHOR_1 = 'b'.repeat(64);
const AUTHOR_2 = 'c'.repeat(64);

function entry(overrides: Partial<ModLogEntry> & Pick<ModLogEntry, 'key'>): ModLogEntry {
  return {
    action: 'hide',
    targetType: 'post',
    target: 'target-' + overrides.key,
    targetAuthorPubkey: AUTHOR_1,
    moderatorPubkey: MOD,
    moderatorNpub: 'npub1mod',
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

describe('LogScreen.buildRows profile memoization', () => {
  it('resolves each distinct pubkey at most once per snapshot', () => {
    const calls: string[] = [];
    const getProfile = (pubkey: string): {name?: string; gradient?: GradientSpec | null} => {
      calls.push(pubkey);
      return {name: `name-${pubkey.slice(0, 4)}`, gradient: null};
    };

    // Three entries: two share the same moderator AND same author, one has a different author.
    const entries: ModLogEntry[] = [
      entry({key: '1', targetAuthorPubkey: AUTHOR_1}),
      entry({key: '2', targetAuthorPubkey: AUTHOR_1}),
      entry({key: '3', targetAuthorPubkey: AUTHOR_2}),
    ];

    const rows = buildRows(entries, getProfile, 1_700_000_100_000);

    // Distinct pubkeys are MOD, AUTHOR_1, AUTHOR_2 → exactly 3 calls, not 2×3=6.
    expect(calls.sort()).toEqual([AUTHOR_1, AUTHOR_2, MOD].sort());
    expect(rows).toHaveLength(3);
  });

  it('still resolves the correct name/gradient per row after memoization', () => {
    const grad = {} as GradientSpec;
    const getProfile = (pubkey: string): {name?: string; gradient?: GradientSpec | null} =>
      pubkey === MOD ? {name: 'Maeve', gradient: null} : {name: 'Ada', gradient: grad};

    const rows = buildRows([entry({key: '1', targetAuthorPubkey: AUTHOR_1})], getProfile, 1_700_000_100_000);
    const row = rows[0]!;

    expect(row.modName).toBe('Maeve');
    expect(row.authorName).toBe('Ada');
    expect(row.authorGradient).toBe(grad);
  });

  it('tolerates an undefined getProfile', () => {
    const rows = buildRows([entry({key: '1'})], undefined, 1_700_000_100_000);
    expect(rows).toHaveLength(1);
  });
});
