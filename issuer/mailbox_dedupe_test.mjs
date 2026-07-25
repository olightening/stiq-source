// Unit test for the mailbox replay guard (shouldProcess) and the high-water clamp
// (clampHighWater). Pure — no relay, no crypto, no keys.
// Run: node mailbox_dedupe_test.mjs   (exits non-zero on failure, matching roundtrip_test.mjs style)
import {shouldProcess, clampHighWater} from './mailbox.mjs';

let failures = 0;
function check(label, cond) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label);
  if (!cond) failures += 1;
}

const NOW = 1_800_000_000;                 // fixed "now" in seconds
const WINDOW = 48 * 3600 + 6 * 3600;       // SEEN_WINDOW_SECONDS mirror, for the age-boundary case

// ── fresh event is processed exactly once ──────────────────────────────────
{
  const seen = new Set();
  const ev = {id: 'a'.repeat(64), created_at: NOW};
  check('first delivery of a fresh event is processed', shouldProcess(ev, seen, NOW) === true);
  check('the same id on a replay is dropped', shouldProcess(ev, seen, NOW) === false);
  check('replay did not re-grow the set', seen.size === 1);
}

// ── malformed events never enter the set ───────────────────────────────────
{
  const seen = new Set();
  check('missing id is dropped', shouldProcess({created_at: NOW}, seen, NOW) === false);
  check('empty id is dropped', shouldProcess({id: '', created_at: NOW}, seen, NOW) === false);
  check('non-string id is dropped', shouldProcess({id: 123, created_at: NOW}, seen, NOW) === false);
  check('malformed events left the set empty', seen.size === 0);
}

// ── age window: events past the retention window are dropped (kept bounded) ─
{
  const seen = new Set();
  const stale = {id: 'b'.repeat(64), created_at: NOW - WINDOW - 60};
  check('event older than the window is dropped', shouldProcess(stale, seen, NOW) === false);
  check('stale drop did not grow the set', seen.size === 0);

  const justInside = {id: 'c'.repeat(64), created_at: NOW - WINDOW + 60};
  check('event just inside the window is processed', shouldProcess(justInside, seen, NOW) === true);
}

// ── missing created_at is tolerated (can't age it out, but still dedupes) ───
{
  const seen = new Set();
  const ev = {id: 'd'.repeat(64)};
  check('event without created_at is processed once', shouldProcess(ev, seen, NOW) === true);
  check('event without created_at dedupes on replay', shouldProcess(ev, seen, NOW) === false);
}

// ── two distinct fresh events both process ─────────────────────────────────
{
  const seen = new Set();
  check('event 1 processes', shouldProcess({id: 'e'.repeat(64), created_at: NOW}, seen, NOW) === true);
  check('event 2 processes', shouldProcess({id: 'f'.repeat(64), created_at: NOW}, seen, NOW) === true);
  check('both are remembered', seen.size === 2);
}

// ── high-water clamp: a far-future created_at must not poison the since floor ─
{
  const SKEW = 900; // HIGHWATER_SKEW_SECONDS mirror
  check('normal created_at passes through', clampHighWater(NOW - 60, NOW) === NOW - 60);
  check('small skew (within allowance) passes through', clampHighWater(NOW + SKEW, NOW) === NOW + SKEW);
  check('far-future created_at is clamped to now', clampHighWater(NOW + 10 * 365 * 24 * 3600, NOW) === NOW);
  check('just past the skew allowance is clamped to now', clampHighWater(NOW + SKEW + 1, NOW) === NOW);
  check('missing created_at counts as now', clampHighWater(undefined, NOW) === NOW);
  check('non-numeric created_at counts as now', clampHighWater('bogus', NOW) === NOW);
  check('Infinity created_at counts as now', clampHighWater(Infinity, NOW) === NOW);
  check('past created_at is NOT clamped (history stays history)', clampHighWater(NOW - WINDOW, NOW) === NOW - WINDOW);
}

console.log(failures === 0 ? '\nall dedupe tests passed' : `\n${failures} dedupe test(s) FAILED`);
if (failures > 0) process.exit(1);
