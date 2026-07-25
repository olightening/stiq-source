import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import * as nip19 from 'nostr-tools/nip19';
import {ModeratorConsole} from './ModeratorConsole';
import {GradientDot} from '../../ui/GradientDot';
import type {PendingReport} from '../queue';
import type {LoggedAuthor} from '../advisory';

// B9: gradient seeds must be npub-encoded everywhere (feed/profile/DM/channel posts all seed with
// the npub string) — a raw hex pubkey seed hashes to a DIFFERENT gradient than the npub form, so
// the same user rendered a different colour in the moderator console than everywhere else.
const ALICE = 'a'.repeat(64);
const TARGET_ID = 'd'.repeat(64); // a valid-hex event id, used as the seed fallback when authorPubkey is unknown
const BOB = 'b'.repeat(64);

function render(el: React.ReactElement): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(el);
  });
  return tree!;
}

function dotSeeds(tree: renderer.ReactTestRenderer): unknown[] {
  return tree.root.findAllByType(GradientDot).map(n => n.props.seed);
}

/** All plain-string text rendered under a node (avoids JSON.stringify on a live fiber tree). */
function textUnder(node: renderer.ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

describe('ModeratorConsole gradient seeds (B9)', () => {
  it('npub-encodes a report row seed when authorPubkey is known', () => {
    const reports: PendingReport[] = [{
      targetId: 't'.repeat(64),
      targetType: 'post',
      authorPubkey: ALICE,
      snippet: 'hello',
      reporterCount: 1,
      reasons: [],
      notes: [],
      latestAt: 100,
      thresholdReached: false,
    }];
    const tree = render(
      <ModeratorConsole
        visible
        onClose={jest.fn()}
        scopes={['hide-post', 'ban']}
        reports={reports}
        bans={[]}
        loggedAuthors={[]}
        onLogAuthor={jest.fn()}
        onLogPost={jest.fn()}
        onRestoreAuthor={jest.fn()}
        onUnban={jest.fn()}
      />,
    );
    const seeds = dotSeeds(tree);
    expect(seeds).toContain(nip19.npubEncode(ALICE));
    expect(seeds).not.toContain(ALICE);
  });

  it('falls back to the (still hex) targetId, npub-encoded, when authorPubkey is unknown', () => {
    const reports: PendingReport[] = [{
      targetId: TARGET_ID,
      targetType: 'post',
      authorPubkey: undefined,
      snippet: 'hello',
      reporterCount: 1,
      reasons: [],
      notes: [],
      latestAt: 100,
      thresholdReached: false,
    }];
    const tree = render(
      <ModeratorConsole
        visible
        onClose={jest.fn()}
        scopes={['hide-post']}
        reports={reports}
        bans={[]}
        loggedAuthors={[]}
        onLogAuthor={jest.fn()}
        onLogPost={jest.fn()}
        onRestoreAuthor={jest.fn()}
        onUnban={jest.fn()}
      />,
    );
    const seeds = dotSeeds(tree);
    expect(seeds).toContain(nip19.npubEncode(TARGET_ID));
    expect(seeds).not.toContain(TARGET_ID);
  });

  it('npub-encodes a logged-author row seed', () => {
    const loggedAuthors: LoggedAuthor[] = [{pubkey: BOB, since: 100, moderatorPubkey: ALICE}];
    const tree = render(
      <ModeratorConsole
        visible
        onClose={jest.fn()}
        scopes={['ban']}
        reports={[]}
        bans={[]}
        loggedAuthors={loggedAuthors}
        onLogAuthor={jest.fn()}
        onLogPost={jest.fn()}
        onRestoreAuthor={jest.fn()}
        onUnban={jest.fn()}
      />,
    );
    // Switch to the "Logged" tab to render the row.
    const logButton = tree.root.findAll(n => typeof n.props.onPress === 'function' && textUnder(n).includes('Logged'))[0];
    act(() => { logButton?.props.onPress(); });
    const seeds = dotSeeds(tree);
    expect(seeds).toContain(nip19.npubEncode(BOB));
    expect(seeds).not.toContain(BOB);
  });
});
