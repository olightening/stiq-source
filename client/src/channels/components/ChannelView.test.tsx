import 'react-native';
import React from 'react';
import {FlatList, TextInput} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {ChannelView} from './ChannelView';
import * as displayName from '../../profile/displayName';
import {saveChannelEmbed, removeEmbed} from '../savedEmbeds';
import {GradientAvatar} from '../../ui/GradientAvatar';
import type {Event} from 'nostr-tools/pure';
import {ComposerScreen} from '../../feed/components/ComposerScreen';
import {BroadcastCard} from './BroadcastCard';
import {DraftStore, inProgressDraftId, type DraftLocation} from '../../feed/drafts';
import {InMemorySecureStorage} from '../../keys/keystore';

const OWNER = 'a'.repeat(64);
const ADMIN = 'b'.repeat(64);
const channel = {id: 'c1', owner: OWNER, name: 'Dispatch', about: 'updates'};
const messages: Event[] = [
  {id: 'm1', pubkey: OWNER, created_at: 1, kind: 42, tags: [], content: 'first broadcast', sig: 's'},
  {id: 'm2', pubkey: OWNER, created_at: 2, kind: 42, tags: [], content: 'second broadcast', sig: 's'},
];

// GradientAvatar is React.memo'd with the default (null) comparator, so React collapses it to a
// "simple memo component" whose fiber `.type` is the INNER render function, not the outer memo()
// wrapper object — findAllByType(GradientAvatar) would never match. Compare against the inner
// function instead (same pattern as GroupView.test.tsx / MessageFooter.test.tsx).
const gradientAvatarInner = (GradientAvatar as unknown as {type: React.ComponentType}).type;
function findAvatars(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(n => n.type === gradientAvatarInner);
}

/** All string children rendered anywhere in the tree, concatenated. */
function allText(tree: renderer.ReactTestRenderer): string {
  return tree.root
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

it('renders channel header, messages, and the owner composer', () => {
  const sent: string[] = [];
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ChannelView channel={channel} messages={messages} isOwner onBroadcast={t => { sent.push(t); }} />,
    );
  });

  const text = JSON.stringify(tree!.toJSON());
  expect(text).toContain('Dispatch');
  expect(text).toContain('first broadcast');

  const broadcast = tree!.root.findAll(n => n.props.accessibilityLabel === 'broadcast')[0]!;
  expect(broadcast).toBeDefined(); // owner sees the composer
});

it('anchors the broadcast list with maintainVisibleContentPosition so a new broadcast cannot yank a reader scrolled into history', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ChannelView channel={channel} messages={messages} isOwner onBroadcast={() => undefined} />,
    );
  });
  const list = tree!.root.findAllByType(FlatList)[0]!;
  expect(list.props.maintainVisibleContentPosition).toEqual({minIndexForVisible: 0});
});

it('does NOT pair removeClippedSubviews with maintainVisibleContentPosition (they fight over the same native child list)', () => {
  // On Android, removeClippedSubviews detaches off-screen child views from the same ScrollView
  // content ViewGroup that MaintainVisibleScrollPositionHelper walks by index to find/track its
  // anchor (see ThreadView.test.tsx's identical guard) — a view clipped away mid-update can vanish
  // out from under the tracked anchor. This list has never carried removeClippedSubviews; this pins
  // that so it can't be added later without also re-litigating the interaction.
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ChannelView channel={channel} messages={messages} isOwner onBroadcast={() => undefined} />,
    );
  });
  const list = tree!.root.findAllByType(FlatList)[0]!;
  expect(list.props.removeClippedSubviews).not.toBe(true);
});

it('the initial-scroll onContentSizeChange never force-scrolls — it only flips a settle flag', () => {
  // GroupView was caught calling scrollToEnd() unconditionally on every onContentSizeChange, which
  // fires on ANY content-size change (not just a new broadcast — an image/gradient settling its
  // height too), defeating maintainVisibleContentPosition for a reader scrolled into history. This
  // pins that ChannelView's own onContentSizeChange never regresses to that pattern: it only flips
  // `initialScrollDone`, with no imperative scroll call at all.
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ChannelView channel={channel} messages={messages} isOwner onBroadcast={() => undefined} />,
    );
  });
  const list = tree!.root.findAllByType(FlatList)[0]!;
  const scrollToEnd = jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => {});
  act(() => { (list.props.onContentSizeChange as () => void)(); });
  expect(scrollToEnd).not.toHaveBeenCalled();
  scrollToEnd.mockRestore();
});

it('isolates composer keystrokes — typing a broadcast does NOT re-render the memoized cards', () => {
  // decodeNameHeader runs once per broadcast card body on render. renderItem is stabilized with
  // useCallback (draft is NOT a dep), so a keystroke must not churn the React.memo'd BroadcastCards.
  const spy = jest.spyOn(displayName, 'decodeNameHeader');
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ChannelView channel={channel} messages={messages} isOwner onBroadcast={() => undefined} />,
    );
  });
  const baseline = spy.mock.calls.length;
  expect(baseline).toBeGreaterThan(0); // the two cards decoded their bodies on mount

  const input = tree!.root
    .findAllByType(TextInput)
    .find(i => i.props.placeholder === 'Broadcast a message…');
  expect(input).toBeDefined();
  act(() => { input!.props.onChangeText('h'); });
  act(() => { input!.props.onChangeText('hi'); });

  // No card re-decoded → the visible BroadcastCards did not re-render on the keystrokes.
  expect(spy.mock.calls.length).toBe(baseline);
  spy.mockRestore();
});

it('shows the relay rejection reason under the failed pill when sendReasons is provided', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ChannelView
        channel={channel}
        messages={messages}
        isOwner
        onBroadcast={() => undefined}
        sendStatus={new Map([['m1', 'failed']])}
        sendReasons={new Map([['m1', 'blocked: rejected']])}
      />,
    );
  });
  const text = JSON.stringify(tree!.toJSON());
  expect(text).toContain('failed');
  expect(text).toContain('blocked: rejected');
});

describe('onLoadOlder pagination hook (B3)', () => {
  function findFeedList(tree: renderer.ReactTestRenderer) {
    return tree.root.findAll(n => typeof n.props.onEndReached === 'function' && Array.isArray(n.props.data))[0]!;
  }

  it('fires onLoadOlder when the list reaches its end', () => {
    const onLoadOlder = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ChannelView channel={channel} messages={messages} isOwner onBroadcast={() => undefined} onLoadOlder={onLoadOlder} />,
      );
    });
    act(() => { findFeedList(tree!).props.onEndReached(); });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('does not refire for the same message set within the debounce window', () => {
    const onLoadOlder = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ChannelView channel={channel} messages={messages} isOwner onBroadcast={() => undefined} onLoadOlder={onLoadOlder} />,
      );
    });
    act(() => { findFeedList(tree!).props.onEndReached(); });
    act(() => { findFeedList(tree!).props.onEndReached(); });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('is allowed to refire once the message count has grown (a page landed)', () => {
    const onLoadOlder = jest.fn();
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ChannelView channel={channel} messages={messages} isOwner onBroadcast={() => undefined} onLoadOlder={onLoadOlder} />,
      );
    });
    act(() => { findFeedList(tree!).props.onEndReached(); });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    const grown = [
      {id: 'm0', pubkey: 'a'.repeat(64), created_at: 0, kind: 42, tags: [], content: 'older broadcast', sig: 's'} as Event,
      ...messages,
    ];
    act(() => {
      tree!.update(
        <ChannelView channel={channel} messages={grown} isOwner onBroadcast={() => undefined} onLoadOlder={onLoadOlder} />,
      );
    });
    act(() => { findFeedList(tree!).props.onEndReached(); });
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });
});

// CHUNK 5: a saved SPACE embed (channel/private group) must show up in the composer's "SAVED · TAP
// TO EMBED" picker as a channel-card row (label + name, no post snippet) and insert the stiq:space:…
// token verbatim — never an nostr:nevent… link, which would silently drop the carried name.
describe('saved CHANNEL embed picker (stiq:space token, not nevent)', () => {
  /** Walk UP from a matching title Text node to the nearest onPress ancestor (see FullMessageEditor
   *  savedEmbeds tests for why searching top-down from every onPress node picks the sheet backdrop
   *  instead of the row). */
  function pressRow(tree: renderer.ReactTestRenderer, title: string): void {
    const textNode = tree.root.findAll(n => (n.type as unknown) === 'Text' && n.props.children === title)[0];
    if (!textNode) throw new Error(`no saved row titled "${title}"`);
    let node: typeof textNode | null = textNode.parent;
    while (node && typeof node.props?.onPress !== 'function') node = node.parent;
    if (!node) throw new Error(`no pressable ancestor for "${title}"`);
    act(() => { node!.props.onPress(); });
  }

  afterEach(async () => {
    await removeEmbed(`30311:${'f'.repeat(64)}:general`);
  });

  it('renders a CHANNEL row and appends the stiq:space token (not nevent) to the draft', async () => {
    const owner = 'f'.repeat(64);
    await saveChannelEmbed({id: `30311:${owner}:general`, owner, name: 'General Chat'}, 1);

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <ChannelView channel={channel} messages={messages} isOwner onBroadcast={() => undefined} />,
      );
    });

    // `+` → "Embed a post" opens ChannelView's own SAVED · TAP TO EMBED sheet.
    act(() => { tree!.root.findAll(n => n.props.accessibilityLabel === 'composer-add')[0]!.props.onPress(); });
    act(() => { tree!.root.findAll(n => n.props.accessibilityLabel === 'composer-add-Embed a post')[0]!.props.onPress(); });

    const text = JSON.stringify(tree!.toJSON());
    expect(text).toContain('CHANNEL');
    expect(text).toContain('General Chat');

    pressRow(tree!, 'General Chat');

    const input = tree!.root.findAllByType(TextInput).find(i => i.props.placeholder === 'Broadcast a message…');
    const value = input!.props.value as string;
    expect(value.startsWith('stiq:space:')).toBe(true);
    expect(value).not.toContain('nevent');
  });
});

// Open-community card parity (2700b1a template, applied to public channels): an open-community
// channel post must render IDENTICAL to an owner-voiced public channel post (no per-message author
// header, no ADMIN badge) with exactly ONE addition — a clickable footer author gradient circle.
// The old "🌐 Open · anyone can join · N admin(s)" banner strip is gone too (the header's subtitle
// already carries "Open community · …").
describe('open-community card parity (no open banner; footer author circle is the one addition)', () => {
  const openChannel = {id: 'c2', owner: OWNER, name: 'Town Square', about: 'the commons', admins: [ADMIN], openCommunity: true};
  const openMessages: Event[] = [
    {id: 'm1', pubkey: ADMIN, created_at: 1, kind: 42, tags: [], content: 'hello everyone', sig: 's'},
  ];

  function renderOpen(extra: Record<string, unknown> = {}) {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ChannelView channel={openChannel} messages={openMessages} isOwner={false} onBroadcast={() => undefined} {...extra} />,
      );
    });
    return tree!;
  }

  it('renders no "Open · anyone can join" banner text and no "ADMIN" badge', () => {
    const text = allText(renderOpen());
    expect(text).not.toContain('anyone can join');
    expect(text).not.toContain('ADMIN');
  });

  it('renders no per-message author-header row (showAuthor is false)', () => {
    const tree = renderOpen();
    // AuthorHeader's avatar renders at ctAvatar.cardAuthor (22dp); an open-community post must show
    // none — showAuthor is now false, matching non-open public channel cards.
    expect(findAvatars(tree).some(n => n.props.size === 22)).toBe(false);
  });

  it('carries the footer author-avatar circle (18dp, shape="circle"), seeded from the message author', () => {
    const tree = renderOpen();
    const footerAvatar = findAvatars(tree).find(n => n.props.shape === 'circle' && n.props.size === 18);
    expect(footerAvatar).toBeDefined();
  });

  it('the footer author-avatar tap calls onOpenAuthor with the message author\'s pubkey', () => {
    const onOpenAuthor = jest.fn();
    const tree = renderOpen({onOpenAuthor});
    const authorPressable = tree.root.findAll(n => n.props.accessibilityLabel === 'Author')[0];
    expect(authorPressable).toBeDefined();
    act(() => { authorPressable!.props.onPress(); });
    expect(onOpenAuthor).toHaveBeenCalledWith(ADMIN);
  });

  it('renders no "Author" pressable when onOpenAuthor is not provided (avatar stays a plain, non-tappable circle)', () => {
    const tree = renderOpen({onOpenAuthor: undefined});
    expect(tree.root.findAll(n => n.props.accessibilityLabel === 'Author')).toHaveLength(0);
    // The avatar itself still renders — just without a Pressable wrapper.
    expect(findAvatars(tree).some(n => n.props.shape === 'circle' && n.props.size === 18)).toBe(true);
  });

  it('a NON-open (owner-voiced) channel renders no footer author avatar — byte-identical to before', () => {
    // `channel`/`messages` (module-level) are the owner-voiced, non-open fixtures used throughout
    // this file.
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ChannelView channel={channel} messages={messages} isOwner onBroadcast={() => undefined} />,
      );
    });
    expect(findAvatars(tree!).some(n => n.props.shape === 'circle' && n.props.size === 18)).toBe(false);
    expect(tree!.root.findAll(n => n.props.accessibilityLabel === 'Author')).toHaveLength(0);
  });
});

// Phase 4 (draft-editor-overhaul): the full editor (ComposerScreen, opened by the composer's ⤢
// expand button) is now a real DraftStore participant for this channel's location — it self-persists
// (autosave/long-press/delete-on-send) into the SAME single per-channel slot the compact
// ChannelComposer's own keystrokes already write to (useInProgressDraft), keyed by the stable
// inProgressDraftId. These pin the wiring end-to-end: a draft saved under that id hydrates the
// compact composer on mount (the resume() surface actually shows the resumed text), the editor
// receives the matching draftStore/draftLocation props, and both are withheld while editing an
// EXISTING broadcast (the slot is for the next NEW broadcast only).
describe('Phase 4 — location-tagged in-progress drafts', () => {
  const loc: DraftLocation = {kind: 'channel', channelId: channel.id, channelType: 'public', channelName: channel.name};

  it('hydrates the compact composer from a persisted per-channel draft on mount (resume() end-to-end)', async () => {
    const store = new DraftStore(new InMemorySecureStorage());
    await store.save({id: inProgressDraftId(loc), title: '', content: 'resumed broadcast text', tags: [], savedAt: Date.now(), location: loc});

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <ChannelView channel={channel} messages={messages} isOwner onBroadcast={() => undefined} draftStore={store} />,
      );
    });
    // Let the mount-time slot.load() promise resolve.
    // eslint-disable-next-line @typescript-eslint/require-await
    await act(async () => undefined);

    const input = tree!.root.findAllByType(TextInput).find(i => i.props.placeholder === 'Broadcast a message…');
    expect(input!.props.value).toBe('resumed broadcast text');
  });

  it('passes draftStore + draftLocation into the full editor so it can self-persist', () => {
    const store = new DraftStore(new InMemorySecureStorage());
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ChannelView channel={channel} messages={messages} isOwner onBroadcast={() => undefined} draftStore={store} />,
      );
    });
    const composer = tree!.root.findByType(ComposerScreen);
    expect(composer.props.draftStore).toBe(store);
    expect(composer.props.draftLocation).toEqual(loc);
  });

  it('withholds draftStore/draftLocation from the full editor while editing an EXISTING broadcast', () => {
    const store = new DraftStore(new InMemorySecureStorage());
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ChannelView
          channel={channel}
          messages={messages}
          isOwner
          onBroadcast={() => undefined}
          onEditMessage={() => undefined}
          draftStore={store}
        />,
      );
    });
    act(() => { tree!.root.findAllByType(BroadcastCard)[0]!.props.onEdit!(); });
    const composer = tree!.root.findByType(ComposerScreen);
    expect(composer.props.draftStore).toBeUndefined();
    expect(composer.props.draftLocation).toBeUndefined();
  });
});

describe('stale-first empty state (Phase 5)', () => {
  it('suppresses "No broadcasts yet." while the scoped history fetch is still pending', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ChannelView channel={channel} messages={[]} historyPending isOwner={false} onBroadcast={() => undefined} />,
      );
    });
    expect(allText(tree!)).not.toContain('No broadcasts yet');
  });

  it('shows the genuine empty state once history has settled (and by default, prop omitted)', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ChannelView channel={channel} messages={[]} historyPending={false} isOwner={false} onBroadcast={() => undefined} />,
      );
    });
    expect(allText(tree!)).toContain('No broadcasts yet');

    let tree2: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree2 = renderer.create(
        <ChannelView channel={channel} messages={[]} isOwner={false} onBroadcast={() => undefined} />,
      );
    });
    expect(allText(tree2!)).toContain('No broadcasts yet');
  });

  it('historyPending never hides REAL messages — the stale-first rule only gates the empty claim', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ChannelView channel={channel} messages={messages} historyPending isOwner={false} onBroadcast={() => undefined} />,
      );
    });
    const text = allText(tree!);
    expect(text).toContain('first broadcast');
    expect(text).not.toContain('No broadcasts yet');
  });
});
