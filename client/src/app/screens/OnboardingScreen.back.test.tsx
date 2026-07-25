/**
 * Setup's hardware BACK contract (ui/back.tsx).
 *
 * THE GAP THIS CLOSES: this screen is a SIBLING of MainScreen in AppShell's `resolveScreen`, and the
 * app's only BackHandler used to live INSIDE MainScreen — so during signup the back key reached
 * nothing at all and fell straight through to "background the app", mid-enrolment, with no way to
 * correct a mistyped join code except to start over. The wizard is linear, so BACK now walks it one
 * step at a time, matching the ‹ arrow the code step already had.
 *
 * The suite drives the real chain (welcome → code → connecting → identity → done), the same way
 * OnboardingScreen.pinStep.test.tsx does, because the thing under test IS the chain.
 *
 * The LockScreen case at the bottom is the other half of the contract: there, BACK must do NOTHING
 * (so the OS default backgrounds the app) — a back key that dismissed the PIN prompt would be a
 * one-press bypass of the device lock.
 */
import 'react-native';
import React from 'react';
import {Alert, BackHandler} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import type {Community} from '../../onboarding/community';
import type {Session} from '../../onboarding/enrollment';
import type {Event} from 'nostr-tools/pure';
import {RootBackScope} from '../../ui/back';

const mockParseJoinCode = jest.fn();
jest.mock('../../onboarding/join', () => ({
  parseJoinCode: (...args: unknown[]) => mockParseJoinCode(...args),
}));

import {OnboardingScreen} from './OnboardingScreen';
import {LockScreen} from './LockScreen';

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
  act(() => match.props.onPress());
}

let handlers: Array<() => boolean> = [];
function spyBack(): () => boolean {
  handlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_e: string, cb: () => boolean) => {
    handlers.push(cb);
    return {remove: jest.fn()};
  }) as unknown as typeof BackHandler.addEventListener);
  return () => handlers[handlers.length - 1]!();
}

let live: renderer.ReactTestRenderer | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  // The code step parses on every render, so a return value must always exist; tests that care
  // override it.
  mockParseJoinCode.mockReturnValue({ok: false});
});
afterEach(() => {
  if (live) {
    const t = live;
    live = null;
    act(() => t.unmount());
  }
  jest.useRealTimers();
  mockParseJoinCode.mockReset();
  jest.restoreAllMocks();
});

/** welcome → code → connecting → identity, the same drive OnboardingScreen.pinStep.test.tsx uses. */
async function driveToIdentity(): Promise<renderer.ReactTestRenderer> {
  mockParseJoinCode.mockReturnValue({
    ok: true,
    join: {community: community(), inviteCode: 'STIQ-ABCD-2345-MNPQ'},
  });
  await act(async () => {
    live = renderer.create(
      <RootBackScope>
        <OnboardingScreen
          connection="connected"
          onEnroll={jest.fn().mockResolvedValue(undefined)}
          onAutoExchange={async () => ({ok: true, session: session()})}
        />
      </RootBackScope>,
    );
  });
  const tree = live!;
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

describe('OnboardingScreen — BACK walks the wizard one step at a time', () => {
  it('leaves the app on the FIRST screen (nothing to go back to)', async () => {
    const back = spyBack();
    await act(async () => {
      live = renderer.create(
        <RootBackScope>
          <OnboardingScreen connection="connected" onEnroll={jest.fn()} onAutoExchange={jest.fn()} />
        </RootBackScope>,
      );
    });
    expect(textOf(live!.root)).toContain('I have a request code'); // welcome

    // Unhandled → RN's default runs → MainActivity backgrounds the app (contract rule 4).
    let handled = true;
    act(() => { handled = back(); });
    expect(handled).toBe(false);
  });

  it('code → welcome', async () => {
    const back = spyBack();
    mockParseJoinCode.mockReturnValue({ok: false});
    await act(async () => {
      live = renderer.create(
        <RootBackScope>
          <OnboardingScreen connection="connected" onEnroll={jest.fn()} onAutoExchange={jest.fn()} />
        </RootBackScope>,
      );
    });
    pressContaining(live!, 'I have a request code');
    expect(textOf(live!.root)).not.toContain('I have a request code'); // on the code step

    let handled = false;
    act(() => { handled = back(); });
    expect(handled).toBe(true);
    expect(textOf(live!.root)).toContain('I have a request code'); // back on welcome
  });

  it('identity asks before discarding a completed exchange, and lands back on the code step', async () => {
    const back = spyBack();
    let buttons: Array<{style?: string; onPress?: () => void}> = [];
    jest.spyOn(Alert, 'alert').mockImplementation(((_t: string, _m?: string, b?: unknown) => {
      buttons = (b ?? []) as typeof buttons;
    }) as unknown as typeof Alert.alert);

    const tree = await driveToIdentity();
    expect(textOf(tree.root)).toContain('Make yourself recognizable'); // identity step

    act(() => { expect(back()).toBe(true); });
    // It ASKS rather than dropping the session on the floor — still on identity until answered.
    expect(textOf(tree.root)).toContain('Make yourself recognizable');

    act(() => buttons.find(x => x.style === 'destructive')!.onPress!());
    expect(textOf(tree.root)).not.toContain('Make yourself recognizable');
  });

  it('done → identity when the PIN step never ran (it is shipped dark)', async () => {
    const back = spyBack();
    const tree = await driveToIdentity();
    pressContaining(tree, 'Continue'); // identity → done (PIN_LOCK_UI is false by default)
    expect(textOf(tree.root)).toContain("You're in. 🎉");

    act(() => { expect(back()).toBe(true); });
    expect(textOf(tree.root)).toContain('Make yourself recognizable');
  });
});

describe('LockScreen — BACK never bypasses the PIN', () => {
  it('registers nothing, so the press falls through and the app backgrounds', () => {
    const back = spyBack();
    act(() => {
      live = renderer.create(
        <RootBackScope>
          <LockScreen onSubmitPin={jest.fn()} />
        </RootBackScope>,
      );
    });

    let handled = true;
    act(() => { handled = back(); });
    expect(handled).toBe(false);
  });
});
