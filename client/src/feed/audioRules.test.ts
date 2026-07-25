import {
  DEFAULT_AUDIO_RULES,
  encodeAudioRules,
  parseAudioRules,
  parseAudioRulesEvent,
  normalizeAudioRules,
  evaluateVoice,
  setActiveAudioRules,
  activeAudioRules,
  type AudioRules,
} from './audioRules';

describe('audio rules (organizer control)', () => {
  it('round-trips through the compact wire shape', () => {
    const rules: AudioRules = {
      allow: true,
      allowanceBytes: 512 * 1024,
      periodHours: 12,
      maxBytesPerClip: 100 * 1024,
      maxDurationSec: 45,
      bitrateKbps: 16,
      sampleRateHz: 16_000,
    };
    expect(parseAudioRules(encodeAudioRules(rules))).toEqual(rules);
  });

  it('fills missing fields from defaults', () => {
    expect(parseAudioRules({al: false})).toEqual({...DEFAULT_AUDIO_RULES, allow: false});
    expect(parseAudioRules({})).toEqual(DEFAULT_AUDIO_RULES);
  });

  it('returns null for a non-object / malformed event', () => {
    expect(parseAudioRules(null)).toBeNull();
    expect(parseAudioRules(42)).toBeNull();
    expect(parseAudioRulesEvent('not json')).toBeNull();
    expect(parseAudioRulesEvent(JSON.stringify({al: true, md: 30}))).toEqual({...DEFAULT_AUDIO_RULES, maxDurationSec: 30});
  });

  it('clamps bitrate/sample-rate to native-safe encoder bounds', () => {
    // 4 kbps is below the 8 kbps floor; 96000 Hz is above the 48 kHz ceiling — both fall back.
    const r = parseAudioRules({al: true, br: 4, sr: 96_000})!;
    expect(r.bitrateKbps).toBe(DEFAULT_AUDIO_RULES.bitrateKbps);
    expect(r.sampleRateHz).toBe(DEFAULT_AUDIO_RULES.sampleRateHz);
    // In-range values pass through.
    expect(parseAudioRules({al: true, br: 32, sr: 32_000})!.bitrateKbps).toBe(32);
    expect(parseAudioRules({al: true, br: 32, sr: 32_000})!.sampleRateHz).toBe(32_000);
  });

  it('normalizes an old/partial persisted shape', () => {
    expect(normalizeAudioRules(undefined)).toEqual(DEFAULT_AUDIO_RULES);
    expect(normalizeAudioRules({allow: true, maxDurationSec: -5} as AudioRules).maxDurationSec).toBe(
      DEFAULT_AUDIO_RULES.maxDurationSec,
    );
  });

  it('evaluates violations against the allowance + per-clip cap', () => {
    const rules: AudioRules = {allow: true, allowanceBytes: 300_000, periodHours: 24, maxBytesPerClip: 100_000, maxDurationSec: 60, bitrateKbps: 24, sampleRateHz: 24_000};
    expect(evaluateVoice(50_000, 0, rules)).toEqual([]); // fine
    expect(evaluateVoice(120_000, 0, rules)).toEqual(['too-large']); // over per-clip cap
    expect(evaluateVoice(50_000, 280_000, rules)).toEqual(['over-allowance']); // 280k+50k > 300k
    expect(evaluateVoice(10_000, 0, {...rules, allow: false})).toEqual(['not-allowed']);
  });

  it('treats 0 allowance/cap as unlimited', () => {
    const rules: AudioRules = {allow: true, allowanceBytes: 0, periodHours: 24, maxBytesPerClip: 0, maxDurationSec: 60, bitrateKbps: 24, sampleRateHz: 24_000};
    expect(evaluateVoice(9_999_999, 9_999_999, rules)).toEqual([]);
  });

  it('active-rules accessor holds the last-set rules (recorder knobs)', () => {
    setActiveAudioRules(DEFAULT_AUDIO_RULES);
    expect(activeAudioRules()).toEqual(DEFAULT_AUDIO_RULES);
    setActiveAudioRules({...DEFAULT_AUDIO_RULES, bitrateKbps: 16, maxDurationSec: 30});
    expect(activeAudioRules().bitrateKbps).toBe(16);
    expect(activeAudioRules().maxDurationSec).toBe(30);
    setActiveAudioRules(DEFAULT_AUDIO_RULES); // restore for test isolation
  });
});
