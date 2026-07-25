/**
 * Rising ranking config invariants.
 *
 * The dashboard's /api/ranking route sanitizes organizer-supplied ranking weights, persists them to
 * ranking.json, and signs+publishes a kind-30078 d=stiq:ranking event whose COMPACT content
 * {hl,sw,tw,thl,vw,cw,chl,lw,ty:{n,a}} the client parses in client/src/feed/sort.ts parseRanking.
 * Three properties are load-bearing and pinned here:
 *   1. sanitizeRanking falls back per-field, and never lets a half-life reach 0 (λ = ln2/hl would be
 *      infinite), no matter what garbage is posted.
 *   2. signConfig('stiq:ranking', …) yields a kind-30078 event with a d=stiq:ranking tag whose
 *      content is exactly the compact wire — the cross-layer contract with the client parser.
 *   3. The Rising PREVIEW in organizer-ui.js still computes what client/src/feed/sort.ts computes.
 *      That preview is a hand-mirror of risingScore(); these assertions are what stops it drifting
 *      into lying to whoever is tuning the feed.
 *
 * sanitizeRanking is mirrored below (kept in lockstep with organizer-server.mjs, exactly as
 * storage_config_test.mjs mirrors sanitizeStorage) — organizer-server.mjs can't be imported without
 * booting the whole dashboard. The preview functions ARE the real ones: they're pure (no DOM), so
 * they're sliced straight out of organizer-ui.js and eval'd, which is what makes (3) meaningful.
 */
import assert from 'assert';
import {readFileSync} from 'fs';
import {signConfig} from './organizer-nostr.mjs';

// ── Mirror of organizer-server.mjs sanitizeRanking (kept in lockstep) ────────────
const DEFAULT_RANKING_CFG = {
  hl: 3.85, sw: 0.1, tw: 1, thl: 6, vw: 1, cw: 0, chl: 6, lw: 0, ty: {n: 1, a: 1},
};
function rankNum(v, dflt, min) {
  const n = typeof v === 'number' ? v : (/^-?\d*\.?\d+$/.test(String(v).trim()) ? parseFloat(v) : NaN);
  return Number.isFinite(n) && n >= min ? n : dflt;
}
function sanitizeRanking(body) {
  const ty = (body && typeof body.ty === 'object' && body.ty) || {};
  return {
    hl: rankNum(body?.hl, DEFAULT_RANKING_CFG.hl, Number.MIN_VALUE),
    sw: rankNum(body?.sw, DEFAULT_RANKING_CFG.sw, 0),
    tw: rankNum(body?.tw, DEFAULT_RANKING_CFG.tw, 0),
    thl: rankNum(body?.thl, DEFAULT_RANKING_CFG.thl, Number.MIN_VALUE),
    vw: rankNum(body?.vw, DEFAULT_RANKING_CFG.vw, 0),
    cw: rankNum(body?.cw, DEFAULT_RANKING_CFG.cw, 0),
    chl: rankNum(body?.chl, DEFAULT_RANKING_CFG.chl, Number.MIN_VALUE),
    lw: rankNum(body?.lw, DEFAULT_RANKING_CFG.lw, 0),
    ty: {n: rankNum(ty.n, DEFAULT_RANKING_CFG.ty.n, 0), a: rankNum(ty.a, DEFAULT_RANKING_CFG.ty.a, 0)},
  };
}

// ── 1. sanitizeRanking ───────────────────────────────────────────────────────────

for (const empty of [undefined, null, {}, 'nonsense', 42, []]) {
  assert.deepStrictEqual(sanitizeRanking(empty), DEFAULT_RANKING_CFG,
    `empty/garbage input (${JSON.stringify(empty)}) yields the defaults`);
}

// A doc published before the new fields existed carries only {hl, sw}. Its tuning must SURVIVE and
// the absent fields must fill in with defaults — the whole ship-dark contract.
assert.deepStrictEqual(sanitizeRanking({hl: 6, sw: 0.5}), {...DEFAULT_RANKING_CFG, hl: 6, sw: 0.5},
  'a pre-existing {hl,sw} doc keeps its values and defaults the rest');

// Numeric strings: the UI posts raw <input type="text"> values.
const strs = sanitizeRanking({hl: '2.5', cw: '1.5', ty: {a: '1.5'}});
assert.strictEqual(strs.hl, 2.5, 'numeric string hl is accepted');
assert.strictEqual(strs.cw, 1.5, 'numeric string cw is accepted');
assert.strictEqual(strs.ty.a, 1.5, 'numeric string ty.a is accepted');

// Half-lives divide (λ = ln2/hl) — 0 or negative MUST fall back, never divide by zero.
for (const key of ['hl', 'thl', 'chl']) {
  for (const bad of [0, -3, '0', 'abc', null]) {
    const out = sanitizeRanking({[key]: bad});
    assert.strictEqual(out[key], DEFAULT_RANKING_CFG[key],
      `${key}=${JSON.stringify(bad)} falls back rather than publishing an infinite decay`);
  }
}

// Weights may be 0 (that's how a signal is switched off) but never negative.
for (const key of ['tw', 'vw', 'cw', 'sw', 'lw']) {
  assert.strictEqual(sanitizeRanking({[key]: 0})[key], 0, `${key}=0 is honoured (signal off)`);
  assert.strictEqual(sanitizeRanking({[key]: -1})[key], DEFAULT_RANKING_CFG[key],
    `${key}=-1 falls back (a negative weight would invert the signal)`);
}

// One bad field must not drag the others off their current meaning.
const partial = sanitizeRanking({hl: 6, cw: -1, lw: 'x', thl: 0, ty: {a: 2}});
assert.strictEqual(partial.hl, 6, 'the one good field survives its neighbours being garbage');
assert.deepStrictEqual(partial.ty, {n: 1, a: 2}, 'a partial ty defaults n and honours a');

// ── 2. The signed event = the cross-layer contract ───────────────────────────────

const cfg = sanitizeRanking({hl: 2.5, cw: 1.5, lw: 0.5, ty: {n: 1, a: 1.5}});
const event = signConfig('stiq:ranking', [], JSON.stringify(cfg));
assert.strictEqual(event.kind, 30078, 'ranking publishes as kind-30078');
assert.deepStrictEqual(event.tags, [['d', 'stiq:ranking']], 'addressed by d=stiq:ranking');
assert.deepStrictEqual(JSON.parse(event.content), {
  hl: 2.5, sw: 0.1, tw: 1, thl: 6, vw: 1, cw: 1.5, chl: 6, lw: 0.5, ty: {n: 1, a: 1.5},
}, 'content is exactly the compact wire client/src/feed/sort.ts parseRanking reads');

// ── 3. The dashboard preview still mirrors client/src/feed/sort.ts risingScore ───
// Slice the pure scoring functions out of organizer-ui.js and run them for real. If someone edits
// the preview's math, these fail; if someone edits sort.ts, these are the reminder to edit both.

const ui = readFileSync(new URL('./organizer-ui.js', import.meta.url), 'utf8');
const slice = ui.slice(ui.indexOf('var HOUR = 3600;'), ui.indexOf('var RANK_BARS'));
assert.ok(slice.includes('function rankScore'), 'found the preview scorer in organizer-ui.js');
// eslint-disable-next-line no-eval
const {rankScore, rankDecay} = eval(`${slice}; ({rankScore, rankDecay})`);

const W = {...DEFAULT_RANKING_CFG};
const post = (o) => ({kind: 'n', ageH: 0, words: 10, score: 0, voteAgesH: [], commenterAgesH: [], ...o});

// Decay is symmetric in time: a future stamp is punished exactly like an equally-distant past one.
// sort.ts decays on |now - t| precisely because nothing in the stack validates created_at.
assert.strictEqual(rankDecay(3600, 6), rankDecay(-3600, 6),
  'preview decay is symmetric (future-dating is self-defeating, as in sort.ts)');
assert.ok(Math.abs(rankDecay(6 * 3600, 6) - 0.5) < 1e-9, 'one half-life halves the weight exactly');

// Half-life belongs to its own signal: freshness must not move when the VOTE half-life changes.
const base = rankScore(post({ageH: 3}), W);
const voteHlChanged = rankScore(post({ageH: 3}), {...W, hl: 999});
assert.strictEqual(base.time, voteHlChanged.time, 'freshness ignores the vote half-life');

// Votes are log-damped onto the same scale as everything else: 200 votes is worth ~5, not 200.
const landslide = rankScore(post({voteAgesH: new Array(200).fill(0)}), W);
assert.ok(landslide.votes < 6, `200 simultaneous votes score ${landslide.votes.toFixed(2)} (<6), not 200`);

// At equal weight, a vote and a commenter contribute equally — that is what "same scale" buys.
const eqW = {...W, vw: 1, cw: 1, chl: W.hl};
const tenVotes = rankScore(post({voteAgesH: new Array(10).fill(0)}), eqW);
const tenCommenters = rankScore(post({commenterAgesH: new Array(10).fill(0)}), eqW);
assert.ok(Math.abs(tenVotes.votes - tenCommenters.comments) < 1e-9,
  'ten votes and ten commenters contribute identically at equal weight + half-life');

// Comments ship dark: cw=0 must contribute exactly nothing.
assert.strictEqual(rankScore(post({commenterAgesH: [0, 0, 0]}), W).comments, 0,
  'commentWeight 0 keeps comments out of the score entirely');

// The type weight multiplies the WHOLE sum (proportional), so it cannot resurrect a dead post.
const deadArticle = rankScore(post({kind: 'a', ageH: 500}), {...W, ty: {n: 1, a: 1.5}});
const liveNote = rankScore(post({kind: 'n', ageH: 0, voteAgesH: [0, 0, 0]}), {...W, ty: {n: 1, a: 1.5}});
assert.ok(liveNote.total > deadArticle.total,
  'a 1.5x article multiplier does not float a dead article above a live note');

// A negative score can only come from a hostile client; log(1+s) is NaN at s <= -1.
assert.ok(Number.isFinite(rankScore(post({score: -50}), {...W, sw: 1}).total),
  'a negative score yields a finite total (no NaN), matching sort.ts max(0, score)');

console.log('ranking_config_test: OK');
