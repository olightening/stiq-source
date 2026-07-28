// AppRuntime transitively imports native modules with no Jest mock in this repo; stub them so
// the runtime logic can be exercised in the test environment (same preamble as
// AppRuntime.groups.test.ts).
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {BlindTokensExhausted} from '../blind/blindSigner';
import {DrawErrorCode} from '../contracts';
import {DRAW_TIMEOUT_TOKEN_REASON} from '../feed/rejectionMessages';

/**
 * exhaustionReason — the calm copy a member sees when a write fails on an empty wallet. The
 * 2026-07-28 arti outage exposed BOTH misleads this table can produce:
 *   • a draw that TIMED OUT kept (correctly) the default "check your connection" copy, but
 *   • a refill that came back ok-but-EMPTY — the organizer's epoch allowance is genuinely spent —
 *     showed the SAME connection copy, sending a quota-limited member off to debug a network that
 *     was fine. Reconnecting can never refill a spent allowance.
 * These tests pin the three-way split: stale-key → key-resync copy; quota-spent → allowance copy;
 * everything else (including a plain timeout, and NO recorded failure) → the exception's own
 * connection copy. The classifier reads the STRUCTURED marker (_lastDrawFailure), never prose.
 */
function bareRuntime(): AppRuntime {
  return new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store: new InMemoryEventStore(),
    hash: async (d: Uint8Array) => d,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
}

/** Test seam: exhaustionReason consults the private _lastDrawFailure marker the draw paths write. */
function setLastDrawFailure(
  runtime: AppRuntime,
  f: {error: string; code?: string; timedOut?: boolean; quotaSpent?: boolean; at?: number} | null,
): void {
  (runtime as unknown as {_lastDrawFailure: unknown})._lastDrawFailure =
    f === null ? null : {purpose: 'post', at: Date.now(), ...f};
}

describe('AppRuntime.exhaustionReason', () => {
  it('with no recorded draw failure, returns the exception’s own connection copy', () => {
    const runtime = bareRuntime();
    const e = new BlindTokensExhausted();
    expect(runtime.exhaustionReason(e)).toBe(e.message);
  });

  it('a recent quota-spent refill (ok-but-empty draw) says ALLOWANCE, never "check your connection"', () => {
    const runtime = bareRuntime();
    setLastDrawFailure(runtime, {error: 'epoch allowance spent', quotaSpent: true});
    const reason = runtime.exhaustionReason(new BlindTokensExhausted());
    expect(reason).toContain('allowance');
    expect(reason).not.toContain('connection');
  });

  it('a recent draw TIMEOUT keeps the connection copy — there the network really is the cause', () => {
    const runtime = bareRuntime();
    setLastDrawFailure(runtime, {error: 'the organizer did not respond in time', timedOut: true});
    const e = new BlindTokensExhausted();
    expect(runtime.exhaustionReason(e)).toBe(e.message);
  });

  it('the stale-key family still wins (existing 2026-07-21 behaviour, unchanged)', () => {
    const runtime = bareRuntime();
    setLastDrawFailure(runtime, {error: 'stale', code: DrawErrorCode.StaleBlindKey});
    expect(runtime.exhaustionReason(new BlindTokensExhausted())).toContain('security keys');
  });

  it('a STALE quota marker (outside the TTL) no longer explains the exhaustion', () => {
    const runtime = bareRuntime();
    setLastDrawFailure(runtime, {
      error: 'epoch allowance spent',
      quotaSpent: true,
      at: Date.now() - 11 * 60_000, // DRAW_FAILURE_REASON_TTL_MS is 10 minutes
    });
    const e = new BlindTokensExhausted();
    expect(runtime.exhaustionReason(e)).toBe(e.message);
  });

  it('non-exhaustion errors pass through untouched', () => {
    const runtime = bareRuntime();
    expect(runtime.exhaustionReason(new Error('boom'))).toBe('boom');
    expect(runtime.exhaustionReason('plain')).toBe('plain');
  });
});

describe('sendReasonsSnapshot — token-family rejection during a draw-timeout window', () => {
  // The copy the user actually reported ("out of tokens" while posting in a channel): the send
  // reached the relay TOKEN-LESS because the draw died over Tor, and the relay's
  // space_token_required rejection rendered as a quota problem. When the recorded draw failure is
  // a recent TIMEOUT, the stored reason is substituted with the transport-honest copy; a genuine
  // token rejection with no such window keeps the relay's own message.
  const SPACE_REJECT = '[space_token_required] blocked: this community requires a space token for this content';

  function stubOutbox(runtime: AppRuntime, reasons: Map<string, string>): void {
    (runtime as unknown as {outbox: unknown}).outbox = {
      version: () => 1,
      reasons: () => reasons,
    };
  }

  function snapshotReasons(runtime: AppRuntime): Map<string, string> {
    return (runtime as unknown as {sendReasonsSnapshot: () => Map<string, string>}).sendReasonsSnapshot();
  }

  it('substitutes the transport-honest copy while a recent draw timeout is recorded', () => {
    const runtime = bareRuntime();
    stubOutbox(runtime, new Map([['ev1', SPACE_REJECT], ['ev2', '[content_too_long] blocked: post too long']]));
    setLastDrawFailure(runtime, {error: 'the organizer did not respond in time', timedOut: true});
    const reasons = snapshotReasons(runtime);
    expect(reasons.get('ev1')).toBe(DRAW_TIMEOUT_TOKEN_REASON);
    expect(reasons.get('ev2')).toBe('[content_too_long] blocked: post too long'); // non-token untouched
  });

  it('leaves the relay\'s own token rejection alone when no draw timeout is recorded', () => {
    const runtime = bareRuntime();
    stubOutbox(runtime, new Map([['ev1', SPACE_REJECT]]));
    setLastDrawFailure(runtime, null);
    expect(snapshotReasons(runtime).get('ev1')).toBe(SPACE_REJECT);
  });

  it('a NON-timeout draw failure (organizer refused) does not trigger the substitution', () => {
    const runtime = bareRuntime();
    stubOutbox(runtime, new Map([['ev1', SPACE_REJECT]]));
    setLastDrawFailure(runtime, {error: 'refused', timedOut: false});
    expect(snapshotReasons(runtime).get('ev1')).toBe(SPACE_REJECT);
  });
});
