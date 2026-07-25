// Unit tests for the token-keys broadcast retry/observability (T1.6, fixes F8).
//
// F8: publishTokenKeys() / publish() is the ONE mechanism that keeps the whole fleet's issuer keys in
// sync (kind-30078 stiq:token-keys). Before this fix it fired once, un-awaited by its callers, with no
// retry and no way for an operator to tell whether it actually landed — so a single relay hiccup or Tor
// blip reproduces the swk incident (mis-provisioned clients, silently) for every purpose key at once.
//
// This pins the fix: publishWithRetry() must retry a simulated relay failure with capped exponential
// backoff, stop the moment a simulated relay OK frame accepts, and — if the relay never accepts — give
// up after a BOUNDED number of attempts with a terminal, descriptive {ok:false} result rather than
// looping forever or throwing. publishFn/sleep are dependency-injected (matching this repo's existing
// mailbox_publish_test.mjs / contentEpochWatcher_test.mjs style) so the whole suite runs in-memory with
// no real socket and no real wall-clock delay.
//
// Sections 8-9 (fault F-E) additionally pin a real per-attempt connect TIMEOUT: before the fix,
// publish() called nostr-tools' STATIC `Relay.connect(relayWs)` with no opts, and — verified against
// the installed nostr-tools 2.23 — even passing `{timeout}` to that static helper is silently dropped
// before it reaches the instance's connect() (`static async connect(url,opts){ const relay = new
// Relay(url,opts); await relay.connect(); }` — opts never forwarded to the inner call). So a hung
// Tor/socket connect blocked an attempt forever, pinning publishWithRetry on attempt 1 and leaving the
// dashboard's tokenKeysPublish status `attempted:false` forever. The fix constructs the Relay directly
// and calls its instance `connect({timeout})`, which nostr-tools DOES honor. These two sections use a
// real (non-mocked) TCP listener that accepts the connection but never completes the WS handshake —
// the actual hang shape — to prove the real `publish()`/`publishWithRetry()` are now bounded.
//
// Run: node token_keys_publish_test.mjs  (also auto-discovered by `node --test`)
import {createServer} from 'net';
import {publish, publishWithRetry} from './organizer-nostr.mjs';

/** A TCP listener that accepts every connection and then never responds — simulates a hung
 * Tor/socket connect (the WS handshake never completes, so nostr-tools' onopen/onerror never fire). */
async function hungRelayServer() {
  const server = createServer(() => { /* accept, then silence */ });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  return {url: `ws://127.0.0.1:${port}`, close: () => server.close()};
}

let failures = 0;
function check(label, condition) {
  console.log((condition ? '  ok   ' : '  FAIL ') + label);
  if (!condition) failures += 1;
}

/** A fake relay: pops one canned {ok,message} result per publish attempt, records every call. */
function queuedPublisher(results) {
  const calls = [];
  return {
    calls,
    fn: async (event, relayWs) => {
      calls.push({event, relayWs});
      const next = results.shift();
      if (!next) return {ok: false, message: 'test setup error: no more relay frames queued', event};
      return {...next, event};
    },
  };
}

/** A fake clock: records requested delays and resolves immediately — no real wall-clock wait. */
function recordingSleep() {
  const delays = [];
  return {delays, fn: async ms => { delays.push(ms); }};
}

// ── 1. relay rejects twice, then the OK frame accepts on the third attempt ──────────────────────
{
  const publisher = queuedPublisher([
    {ok: false, message: 'publish failed: connection refused'},
    {ok: false, message: 'publish failed: timed out waiting for OK'},
    {ok: true, message: 'published to ws://relay.test'},
  ]);
  const sleeper = recordingSleep();
  const result = await publishWithRetry({id: 'evt1'}, 'ws://relay.test', {
    publishFn: publisher.fn, sleep: sleeper.fn, maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000,
  });
  check('retries past two rejections and succeeds once the relay OK frame accepts', result.ok === true && result.attempts === 3);
  check('stops immediately on success — exactly 3 attempts, none wasted after acceptance', publisher.calls.length === 3);
  check('backoff waited BETWEEN attempts only (2 waits for 3 attempts, not after the final success)', sleeper.delays.length === 2);
  check('backoff is exponential, not flat or random (100ms, then 200ms)', sleeper.delays[0] === 100 && sleeper.delays[1] === 200);
}

// ── 2. the relay never accepts — must terminate, not loop forever ──────────────────────────────
{
  const publisher = queuedPublisher([
    {ok: false, message: 'publish failed: A'},
    {ok: false, message: 'publish failed: B'},
    {ok: false, message: 'publish failed: C'},
  ]);
  const sleeper = recordingSleep();
  const result = await publishWithRetry({id: 'evt2'}, 'ws://relay.test', {
    publishFn: publisher.fn, sleep: sleeper.fn, maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 50,
  });
  check('exhausting every attempt resolves a terminal ok:false (never a thrown/uncaught rejection)', result.ok === false);
  check('attempts is bounded to maxAttempts — no unbounded/infinite retry', result.attempts === 3 && publisher.calls.length === 3);
  check('the terminal message names the last failure, for the operator + server log', /publish failed: C/.test(result.message));
}

// ── 3. capped exponential backoff: doubles each time, then holds at the cap ─────────────────────
{
  const publisher = queuedPublisher([
    {ok: false, message: '1'}, {ok: false, message: '2'}, {ok: false, message: '3'},
    {ok: false, message: '4'}, {ok: false, message: '5'},
  ]);
  const sleeper = recordingSleep();
  await publishWithRetry({id: 'evt3'}, 'ws://relay.test', {
    publishFn: publisher.fn, sleep: sleeper.fn, maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 300,
  });
  check('backoff doubles then caps (100, 200, 300, 300) — never exceeds maxDelayMs', JSON.stringify(sleeper.delays) === JSON.stringify([100, 200, 300, 300]));
}

// ── 4. a misbehaving injected publishFn that throws must not escape as a rejection ──────────────
{
  const throwing = async () => { throw new Error('boom'); };
  const sleeper = recordingSleep();
  let threw = false;
  let result;
  try {
    result = await publishWithRetry({id: 'evt4'}, 'ws://relay.test', {
      publishFn: throwing, sleep: sleeper.fn, maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10,
    });
  } catch {
    threw = true;
  }
  check('a throwing publishFn is caught internally, not propagated to the caller', threw === false);
  check('the caught throw is folded into the terminal failure result/message', result?.ok === false && /boom/.test(result.message));
}

// ── 5. single-attempt success needs no backoff wait at all ──────────────────────────────────────
{
  const publisher = queuedPublisher([{ok: true, message: 'published to ws://relay.test'}]);
  const sleeper = recordingSleep();
  const result = await publishWithRetry({id: 'evt5'}, 'ws://relay.test', {
    publishFn: publisher.fn, sleep: sleeper.fn, maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 8000,
  });
  check('an OK frame on the first attempt succeeds immediately', result.ok === true && result.attempts === 1);
  check('no backoff delay is incurred when the very first attempt lands', sleeper.delays.length === 0);
}

// ── 6. default options (as publishTokenKeys calls it) still bound the run ───────────────────────
{
  // Sanity check on the real defaults (maxAttempts=5) without waiting on real backoff: inject a
  // zero-delay sleep so the test stays fast while still exercising the un-overridden attempt cap.
  const publisher = queuedPublisher([
    {ok: false, message: 'x'}, {ok: false, message: 'x'}, {ok: false, message: 'x'},
    {ok: false, message: 'x'}, {ok: false, message: 'x'}, {ok: false, message: 'x'},
  ]);
  const result = await publishWithRetry({id: 'evt6'}, 'ws://relay.test', {
    publishFn: publisher.fn, sleep: async () => {},
  });
  check('default maxAttempts is 5 (bounded even with no explicit cap given)', result.attempts === 5 && publisher.calls.length === 5);
}

// ── 7. publish() itself (used as the real default publishFn) never throws, even unconfigured ────
{
  const result = await publish({id: 'evt7'}, null);
  check('publish() resolves (never throws) when no relay URL is configured', result.ok === false && /no relay/.test(result.message));
}

// ── 8. (F-E) a REAL publish() attempt against a genuinely hung relay connect is BOUNDED, not stuck
// forever — this is the exact failure mode: a hung Tor/socket connect must not block indefinitely ──
{
  const relay = await hungRelayServer();
  const start = Date.now();
  const result = await publish({id: 'evt8'}, relay.url, {connectTimeoutMs: 250});
  const elapsed = Date.now() - start;
  relay.close();
  check('a hung relay connect resolves ok:false rather than hanging forever', result.ok === false);
  check('the hang is bounded near connectTimeoutMs (250ms), not indefinite — elapsed=' + elapsed + 'ms',
    elapsed < 3000);
  check('the terminal message names the timeout, for the operator + server log', /timed out/i.test(result.message));
  console.log('ok — real publish() bounds a hung relay connect (elapsed=' + elapsed + 'ms, message="' + result.message + '")');
}

// ── 9. (F-E) publishWithRetry() using the REAL default publishFn against a hung relay: the retry
// loop must actually ADVANCE across attempts — not stall on attempt 1 forever — and still terminate
// with a bounded ok:false, exactly like tokenKeysPublish's real call shape ─────────────────────────
{
  const relay = await hungRelayServer();
  const start = Date.now();
  const result = await publishWithRetry({id: 'evt9'}, relay.url, {
    maxAttempts: 3,
    connectTimeoutMs: 150, // forwarded through to the real `publish` on every attempt
    sleep: async () => {}, // skip real backoff wall-clock delay; only the connect bound is under test
  });
  const elapsed = Date.now() - start;
  relay.close();
  check('publishWithRetry over a REAL hung relay still terminates ok:false (never hangs on attempt 1 forever)',
    result.ok === false);
  check('all 3 attempts actually ran — the loop advances past each hung attempt instead of stalling',
    result.attempts === 3);
  check('total wall time stays bounded (~3×150ms connects), not tens of seconds or forever — elapsed=' + elapsed + 'ms',
    elapsed < 3000);
  console.log('ok — publishWithRetry advances past a real hung relay across all attempts (elapsed=' + elapsed + 'ms, attempts=' + result.attempts + ')');
}

console.log(failures === 0 ? '\nall token-keys publish-retry tests passed' : `\n${failures} token-keys publish-retry test(s) FAILED`);
if (failures > 0) process.exit(1);
