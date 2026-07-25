/**
 * OnboardingScreen — the wizard WITHOUT its PIN step (PIN_LOCK_UI false, config.ts — the committed
 * default; bugs 5+6).
 *
 * Unlike the other OnboardingScreen suites, which exercise exported sub-steps in isolation, these
 * drive the whole welcome → code → connecting → identity → done chain, because the thing under test
 * IS the chain: the step count, the transition that used to land on the PIN step, the dot chrome
 * that indicates it, and — most of all — that a first-time member still comes out the far end
 * ENROLLED. `onAutoExchange` is stubbed to hand back a session (no Tor), and `parseJoinCode` is
 * mocked exactly as OnboardingScreen.test.tsx does.
 *
 * The mirror (OnboardingScreen.pinStepOn.test.tsx) drives the same chain with the flag on and finds
 * the PIN step back in its original position, proving the step was gated, not removed.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import type {Community} from '../../onboarding/community';
import type {Session} from '../../onboarding/enrollment';
import type {Event} from 'nostr-tools/pure';

const mockParseJoinCode = jest.fn();
jest.mock('../../onboarding/join', () => ({
  parseJoinCode: (...args: unknown[]) => mockParseJoinCode(...args),
}));

import {OnboardingScreen} from './OnboardingScreen';

jest.setTimeout(20000);

const ONION = `ws://${'a'.repeat(56)}.onion`;

function community(): Community {
  return {relayUrl: ONION, issuerPublicKey: 'ISSUER', organizerPubkey: 'org-pubkey', name: 'Acme'};
}

function session(): Session {
  return {
    secretKey: new Uint8Array(32),
    pubkey: 'b'.repeat(64),
    npub: `npub1${'q'.repeat(58)}`,
    relayUrl: ONION,
    issuerPublicKey: 'ISSUER',
    community: community(),
    credential: {token: new Uint8Array(4), signature: new Uint8Array(4)},
    bindingEvent: {} as Event,
  };
}

function textOf(node: renderer.ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c: unknown): c is string | number => typeof c === 'string' || typeof c === 'number')
    .map(String)
    .join('');
}

function pressContaining(tree: renderer.ReactTestRenderer, substr: string): void {
  const match = tree.root
    .findAll(n => typeof n.props?.onPress === 'function')
    .find(n => textOf(n).includes(substr));
  if (!match) throw new Error(`no pressable containing "${substr}"`);
  act(() => {
    match.props.onPress();
  });
}

/**
 * The chrome's step dots — the wizard's own "step N of M" indicator. Matched on the base `s.dot`
 * style (always style[0], with dotActive/dotDone layered after it), which StyleSheet.create resolves
 * to a plain object under the RN jest preset.
 */
function dotCount(tree: renderer.ReactTestRenderer): number {
  return tree.root.findAll(
    n =>
      typeof n.type === 'string' && // host nodes only — the composite View carries the same style
      Array.isArray(n.props?.style) &&
      n.props.style[0]?.width === 7 &&
      n.props.style[0]?.height === 4,
  ).length;
}

/**
 * Drive welcome → code → connecting → identity, stopping at whatever the identity step's Continue
 * lands on (the transition under test). `onEnroll` is returned so the caller can assert enrollment.
 */
async function driveToIdentityContinue(onEnroll: jest.Mock): Promise<renderer.ReactTestRenderer> {
  mockParseJoinCode.mockReturnValue({
    ok: true,
    join: {community: community(), inviteCode: 'STIQ-ABCD-2345-MNPQ'},
  });
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <OnboardingScreen
        connection="connected"
        onEnroll={onEnroll}
        onAutoExchange={async () => ({ok: true, session: session()})}
      />,
    );
  });

  pressContaining(tree, 'I have a request code'); // welcome → code
  pressContaining(tree, 'Connect'); // code → connecting

  // The connecting step checks its checklist off behind a 900ms timer before handing up the session.
  await act(async () => {
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
  });
  return tree;
}

describe('OnboardingScreen — PIN step shipped dark', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    mockParseJoinCode.mockReset();
  });

  it('goes identity → done, skipping the PIN step entirely', async () => {
    const onEnroll = jest.fn().mockResolvedValue(undefined);
    const tree = await driveToIdentityContinue(onEnroll);
    expect(textOf(tree.root)).toContain('Make yourself recognizable'); // precondition: identity step

    pressContaining(tree, 'Continue');

    expect(textOf(tree.root)).not.toContain('Choose your PIN');
    expect(textOf(tree.root)).toContain("You're in. 🎉"); // landed on Done
    act(() => tree.unmount());
  });

  it('shows THREE step dots, not four — the indicator matches the flow it indicates', async () => {
    const tree = await driveToIdentityContinue(jest.fn());
    expect(dotCount(tree)).toBe(3);
    act(() => tree.unmount());
  });

  it('completes enrollment end-to-end — a fresh member is never left half-enrolled', async () => {
    const onEnroll = jest.fn().mockResolvedValue(undefined);
    const tree = await driveToIdentityContinue(onEnroll);
    pressContaining(tree, 'Continue');
    await act(async () => {
      pressContaining(tree, 'Enter the community');
      await Promise.resolve();
    });

    expect(onEnroll).toHaveBeenCalledTimes(1);
    // The contract with AppRuntime.completeEnrollment: BOTH PINs empty = "no PIN chosen", which its
    // `!isAddMode && standardPin` guard reads as "seal nothing" rather than sealing an empty PIN as
    // this device's real unlock credential. The session/gradient/handle args are unaffected.
    const [gotSession, standardPin, duressPin, gradient] = onEnroll.mock.calls[0]!;
    expect(standardPin).toBe('');
    expect(duressPin).toBe('');
    expect(gotSession.npub).toBe(session().npub);
    expect(gradient).toBeDefined(); // the identity step's gradient still rides along
    act(() => tree.unmount());
  });

  it('never mounts a PinKeypad anywhere in the flow', async () => {
    const tree = await driveToIdentityContinue(jest.fn());
    pressContaining(tree, 'Continue');
    const text = textOf(tree.root);
    expect(text).not.toContain('Choose your PIN');
    expect(text).not.toContain('Confirm your PIN');
    expect(text).not.toContain('Stored only on this phone.');
    act(() => tree.unmount());
  });
});
