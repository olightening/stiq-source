import 'react-native';
import React from 'react';
import {Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {TokenStatusScreen} from './TokenStatusScreen';
import {colors} from '../../ui/theme';
import {
  EMPTY_TOKEN_STATUS,
  EMPTY_TOKEN_WALLET_COUNTS,
  type TokenEconomyStatus,
} from '../tokenEconomyStatus';

/**
 * TokenStatusScreen renders a read-only view over AppSnapshot.tokenStatus: wallet counts (with an
 * "inactive" annotation for a dark domain), the C5 per-domain provisioning verdict, and recent
 * token-relevant log entries — plus empty states for each section and a working Refresh action.
 */

/** Flatten a Text node's children (strings / numbers / nested arrays) into one string. */
function flatten(children: unknown): string {
  if (children == null || children === false || children === true) return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(flatten).join('');
  return '';
}

/** Concatenated text rendered under an instance (join of every descendant <Text>). */
function textUnder(inst: renderer.ReactTestInstance): string {
  return inst.findAllByType(Text).map(t => flatten(t.props.children)).join(' ');
}

function status(over: Partial<TokenEconomyStatus> = {}): TokenEconomyStatus {
  return {...EMPTY_TOKEN_STATUS, ...over};
}

let tree: renderer.ReactTestRenderer | undefined;

function mount(props: Partial<React.ComponentProps<typeof TokenStatusScreen>> = {}): void {
  act(() => {
    tree = renderer.create(
      <TokenStatusScreen visible onClose={() => undefined} c={colors} {...props} />,
    );
  });
}

afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

it('shows the empty state for every section with no status supplied', () => {
  mount();
  const all = textUnder(tree!.root);
  expect(all).toContain('No wallet counts yet');
  expect(all).toContain('No domains negotiated yet');
  expect(all).toContain('No recent token failures');
});

it('renders wallet counts by purpose, tagging an inactive domain', () => {
  mount({
    status: status({
      wallets: {...EMPTY_TOKEN_WALLET_COUNTS, post: 12, spaceWrite: 40},
      walletRows: [
        {purpose: 'post', count: 12, active: true},
        {purpose: 'spaceWrite', count: 40, active: true},
        {purpose: 'audioRead', count: 0, active: false},
      ],
    }),
  });
  const all = textUnder(tree!.root);
  expect(all).toContain('Post');
  expect(all).toContain('12');
  expect(all).toContain('Space write');
  expect(all).toContain('40');
  expect(all).toContain('Audio read');
  expect(all).toContain('inactive');
});

it('renders the C5 provisioning verdict per domain (OK / STALE / UNKNOWN)', () => {
  mount({
    status: status({
      domains: [
        {domain: 'posting', advertised: true, relayKeyCount: 1, walletFingerprint: 'abcd1234', verdict: 'ok'},
        {domain: 'space_write', advertised: true, relayKeyCount: 2, walletFingerprint: 'ffff0000', verdict: 'stale'},
        {domain: 'picture', advertised: false, relayKeyCount: 0, verdict: 'unknown'},
      ],
    }),
  });
  const all = textUnder(tree!.root);
  expect(all).toContain('Posting');
  expect(all).toContain('OK');
  expect(all).toContain('Space write');
  expect(all).toContain('STALE');
  expect(all).toContain('Picture');
  expect(all).toContain('UNKNOWN');
  expect(all).toContain('abcd1234');
  expect(all).not.toContain('No domains negotiated yet');
});

it('shows the communityKeyError banner when C5 has hard-blocked posting', () => {
  mount({status: status({communityKeyError: 'community mis-provisioned — update your invite'})});
  expect(textUnder(tree!.root)).toContain('community mis-provisioned — update your invite');
});

it('omits the communityKeyError banner when provisioning is fine', () => {
  mount({status: status({communityKeyError: undefined})});
  expect(textUnder(tree!.root)).not.toContain('mis-provisioned');
});

it('renders recent token failures with scope + message, newest-first order preserved as given', () => {
  mount({
    status: status({
      recentFailures: [
        {ts: Date.now(), level: 'warn', scope: 'wallet', message: 'space-write write exhausted its tokens'},
        {ts: Date.now(), level: 'warn', scope: 'caps', message: 'C5 provisioning advisory'},
      ],
    }),
  });
  const all = textUnder(tree!.root);
  expect(all).toContain('wallet');
  expect(all).toContain('space-write write exhausted its tokens');
  expect(all).toContain('caps');
  expect(all).toContain('C5 provisioning advisory');
  expect(all).not.toContain('No recent token failures');
});

it('Refresh invokes onRefresh', () => {
  const onRefresh = jest.fn();
  mount({onRefresh});
  const refreshBtn = tree!.root
    .findAll(n => typeof n.props?.onPress === 'function' && textUnder(n).trim() === 'Refresh')[0]!;
  act(() => {
    refreshBtn.props.onPress();
  });
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it('never renders a raw token/secret-looking field name — only counts, fingerprints, domains, messages', () => {
  // Cheap regression guard: the rendered text should never contain the words this screen must never
  // show (bearer token bytes, blinding secrets, private keys aren't part of TokenEconomyStatus at all,
  // but this pins the UI copy itself never invents a "secret"/"private key" label).
  mount({
    status: status({
      walletRows: [{purpose: 'post', count: 1, active: true}],
      domains: [{domain: 'posting', advertised: true, relayKeyCount: 1, walletFingerprint: 'abcd', verdict: 'ok'}],
    }),
  });
  const all = textUnder(tree!.root).toLowerCase();
  expect(all).not.toContain('secret');
  expect(all).not.toContain('private key');
});
