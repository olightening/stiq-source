/**
 * OnboardingScreen — v2 join-preview tests (relay mirror list + advisory-expiry note).
 *
 * `parseJoinCode` is mocked so these tests exercise the RENDER of a resolved v2 {@link Community}
 * (carrying `relays`/`advisoryExpiry`) without depending on the parser itself having landed v2
 * support — the render-side contract is `Community.relays` / `Community.advisoryExpiry` (see the
 * cross-stream contract in join.ts). Everything else about the code step (paste/connect/error) is
 * covered elsewhere; this file is scoped to the new preview affordances.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import type {Community} from '../../onboarding/community';

const mockParseJoinCode = jest.fn();
jest.mock('../../onboarding/join', () => ({
  parseJoinCode: (...args: unknown[]) => mockParseJoinCode(...args),
}));

// Imported after the jest.mock calls above on purpose: the mock must be registered before
// this module graph is pulled in. No eslint-disable here -- `import/first` comes from
// eslint-plugin-import, which this config does not load, so disabling it is itself an error.
import {OnboardingScreen} from './OnboardingScreen';

const ONION_A = `ws://${'a'.repeat(56)}.onion`;
const ONION_B = `ws://${'b'.repeat(56)}.onion`;
const NOW_SECONDS = Math.floor(Date.now() / 1000);

function communityWith(overrides: Partial<Community>): Community {
  return {relayUrl: ONION_A, issuerPublicKey: 'ISSUER', name: 'Acme', ...overrides};
}

/** Concatenated text under a node (react-test-renderer), matching the pattern used elsewhere. */
function textOf(node: renderer.ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c: unknown): c is string | number => typeof c === 'string' || typeof c === 'number')
    .map(String)
    .join('');
}

/** Mount OnboardingScreen and navigate straight to the code step, with parseJoinCode stubbed to
 *  resolve to `community` regardless of what's typed (only the preview render is under test). */
function renderCodeStep(community: Community): renderer.ReactTestRenderer {
  mockParseJoinCode.mockReturnValue({
    ok: true,
    join: {community, inviteCode: 'STIQ-ABCD-2345-MNPQ'},
  });
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<OnboardingScreen />);
  });
  const start = tree.root
    .findAll(n => typeof n.props?.onPress === 'function')
    .find(n => textOf(n).includes('I have a request code'));
  act(() => {
    start!.props.onPress();
  });
  return tree;
}

describe('OnboardingScreen join preview (v2)', () => {
  afterEach(() => {
    mockParseJoinCode.mockReset();
  });

  it('renders every mirror from community.relays', () => {
    const tree = renderCodeStep(
      communityWith({relays: [{url: ONION_A}, {url: ONION_B, onionAuthKey: null}]}),
    );
    const text = textOf(tree.root);
    expect(text).toContain('aaaaaaaa'); // shortOnion prefix of ONION_A's host
    expect(text).toContain('bbbbbbbb'); // shortOnion prefix of ONION_B's host
  });

  it('falls back to the single relayUrl when relays is absent (v1 code)', () => {
    const tree = renderCodeStep(communityWith({}));
    const text = textOf(tree.root);
    expect(text).toContain('aaaaaaaa');
    expect(text).not.toContain('bbbbbbbb');
  });

  it('shows a non-authoritative expired note when advisoryExpiry is in the past', () => {
    const tree = renderCodeStep(communityWith({advisoryExpiry: NOW_SECONDS - 3600}));
    expect(textOf(tree.root)).toContain('may have expired');
  });

  it('does not show the expired note for a future advisoryExpiry', () => {
    const tree = renderCodeStep(communityWith({advisoryExpiry: NOW_SECONDS + 3600}));
    expect(textOf(tree.root)).not.toContain('may have expired');
  });

  it('does not show the expired note when advisoryExpiry is absent (v1 code)', () => {
    const tree = renderCodeStep(communityWith({}));
    expect(textOf(tree.root)).not.toContain('may have expired');
  });
});
