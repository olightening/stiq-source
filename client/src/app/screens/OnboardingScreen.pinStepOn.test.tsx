/**
 * OnboardingScreen — the wizard WITH its PIN step restored (PIN_LOCK_UI true).
 *
 * The mirror of OnboardingScreen.pinStep.test.tsx, and the proof of the ship-dark promise for bugs
 * 5+6 on the onboarding side: flipping ONE flag puts the PIN step back in its ORIGINAL POSITION
 * (identity → pin → done, four dots), with the chosen PIN reaching enrollment exactly as it did
 * before. That position matters — the step was gated at the identity→next transition, never ripped
 * out of a step array, so nothing had to be re-inserted anywhere for this to pass.
 *
 * Module-level jest.mock per the house pattern; requireActual is spread first so only PIN_LOCK_UI
 * differs. The helpers are copied from the mirror rather than shared, matching how every other screen
 * suite here carries its own textOf/press helpers (and because the two files need opposite configs).
 */
jest.mock('../../config', () => ({
  ...jest.requireActual('../../config'),
  PIN_LOCK_UI: true,
}));

const mockParseJoinCode = jest.fn();
jest.mock('../../onboarding/join', () => ({
  parseJoinCode: (...args: unknown[]) => mockParseJoinCode(...args),
}));

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import type {Community} from '../../onboarding/community';
import type {Session} from '../../onboarding/enrollment';
import type {Event} from 'nostr-tools/pure';
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

function pressExact(tree: renderer.ReactTestRenderer, label: string): void {
  const match = tree.root
    .findAll(n => typeof n.props?.onPress === 'function')
    .find(n => textOf(n).trim() === label);
  if (!match) throw new Error(`no pressable labelled "${label}"`);
  act(() => {
    match.props.onPress();
  });
}

function dotCount(tree: renderer.ReactTestRenderer): number {
  return tree.root.findAll(
    n =>
      typeof n.type === 'string' &&
      Array.isArray(n.props?.style) &&
      n.props.style[0]?.width === 7 &&
      n.props.style[0]?.height === 4,
  ).length;
}

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

  pressContaining(tree, 'I have a request code');
  pressContaining(tree, 'Connect');
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

describe('OnboardingScreen — PIN step restored', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    mockParseJoinCode.mockReset();
  });

  it('goes identity → PIN (its original slot), not straight to done', async () => {
    const tree = await driveToIdentityContinue(jest.fn());
    pressContaining(tree, 'Continue');
    expect(textOf(tree.root)).toContain('Choose your PIN');
    expect(textOf(tree.root)).not.toContain("You're in. 🎉");
    act(() => tree.unmount());
  });

  it('shows FOUR step dots again', async () => {
    const tree = await driveToIdentityContinue(jest.fn());
    expect(dotCount(tree)).toBe(4);
    act(() => tree.unmount());
  });

  it('carries the chosen PIN through set → confirm → done → enrollment', async () => {
    const onEnroll = jest.fn().mockResolvedValue(undefined);
    const tree = await driveToIdentityContinue(onEnroll);
    pressContaining(tree, 'Continue');

    for (const d of '1234') pressExact(tree, d); // set
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(textOf(tree.root)).toContain('Confirm your PIN');
    for (const d of '1234') pressExact(tree, d); // confirm
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(textOf(tree.root)).toContain("You're in. 🎉");

    await act(async () => {
      pressContaining(tree, 'Enter the community');
      await Promise.resolve();
    });
    // The real PIN — not '' — reaches enrollment, so AppRuntime.completeEnrollment's
    // `!isAddMode && standardPin` guard seals it exactly as it always has.
    expect(onEnroll).toHaveBeenCalledTimes(1);
    expect(onEnroll.mock.calls[0]![1]).toBe('1234');
    act(() => tree.unmount());
  });
});
