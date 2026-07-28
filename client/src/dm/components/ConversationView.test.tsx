import 'react-native';
import React from 'react';
import {FlatList, TextInput} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {getPublicKey, generateSecretKey} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {ConversationView} from './ConversationView';
import type {Conversation} from '../conversations';
import type {DirectMessage} from '../dm';
import * as displayName from '../../profile/displayName';
import {ChatBubble, QuotedReply, SwipeToReply, shortNpub} from '../../channels/components/primitives';
import {GradientAvatar} from '../../ui/GradientAvatar';
import type {GradientSpec} from '../../media/gradient';
import {saveChannelEmbed, removeEmbed} from '../../channels/savedEmbeds';
import {ComposerScreen} from '../../feed/components/ComposerScreen';
import {DraftStore, inProgressDraftId, type DraftLocation} from '../../feed/drafts';
import {InMemorySecureStorage} from '../../keys/keystore';

const self = getPublicKey(generateSecretKey());
const peer = getPublicKey(generateSecretKey());

function msg(id: string, sender: string, text: string, createdAt: number): DirectMessage {
  return {id, rumorId: `r${id}`, sender, text, createdAt};
}

/** A conversation (messages oldest-first, both directions) between the viewer and one peer. */
function conversation(): Conversation {
  const messages = [
    msg('1', peer, 'first from peer', 1),
    msg('2', self, 'my reply', 2),
    msg('3', peer, 'third from peer', 3),
    msg('4', self, 'another from me', 4),
  ];
  return {peer, peerNpub: nip19.npubEncode(peer), messages, lastAt: 4, preview: 'another from me'};
}

it('renders the transcript as a FlatList with a stable keyExtractor over message ids', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
    );
  });
  const lists = tree!.root.findAllByType(FlatList);
  expect(lists.length).toBe(1);
  const list = lists[0]!;
  // Inverted (newest pinned to the visual bottom) + keyed by the stable message id.
  expect(list.props.inverted).toBe(true);
  expect(typeof list.props.keyExtractor).toBe('function');
  expect(list.props.keyExtractor(msg('99', peer, 'x', 9))).toBe('99');
  // Data is newest-first for the inverted list (message 4 is the newest).
  expect(list.props.data.map((m: DirectMessage) => m.id)).toEqual(['4', '3', '2', '1']);
});

it('anchors the transcript with maintainVisibleContentPosition so an arriving DM cannot yank a reader scrolled into history', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
    );
  });
  const list = tree!.root.findAllByType(FlatList)[0]!;
  expect(list.props.maintainVisibleContentPosition).toEqual({minIndexForVisible: 0});
});

it('does NOT pair removeClippedSubviews with the inverted+maintainVisibleContentPosition transcript', () => {
  // On Android, removeClippedSubviews detaches off-screen child views from the same ScrollView
  // content ViewGroup that MaintainVisibleScrollPositionHelper walks by index to find/track its
  // anchor (see ThreadView.test.tsx's identical guard) — a view clipped away mid-update can vanish
  // out from under the tracked anchor, defeating the position-stability test above. This list has
  // never carried removeClippedSubviews; this pins that so it can't be added later without also
  // re-litigating the interaction.
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
    );
  });
  const list = tree!.root.findAllByType(FlatList)[0]!;
  expect(list.props.removeClippedSubviews).not.toBe(true);
});

it('minIndexForVisible: 0 is the config that keeps the anchor stable, not one that pins to the newest', () => {
  // `inverted` flips VISUAL top/bottom but not the underlying ScrollView's PHYSICAL child order:
  // index 0 of `data` (the newest message, see invertedData above) is still physical child 0, at
  // the physical top of the (pre-flip) content — same as a non-inverted list's index 0. A new
  // incoming message is prepended at that same index 0/physical-top, pushing every older, currently-
  // visible message down; minIndexForVisible: 0 lets MaintainVisibleScrollPositionHelper anchor on
  // whichever of those older messages the reader is actually looking at and compensate the scroll
  // offset by however far the insertion moved it — which is what keeps a reader scrolled UP into
  // history from being yanked. A larger minIndexForVisible would exclude low-index (newest) items
  // from ever serving as the anchor, which is backwards here: it's the OLD, already-visible items —
  // not the newest one — that must stay put.
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
    );
  });
  const list = tree!.root.findAllByType(FlatList)[0]!;
  expect(list.props.inverted).toBe(true);
  expect(list.props.maintainVisibleContentPosition.minIndexForVisible).toBe(0);
  // The newest message really is data[0] under the inversion — confirms the "physical top = index 0
  // = insertion point for a new arrival" premise above, not merely asserted but derived from data.
  expect(list.props.data[0].id).toBe('4');
});

it('renders every message body through the transcript', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
    );
  });
  const json = JSON.stringify(tree!.toJSON());
  expect(json).toContain('first from peer');
  expect(json).toContain('another from me');
});

// ── finding #dms: an ambiguous publish timeout now self-drives a bounded local resend instead of
//    going straight to 'failed' — the thread must keep showing the quiet '·' affordance while it
//    auto-retries, and only flip to the hard '✕' + Retry once the local ladder is exhausted. ──
describe("DmBubble delivery-status affordance ('sending' stays quiet, 'failed' shows ✕ + Retry)", () => {
  function conversationWithMyStatus(status: DirectMessage['status']): Conversation {
    const messages = [msg('1', peer, 'hi', 1), {...msg('2', self, 'my dm', 2), status}];
    return {peer, peerNpub: nip19.npubEncode(peer), messages, lastAt: 2, preview: 'my dm'};
  }

  it("an auto-retrying own message ('sending') renders the quiet dot, never the hard ✕ or a Retry link", () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ConversationView
          conversation={conversationWithMyStatus('sending')}
          selfPubkey={self}
          onSend={() => undefined}
          onRetry={() => undefined}
        />,
      );
    });
    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('·'); // the quiet queued affordance
    expect(json).not.toContain('✕');
    expect(json).not.toContain('Retry');
  });

  it("a ladder-exhausted own message ('failed') renders the hard ✕ and a Retry link", () => {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ConversationView
          conversation={conversationWithMyStatus('failed')}
          selfPubkey={self}
          onSend={() => undefined}
          onRetry={() => undefined}
        />,
      );
    });
    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('✕ failed');
    expect(json).toContain('Retry');
  });
});

it('isolates composer keystrokes — typing a draft does NOT re-render/re-parse the bubbles', async () => {
  // decodeNameHeader runs once per bubble body (and its quote) on render. If a composer keystroke
  // re-rendered the transcript, its call count would climb; with the draft isolated inside the
  // <Composer/> child and the rows memoized behind stable callbacks, it must stay flat.
  const spy = jest.spyOn(displayName, 'decodeNameHeader');
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
    );
  });
  // Let the mount settle (mute / saved-embeds / draft-restore effects resolve their promises).
  // eslint-disable-next-line @typescript-eslint/require-await
  await act(async () => undefined);
  const baseline = spy.mock.calls.length;

  // Find the composer input (placeholder "Message…") and type into it.
  const inputs = tree!.root.findAllByType(TextInput);
  const composer = inputs.find(i => i.props.placeholder === 'Message…');
  expect(composer).toBeDefined();
  act(() => {
    composer!.props.onChangeText('h');
  });
  act(() => {
    composer!.props.onChangeText('he');
  });
  act(() => {
    composer!.props.onChangeText('hey');
  });

  // No bubble re-decoded → the transcript did not re-render on the keystrokes.
  expect(spy.mock.calls.length).toBe(baseline);
  spy.mockRestore();
});

// ── No.13a: keyboardShouldPersistTaps ────────────────────────────────────────────────────────────

it('sets keyboardShouldPersistTaps="handled" on the transcript FlatList (No.13a)', () => {
  // RN's default 'never' makes the ScrollView capture every touch in the CAPTURE phase while the
  // keyboard is up, so SwipeToReply's PanResponder never even starts. 'handled' lets a row's own
  // responder claim the gesture first.
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
    );
  });
  const list = tree!.root.findAllByType(FlatList)[0]!;
  expect(list.props.keyboardShouldPersistTaps).toBe('handled');
});

// ── No.13b: focus-on-reply ───────────────────────────────────────────────────────────────────────

it('focuses the composer input when a swipe-to-reply begins (No.13b)', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
    );
  });

  // The composer's TextInput host instance is what MessageComposer's forwardRef exposes; spy on its
  // (mocked-native) `.focus` to stand in for "was the ref told to focus" without reaching into the
  // component's private `inputRef`.
  const composerInput = tree!.root.findAllByType(TextInput).find(i => i.props.placeholder === 'Message…')!;
  expect(composerInput).toBeDefined();
  expect(typeof (composerInput.instance as {focus?: unknown} | null)?.focus).toBe('function');
  const focusSpy = jest.spyOn(composerInput.instance as {focus: () => void}, 'focus');

  // Trigger swipe-to-reply directly via its onReply callback (mirrors how other tests here drive
  // the composer's onChangeText directly rather than simulating the raw gesture).
  const swipeRows = tree!.root.findAllByType(SwipeToReply);
  expect(swipeRows.length).toBeGreaterThan(0);
  act(() => {
    swipeRows[0]!.props.onReply();
  });

  expect(focusSpy).toHaveBeenCalled();
  focusSpy.mockRestore();
});

// ── No.9: live gradient lookup ───────────────────────────────────────────────────────────────────

it('calls getPeerGradient with the peer hex pubkey at render time and renders its result', () => {
  const liveGradient: GradientSpec = {type: 'linear', angle: 90, stops: ['#abcdef', '#123456']};
  const getPeerGradient = jest.fn((pubkeyHex: string) => (pubkeyHex === peer ? liveGradient : undefined));
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView
        conversation={conversation()}
        selfPubkey={self}
        onSend={() => undefined}
        getPeerGradient={getPeerGradient}
      />,
    );
  });
  expect(getPeerGradient).toHaveBeenCalledWith(peer);
  const json = JSON.stringify(tree!.toJSON()).toLowerCase();
  expect(json).toContain('#abcdef');
});

it('falls back to the npub-seed-derived gradient when getPeerGradient is absent (no static peerGradient fallback anymore)', () => {
  // The deprecated static `peerGradient` prop was removed once nothing in-repo passed it —
  // getPeerGradient is now the ONLY gradient source (besides GradientAvatar's own seed fallback).
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
    );
  });
  expect(tree!.toJSON()).not.toBeNull();
});

// ── No.10: "View profile" sheet row ──────────────────────────────────────────────────────────────

it('adds a "View profile" row to the DM detail sheet when onOpenProfile is provided, closes the sheet and calls it on press', () => {
  const onOpenProfile = jest.fn();
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView
        conversation={conversation()}
        selfPubkey={self}
        onSend={() => undefined}
        onOpenProfile={onOpenProfile}
      />,
    );
  });
  // Open the sheet (identity header press — same target as the ⋯ button).
  act(() => {
    tree!.root.findByProps({accessibilityLabel: 'open-dm-detail'}).props.onPress();
  });
  const row = tree!.root.findByProps({accessibilityLabel: 'view-profile'});
  act(() => {
    row.props.onPress();
  });
  expect(onOpenProfile).toHaveBeenCalledTimes(1);
});

it('hides the "View profile" row when onOpenProfile is not provided', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
    );
  });
  act(() => {
    tree!.root.findByProps({accessibilityLabel: 'open-dm-detail'}).props.onPress();
  });
  expect(() => tree!.root.findByProps({accessibilityLabel: 'view-profile'})).toThrow();
});

// ── Bug #3: per-message peer avatar must match the header/profile gradient ─────────────────────

it('threads the SAME peer gradient the header uses into every incoming ChatBubble as senderGradient/senderSeed', () => {
  const peerGradient: GradientSpec = {type: 'linear', angle: 90, stops: ['#abcdef', '#123456']};
  const getPeerGradient = jest.fn((pubkeyHex: string) => (pubkeyHex === peer ? peerGradient : undefined));
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView
        conversation={conversation()}
        selfPubkey={self}
        onSend={() => undefined}
        getPeerGradient={getPeerGradient}
      />,
    );
  });
  // The header avatar (identity row) uses this gradient — assert every INCOMING (theirs) bubble's
  // ChatBubble was handed the exact same gradient object, not a default/empty-seed fallback.
  const incoming = tree!.root.findAllByType(ChatBubble).filter(n => n.props.mine === false);
  expect(incoming.length).toBeGreaterThan(0);
  for (const bubble of incoming) {
    expect(bubble.props.senderGradient).toBe(peerGradient);
    expect(bubble.props.senderSeed).toBe(nip19.npubEncode(peer));
  }
  // Outgoing (mine) bubbles must NOT get the peer's gradient/seed (they render no avatar at all).
  const outgoing = tree!.root.findAllByType(ChatBubble).filter(n => n.props.mine === true);
  expect(outgoing.length).toBeGreaterThan(0);
  for (const bubble of outgoing) {
    expect(bubble.props.senderGradient).toBeUndefined();
    expect(bubble.props.senderSeed).toBeUndefined();
  }
});

it('renders the incoming bubble avatar with the peer gradient (GradientAvatar receives it, not a default)', () => {
  const peerGradient: GradientSpec = {type: 'linear', angle: 90, stops: ['#abcdef', '#123456']};
  const getPeerGradient = jest.fn((pubkeyHex: string) => (pubkeyHex === peer ? peerGradient : undefined));
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView
        conversation={conversation()}
        selfPubkey={self}
        onSend={() => undefined}
        getPeerGradient={getPeerGradient}
      />,
    );
  });
  // GradientAvatar is React.memo'd with the default (null) comparator, so React collapses it to a
  // "simple memo component" whose fiber `.type` is the INNER render function, not the outer memo()
  // wrapper object — findAllByType(GradientAvatar) would never match. Compare against the inner
  // function instead (same pattern as ChannelDetail.test.tsx / ChatBubble.test.tsx).
  const gradientAvatarInner = (GradientAvatar as unknown as {type: React.ComponentType}).type;
  const avatars = tree!.root
    .findAll(n => n.type === gradientAvatarInner)
    .filter(a => a.props.gradient === peerGradient);
  // At least the header avatar + one per-message bubble avatar must carry the real peer gradient.
  expect(avatars.length).toBeGreaterThan(1);
});

// ── Bug #2: swiping a second message while one is already the reply target ─────────────────────

/** The composer's own quoted-reply preview is the ONE QuotedReply rendered with an onClose (✕
 * cancel) handler — in-bubble parent-quotes never get one. */
function composerQuote(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance {
  const quotes = tree.root.findAllByType(QuotedReply).filter(q => typeof q.props.onClose === 'function');
  expect(quotes).toHaveLength(1);
  return quotes[0]!;
}

it('swiping message B while message A is the active reply target REPLACES A with B, and the composer preview updates', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
    );
  });
  // Inverted transcript renders newest-first: row 0 = "another from me" (mine), row 1 = "third
  // from peer" — two distinct messages from two different senders, easy to tell apart by quote text.
  const swipeRows = tree!.root.findAllByType(SwipeToReply);
  expect(swipeRows.length).toBe(4);

  // Swipe row A ("another from me") — begins a reply to it.
  act(() => {
    swipeRows[0]!.props.onReply();
  });
  expect(composerQuote(tree!).props.text).toBe('another from me');

  // Swipe a DIFFERENT row, B ("third from peer") — the latest swipe must win outright, replacing
  // A as the active reply target; it must NOT be ignored because a reply was already in progress.
  act(() => {
    swipeRows[1]!.props.onReply();
  });
  expect(composerQuote(tree!).props.text).toBe('third from peer');
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

  const owner = 'd'.repeat(64);

  afterEach(async () => {
    await removeEmbed(`30311:${owner}:general`);
  });

  it('renders a CHANNEL row and inserts the stiq:space token (not nevent) into the composer', async () => {
    await saveChannelEmbed({id: `30311:${owner}:general`, owner, name: 'General Chat'}, 1);

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} />,
      );
    });

    act(() => { tree!.root.findAll(n => n.props.accessibilityLabel === 'composer-add')[0]!.props.onPress(); });
    act(() => { tree!.root.findAll(n => n.props.accessibilityLabel === 'composer-add-Embed a post')[0]!.props.onPress(); });

    const json = JSON.stringify(tree!.toJSON());
    expect(json).toContain('CHANNEL');
    expect(json).toContain('General Chat');

    pressRow(tree!, 'General Chat');

    const composer = tree!.root.findAllByType(TextInput).find(i => i.props.placeholder === 'Message…');
    expect(composer!.props.value as string).toContain('stiq:space:');
    expect(composer!.props.value as string).not.toContain('nevent');
  });
});

// Phase 4 (draft-editor-overhaul): the full editor (ComposerScreen, opened by the composer's ⤢
// expand button) is now a real DraftStore participant for this DM peer's location — it self-persists
// (autosave/long-press/delete-on-send) into the SAME single per-peer slot the compact
// MessageComposer's own keystrokes already write to (useInProgressDraft), keyed by the stable
// inProgressDraftId. DMs have no edit mode, so unlike channels/groups there is no withholding case.
describe('Phase 4 — location-tagged in-progress drafts (DM)', () => {
  const loc: DraftLocation = {kind: 'channel', channelId: peer, channelType: 'dm', channelName: shortNpub(conversation().peerNpub)};

  it('hydrates the compact composer from a persisted per-peer draft on mount (resume() end-to-end)', async () => {
    const store = new DraftStore(new InMemorySecureStorage());
    await store.save({id: inProgressDraftId(loc), title: '', content: 'resumed dm draft', tags: [], savedAt: Date.now(), location: loc});

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} draftStore={store} />,
      );
    });
    // Let the mount-time slot.load() promise resolve.
    // eslint-disable-next-line @typescript-eslint/require-await
    await act(async () => undefined);

    const input = tree!.root.findAllByType(TextInput).find(i => i.props.placeholder === 'Message…');
    expect(input!.props.value).toBe('resumed dm draft');
  });

  it('passes draftStore + draftLocation into the full editor so it can self-persist', () => {
    const store = new DraftStore(new InMemorySecureStorage());
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ConversationView conversation={conversation()} selfPubkey={self} onSend={() => undefined} draftStore={store} />,
      );
    });
    const composer = tree!.root.findByType(ComposerScreen);
    expect(composer.props.draftStore).toBe(store);
    expect(composer.props.draftLocation).toEqual(loc);
  });
});
