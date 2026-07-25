/**
 * Log-page wire sanitizer (issuer/log-page.mjs) — the dashboard → kind-30078 stiq:log-page pipeline.
 * Pins the WELCOME block the app parses (client/src/moderation/organizerConfig.ts currentLogPage):
 * shape, duration math, and the version discipline that drives the tuck-away/reopen contract.
 *
 * `now` is injected so version bumps are deterministic; `decodeSpaceLink` is stubbed (picks aren't
 * under test here — log-offer_test covers the space-link path).
 */
import {test} from 'node:test';
import assert from 'node:assert';
import {sanitizeLogPage} from './log-page.mjs';

const noLinks = () => null;

test('welcome: parses body + title/sig, days duration → seconds, w-prefixed ver', () => {
  const doc = sanitizeLogPage(
    {welcome: {b: 'Welcome aboard!', t: 'Hello', sig: '— us', durN: 2, durU: 'days'}},
    null,
    {now: 1000, decodeSpaceLink: noLinks},
  );
  assert.equal(doc.welcome.b, 'Welcome aboard!');
  assert.equal(doc.welcome.t, 'Hello');
  assert.equal(doc.welcome.sig, '— us');
  assert.equal(doc.welcome.dur, 2 * 86400);
  assert.equal(doc.welcome.ver, 'w1000');
});

test('welcome: hours unit', () => {
  const doc = sanitizeLogPage({welcome: {b: 'Hi', durN: 6, durU: 'hours'}}, null, {now: 1});
  assert.equal(doc.welcome.dur, 6 * 3600);
});

test('welcome: missing/invalid duration defaults to one day', () => {
  assert.equal(sanitizeLogPage({welcome: {b: 'Hi'}}, null, {now: 1}).welcome.dur, 86400);
  assert.equal(sanitizeLogPage({welcome: {b: 'Hi', durN: 0, durU: 'days'}}, null, {now: 1}).welcome.dur, 86400);
});

test('welcome: duration is capped at one year', () => {
  const doc = sanitizeLogPage({welcome: {b: 'Hi', durN: 99999, durU: 'days'}}, null, {now: 1});
  assert.equal(doc.welcome.dur, 365 * 86400);
});

test('welcome: absent/blank body → no welcome at all', () => {
  assert.equal(sanitizeLogPage({welcome: {t: 'Hi', durN: 2, durU: 'days'}}, null, {now: 1}).welcome, undefined);
  assert.equal(sanitizeLogPage({welcome: {b: '   ', durN: 2, durU: 'days'}}, null, {now: 1}).welcome, undefined);
});

test('welcome: unchanged text keeps the version across a republish', () => {
  const d1 = sanitizeLogPage({welcome: {b: 'Hi', sig: 's', durN: 2, durU: 'days'}}, null, {now: 1000});
  const d2 = sanitizeLogPage({welcome: {b: 'Hi', sig: 's', durN: 5, durU: 'days'}}, d1, {now: 2000});
  assert.equal(d2.welcome.ver, d1.welcome.ver); // only the duration changed → same version
});

test('welcome: changed text bumps the version (auto-reopen)', () => {
  const d1 = sanitizeLogPage({welcome: {b: 'Hi', durN: 2, durU: 'days'}}, null, {now: 1000});
  const d2 = sanitizeLogPage({welcome: {b: 'Changed', durN: 2, durU: 'days'}}, d1, {now: 2000});
  assert.notEqual(d2.welcome.ver, d1.welcome.ver);
});

test('welcome and note versions never collide for identical text (Point 3)', () => {
  const doc = sanitizeLogPage({note: {b: 'X'}, welcome: {b: 'X', durN: 1, durU: 'days'}}, null, {now: 5000});
  assert.notEqual(doc.note.ver, doc.welcome.ver);
  assert.ok(doc.note.ver.startsWith('n'));
  assert.ok(doc.welcome.ver.startsWith('w'));
});

test('welcome: a valid gradient is carried, a malformed one dropped', () => {
  const ok = sanitizeLogPage({welcome: {b: 'Hi', durN: 1, durU: 'days', g: 'L90:112233,445566'}}, null, {now: 1});
  assert.equal(ok.welcome.g, 'L90:112233,445566');
  const bad = sanitizeLogPage({welcome: {b: 'Hi', durN: 1, durU: 'days', g: 'nonsense'}}, null, {now: 1});
  assert.equal(bad.welcome.g, undefined);
  assert.equal(bad.welcome.b, 'Hi'); // welcome survives the dropped gradient
});
