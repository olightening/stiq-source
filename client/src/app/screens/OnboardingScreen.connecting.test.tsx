/**
 * OnboardingScreen — ConnectingStep's real circuit-open gate (Finding A1).
 *
 * `ConnectingStep` and `classifyExchangeFailure` are exported (see OnboardingScreen.tsx) purely so
 * these two pieces can be exercised directly, mirroring the PinStep/DoneStep pattern in
 * OnboardingScreen.pinDone.test.tsx — no need to re-drive the whole welcome→code chain.
 *
 * Covers:
 *   - Row 1 ("Exchanging keys") stays active — NOT checked off — for the whole exchange, including
 *     after `onCircuitOpen` proves the circuit reached the community relay. An open circuit is a
 *     transport fact, not an accepted invite: greening the row on it would tell a member with a
 *     spent code that their key exchange succeeded, moments before it fails. The circuit-open proof
 *     still drives the live subtitle, which is asserted here too.
 *   - Row 2 ("Getting your community ready") — the first-run prefetch rung: it holds the ladder
 *     while the community's store warms, and the step advances whether that prefetch succeeds,
 *     fails, or isn't wired at all. A prefetch must never be able to cost a member the credential
 *     they just earned.
 *   - `classifyExchangeFailure`'s three buckets: relay-unreachable (circuit never opened), a
 *     rejected/stale invite (auth), and a generic post-circuit-open failure (relay, raw error).
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {ConnectingStep, classifyExchangeFailure} from './OnboardingScreen';
import type {Community} from '../../onboarding/community';
import type {Session} from '../../onboarding/enrollment';
import type {ExchangeResult, CircuitHooks} from '../../onboarding/exchange';

const ONION = `ws://${'a'.repeat(56)}.onion`;

function community(): Community {
  return {relayUrl: ONION, issuerPublicKey: 'ISSUER', organizerPubkey: 'org-pubkey', name: 'Acme'};
}

/** True when any rendered <Text> has exactly this string as its children. */
function hasLine(tree: renderer.ReactTestRenderer, text: string): boolean {
  return tree.root.findAllByType(Text).some(n => n.props.children === text);
}

/**
 * Checklist rows checked off = the step's `completed` count, one "✓" glyph per done row.
 *
 * The success ORB renders a ✓ of ITS own once the ladder finishes (see ConnectingOrb), so it is
 * subtracted — otherwise a complete four-row ladder reads as five. The orb is `done={success}` and
 * the title reads "You're in" under exactly that same condition, which is why the title is a sound
 * proxy for "the orb is showing its check".
 */
function checkmarkCount(tree: renderer.ReactTestRenderer): number {
  const glyphs = tree.root.findAllByType(Text).filter(n => n.props.children === '✓').length;
  return hasLine(tree, "You're in") ? glyphs - 1 : glyphs;
}

const SESSION = {} as unknown as Session;

/**
 * Every tree mounted by {@link mount}, unmounted after each test.
 *
 * NOT optional hygiene: ConnectingStep runs two INFINITE `Animated.loop`s while it is working (the
 * orb's pulse and the row spinner's rotation). A tree left mounted keeps driving them through
 * reanimated's mocked rAF forever — which, under `--runInBand`, means every later suite in the run
 * shares the JS thread with them. That leaks as "Cannot log after tests are done" noise and, left
 * alone, was enough to push an unrelated LockScreen test past its 5s timeout.
 */
const mounted: renderer.ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => {
    for (const tree of mounted.splice(0)) {
      tree.unmount();
    }
  });
});

/**
 * Mount ConnectingStep already in the exchange phase (connection='connected'), with a hand-driven
 * exchange and an optional hand-driven prefetch.
 */
function mount(opts: {
  onPrefetchCommunity?: (session: Session) => Promise<unknown>;
  onSession?: (session: Session) => void;
} = {}): {
  tree: renderer.ReactTestRenderer;
  hooks: () => CircuitHooks | undefined;
  settleExchange: (r: ExchangeResult) => void;
  render: Promise<void>;
} {
  let capturedHooks: CircuitHooks | undefined;
  let resolveExchange!: (r: ExchangeResult) => void;
  const onAutoExchange = jest.fn(
    (_c: Community, _code: string, hooks?: CircuitHooks) =>
      new Promise<ExchangeResult>(resolve => {
        capturedHooks = hooks;
        resolveExchange = resolve;
      }),
  );
  let tree!: renderer.ReactTestRenderer;
  const render = act(async () => {
    tree = renderer.create(
      <ConnectingStep
        community={community()}
        inviteCode="STIQ-ABCD-2345-MNPQ"
        connection="connected"
        onAutoExchange={onAutoExchange}
        onPrefetchCommunity={opts.onPrefetchCommunity}
        onSession={opts.onSession ?? (() => {})}
        onBackToCode={() => {}}
      />,
    );
    mounted.push(tree);
  });
  return {
    // A getter: `tree` is assigned inside the act() callback above, which the caller awaits via
    // `render` before touching it.
    get tree(): renderer.ReactTestRenderer { return tree; },
    hooks: () => capturedHooks,
    settleExchange: (r: ExchangeResult) => resolveExchange(r),
    render,
  };
}

describe('ConnectingStep — the four-rung ladder', () => {
  it('keeps "Exchanging keys" active through circuit-open; only the subtitle moves', async () => {
    const h = mount();
    await h.render;

    // phase is already 'exchange' (connection='connected' from mount). Only row 0 ("Starting Tor")
    // is done; row 1 is spinning.
    expect(checkmarkCount(h.tree)).toBe(1);
    expect(hasLine(h.tree, 'Connecting to your community…')).toBe(true);

    // The credential socket's onOpen lands — the real proof the circuit reached the community relay.
    // It refines the SUBTITLE and nothing else: the key exchange itself has not returned yet, so the
    // row must still be spinning.
    act(() => { h.hooks()?.onCircuitOpen?.(); });

    expect(checkmarkCount(h.tree)).toBe(1);
    expect(hasLine(h.tree, 'Verifying your request code…')).toBe(true);

    await act(async () => {
      h.settleExchange({ok: false, error: 'stop'});
      await Promise.resolve();
    });
  });

  it('holds at "Getting your community ready" while the prefetch runs, then completes all four', async () => {
    let finishPrefetch!: () => void;
    const onPrefetchCommunity = jest.fn(
      () => new Promise<boolean>(resolve => { finishPrefetch = () => resolve(true); }),
    );
    const onSession = jest.fn();
    const h = mount({onPrefetchCommunity, onSession});
    await h.render;

    await act(async () => {
      h.settleExchange({ok: true, session: SESSION});
      await Promise.resolve();
    });

    // Rows 0 and 1 are done; row 2 (the prefetch) is the one spinning. Crucially the step has NOT
    // handed the session on — the whole point is that the member leaves this screen with a warm app.
    expect(onPrefetchCommunity).toHaveBeenCalledTimes(1);
    expect(checkmarkCount(h.tree)).toBe(2);
    expect(hasLine(h.tree, 'Getting your community ready…')).toBe(true);
    expect(onSession).not.toHaveBeenCalled();

    await act(async () => {
      finishPrefetch();
      await Promise.resolve();
    });

    expect(checkmarkCount(h.tree)).toBe(4);
    expect(hasLine(h.tree, "You're in")).toBe(true);
  });

  it('advances anyway when the prefetch rejects — a failed download never costs the credential', async () => {
    const onPrefetchCommunity = jest.fn(() => Promise.reject(new Error('relay went away')));
    const h = mount({onPrefetchCommunity});
    await h.render;

    await act(async () => {
      h.settleExchange({ok: true, session: SESSION});
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(checkmarkCount(h.tree)).toBe(4);
    expect(hasLine(h.tree, "You're in")).toBe(true);
  });

  it('skips the prefetch rung entirely when no handler is wired', async () => {
    const h = mount();
    await h.render;

    await act(async () => {
      h.settleExchange({ok: true, session: SESSION});
      await Promise.resolve();
    });

    expect(checkmarkCount(h.tree)).toBe(4);
  });
});

describe('classifyExchangeFailure', () => {
  it('buckets as "relay" when the circuit never opened, regardless of the error text', () => {
    const result = classifyExchangeFailure(
      {ok: false, error: 'relay rejected the enrollment request: not accepted'},
      false,
    );
    expect(result.kind).toBe('relay');
    expect(result.message).toContain("couldn't reach your community's relay");
  });

  it('buckets as "auth" once the circuit opened but the invite itself was rejected', () => {
    const result = classifyExchangeFailure(
      {ok: false, error: 'relay rejected the enrollment request: invite already used'},
      true,
    );
    expect(result.kind).toBe('auth');
    expect(result.message).toContain("wasn't accepted");
  });

  it('buckets as "relay" for a generic post-circuit-open failure, keeping the raw error', () => {
    const result = classifyExchangeFailure({ok: false, error: 'boom'}, true);
    expect(result.kind).toBe('relay');
    expect(result.message).toBe('Connection failed: boom');
  });

  it('buckets a timeout as "relay" with the original timeout message', () => {
    const result = classifyExchangeFailure({ok: false, error: 'x', timedOut: true}, true);
    expect(result.kind).toBe('relay');
    expect(result.message).toBe("We couldn't reach your community over Tor in time.");
  });
});
