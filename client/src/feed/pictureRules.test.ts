import {
  DEFAULT_PICTURE_RULES,
  encodePictureRules,
  parsePictureRules,
  parsePictureRulesEvent,
  normalizePictureRules,
  evaluatePicture,
  type PictureRules,
} from './pictureRules';

describe('picture rules (organizer control)', () => {
  it('round-trips through the compact wire shape', () => {
    const rules: PictureRules = {
      allow: true,
      allowanceBytes: 200 * 1024,
      periodHours: 12,
      maxBytesPerPicture: 40 * 1024,
      maxRes: 128,
      maxColours: 32,
    };
    expect(parsePictureRules(encodePictureRules(rules))).toEqual(rules);
  });

  it('fills missing fields from defaults', () => {
    expect(parsePictureRules({al: false})).toEqual({...DEFAULT_PICTURE_RULES, allow: false});
    expect(parsePictureRules({})).toEqual(DEFAULT_PICTURE_RULES);
  });

  it('returns null for a non-object / malformed event', () => {
    expect(parsePictureRules(null)).toBeNull();
    expect(parsePictureRules(42)).toBeNull();
    expect(parsePictureRulesEvent('not json')).toBeNull();
    expect(parsePictureRulesEvent(JSON.stringify({al: true, ab: 999}))).toEqual({...DEFAULT_PICTURE_RULES, allowanceBytes: 999});
  });

  it('normalizes an old/partial persisted shape', () => {
    expect(normalizePictureRules(undefined)).toEqual(DEFAULT_PICTURE_RULES);
    // A negative/garbage field falls back to the default, not the bad value.
    expect(normalizePictureRules({allow: true, allowanceBytes: -5} as PictureRules).allowanceBytes).toBe(
      DEFAULT_PICTURE_RULES.allowanceBytes,
    );
  });

  it('evaluates violations against the allowance + per-picture cap', () => {
    const rules: PictureRules = {allow: true, allowanceBytes: 100_000, periodHours: 24, maxBytesPerPicture: 30_000, maxRes: 256, maxColours: 64};
    expect(evaluatePicture(10_000, 0, rules)).toEqual([]); // fine
    expect(evaluatePicture(40_000, 0, rules)).toEqual(['too-large']); // over per-picture cap
    expect(evaluatePicture(20_000, 90_000, rules)).toEqual(['over-allowance']); // 90k+20k > 100k
    expect(evaluatePicture(10_000, 0, {...rules, allow: false})).toEqual(['not-allowed']);
  });

  it('treats 0 allowance/cap as unlimited', () => {
    const rules: PictureRules = {allow: true, allowanceBytes: 0, periodHours: 24, maxBytesPerPicture: 0, maxRes: 256, maxColours: 64};
    expect(evaluatePicture(9_999_999, 9_999_999, rules)).toEqual([]);
  });
});
