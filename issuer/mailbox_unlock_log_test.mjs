/**
 * Unanswered-unlock diagnosability (2026-07-22 incident): prod showed 4 answered content-epoch
 * unlocks against 11 sealed posts, and the mailbox log gave no way to tell why the rest never got a
 * reply — a dropped (policy) or shed (concurrency cap) request logged no reason at all. Pins the two
 * log-line formatters mailbox.mjs's handleUnlock / message-dispatch now use. Pure — no relay, no ws,
 * no crypto (mirrors mailbox_dedupe_test.mjs / mailbox_transport_test.mjs style).
 * Run: node mailbox_unlock_log_test.mjs
 */
import {describeDroppedUnlock, describeShedRequest} from './mailbox.mjs';

let failures = 0;
function check(label, cond) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label);
  if (!cond) failures += 1;
}

// ── describeDroppedUnlock: every contentEpochKeys.mjs unlockEpoch refusal reason surfaces ──────
check('bad epoch reason is surfaced',
  describeDroppedUnlock({error: 'bad epoch'}) === 'dropped unlock request (no response sent): bad epoch');
check('unknown content epoch reason is surfaced',
  describeDroppedUnlock({error: 'unknown content epoch'}) ===
    'dropped unlock request (no response sent): unknown content epoch');
check('missing read-token reason is surfaced',
  describeDroppedUnlock({error: 'missing read-token'}) ===
    'dropped unlock request (no response sent): missing read-token');
check('malformed read-token reason is surfaced',
  describeDroppedUnlock({error: 'malformed read-token'}) ===
    'dropped unlock request (no response sent): malformed read-token');
check('invalid read-token reason is surfaced',
  describeDroppedUnlock({error: 'invalid read-token'}) ===
    'dropped unlock request (no response sent): invalid read-token');
check('a body with no error string still logs SOMETHING rather than silence',
  describeDroppedUnlock({}) === 'dropped unlock request (no response sent): unknown reason');
check('an undefined body (defensive) never throws and still logs a reason',
  describeDroppedUnlock(undefined) === 'dropped unlock request (no response sent): unknown reason');

// ── describeShedRequest: the request KIND is named, distinguishing unlock (9026) sheds
// from enroll (9020) / draw (9024) sheds under the SAME concurrency cap ─────────────────────────
check('an unlock (9026) shed names its kind',
  describeShedRequest(9026, 4) === 'shed mailbox request kind=9026 (at concurrency cap 4)');
check('an enroll (9020) shed names its kind, distinguishable from an unlock shed',
  describeShedRequest(9020, 4) === 'shed mailbox request kind=9020 (at concurrency cap 4)');
check('a draw (9024) shed names its kind and cap value',
  describeShedRequest(9024, 16) === 'shed mailbox request kind=9024 (at concurrency cap 16)');

console.log(failures === 0
  ? '\nall unanswered-unlock diagnosability invariants hold'
  : `\n${failures} unanswered-unlock diagnosability test(s) FAILED`);
if (failures > 0) process.exit(1);
