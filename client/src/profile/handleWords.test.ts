import {
  HANDLE_ADJECTIVES,
  HANDLE_CANDIDATE_SPACE,
  HANDLE_NOUNS,
  MAX_SUGGESTED_HANDLE,
  randomHandle,
} from './handleWords';

describe('handle wordlists', () => {
  it('offers a candidate space of many thousands, not a handful', () => {
    // The bug: a flat list of TEN hardcoded strings, which is what made suggestions "just repeating
    // some random stuff". Pin a floor well above that so the lists can't be quietly shrunk back.
    expect(HANDLE_CANDIDATE_SPACE).toBe(HANDLE_ADJECTIVES.length * HANDLE_NOUNS.length);
    expect(HANDLE_CANDIDATE_SPACE).toBeGreaterThanOrEqual(10_000);
  });

  it('has no duplicates within either list', () => {
    expect(new Set(HANDLE_ADJECTIVES).size).toBe(HANDLE_ADJECTIVES.length);
    expect(new Set(HANDLE_NOUNS).size).toBe(HANDLE_NOUNS.length);
  });

  it('keeps the lists disjoint, so no draw can stutter ("Cedar Cedar")', () => {
    const nouns = new Set(HANDLE_NOUNS);
    expect(HANDLE_ADJECTIVES.filter(a => nouns.has(a))).toEqual([]);
  });

  it('has no cross-role near-duplicates ("Misty Mist", "Drifting Drift")', () => {
    // A weather adjective paired with its own root noun reads as a typo. Catch any pair where one
    // word is the other's prefix (Misty/Mist, Drifting/Drift, Rainy/Rain).
    const stutters: string[] = [];
    for (const a of HANDLE_ADJECTIVES) {
      for (const n of HANDLE_NOUNS) {
        if (a.startsWith(n) || n.startsWith(a)) stutters.push(`${a} ${n}`);
      }
    }
    expect(stutters).toEqual([]);
  });

  it('never produces a handle longer than the onboarding input allows', () => {
    // The identity step's TextInput is maxLength={24}: a longer suggestion would be silently
    // truncated on its way into the display-name header.
    const longest = HANDLE_ADJECTIVES.reduce((m, w) => Math.max(m, w.length), 0) +
      1 +
      HANDLE_NOUNS.reduce((m, w) => Math.max(m, w.length), 0);
    expect(longest).toBeLessThanOrEqual(MAX_SUGGESTED_HANDLE);
  });

  it('uses only plain letters, so a handle can never break the identity header framing', () => {
    // displayName's sanitizeName strips control chars; a word with one would be silently mangled.
    for (const word of [...HANDLE_ADJECTIVES, ...HANDLE_NOUNS]) {
      expect(word).toMatch(/^[A-Z][a-z]+$/);
    }
  });
});

describe('randomHandle', () => {
  it('is deterministic under an injected rand', () => {
    const first = () => randomHandle(seq([0, 0]));
    expect(first()).toBe(`${HANDLE_ADJECTIVES[0]} ${HANDLE_NOUNS[0]}`);
    expect(first()).toBe(first());
  });

  it('maps the injected rand across the whole of both lists', () => {
    // Draws the last entry of each list — the boundary the old 10-string lookup never had.
    const last = randomHandle(seq([0.999_999, 0.999_999]));
    expect(last).toBe(
      `${HANDLE_ADJECTIVES[HANDLE_ADJECTIVES.length - 1]} ${HANDLE_NOUNS[HANDLE_NOUNS.length - 1]}`,
    );
  });

  it('clamps a rand that returns exactly 1 instead of indexing off the end', () => {
    // randomFloat can't return 1, but an injected rand might; `undefined Undefined` must be
    // impossible.
    const handle = randomHandle(() => 1);
    expect(handle).toBe(
      `${HANDLE_ADJECTIVES[HANDLE_ADJECTIVES.length - 1]} ${HANDLE_NOUNS[HANDLE_NOUNS.length - 1]}`,
    );
  });

  it('always yields two capitalised words within the length budget', () => {
    for (let i = 0; i < 200; i++) {
      const handle = randomHandle();
      expect(handle).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(handle.length).toBeLessThanOrEqual(MAX_SUGGESTED_HANDLE);
    }
  });

  it('spreads over far more than the ten values the old list could produce', () => {
    // The real regression guard. The old generator had exactly 10 possible outputs, so 400 draws
    // could never yield more than 10 distinct handles. Anything near that count means the
    // combinatorial generator has been broken back into a lookup.
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(randomHandle());
    expect(seen.size).toBeGreaterThan(200);
  });

  it('draws both halves independently (a fixed adjective still varies the noun)', () => {
    const nouns = new Set<string>();
    for (let i = 0; i < 200; i++) {
      // Pin the adjective to index 0, let the noun draw freely.
      let call = 0;
      nouns.add(randomHandle(() => (call++ === 0 ? 0 : Math.random())));
    }
    expect(nouns.size).toBeGreaterThan(50);
    for (const handle of nouns) expect(handle.startsWith(`${HANDLE_ADJECTIVES[0]} `)).toBe(true);
  });
});

/** A rand that returns each value in turn (then repeats the last) — for exact-index assertions. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}
