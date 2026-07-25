import 'react-native';
import React from 'react';
import {Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {embedFromSpaceRef, embedFromSummary, embedFromDraftRef, RefEmbed} from './RefEmbed';
import type {SpaceRef} from '../../channels/spaceEmbed';
import type {NostrEventSummary} from '../../ui/NostrLinkPreview';
import type {DraftRef} from '../draftEmbed';

/**
 * Chunk 2 — embedFromSpaceRef (fully-offline `stiq:space:…` card mapping) and the SPACE_KINDS
 * branch in embedFromSummary (a resolved naddr pointing straight at a 30311/39000 metadata event,
 * distinct from CHANNEL_KINDS which is a MESSAGE posted inside a channel).
 */
describe('embedFromSpaceRef', () => {
  it('maps a public channel ref to a CHANNEL card with the "Open" hint and square shape', () => {
    const ref: SpaceRef = {
      kind: 30311, owner: 'a'.repeat(64), identifier: 'd', coordinate: `30311:${'a'.repeat(64)}:d`,
      name: 'General', private: false,
    };
    const view = embedFromSpaceRef(ref);
    expect(view.kind).toBe('CHANNEL');
    expect(view.title).toBe('General');
    expect(view.name).toBe('Open');
    expect(view.shape).toBe('square');
    expect(view.seed).toBe(ref.coordinate);
    expect(view.owner).toBe(ref.owner);
  });

  it('maps a private space ref to a PRIVATE SPACE card with the "Request to join" hint and hexagon shape', () => {
    const ref: SpaceRef = {
      kind: 39000, owner: 'b'.repeat(64), identifier: 'grp', coordinate: `39000:${'b'.repeat(64)}:grp`,
      private: true,
    };
    const view = embedFromSpaceRef(ref);
    expect(view.kind).toBe('PRIVATE SPACE');
    expect(view.title).toBe('Private space'); // no carried name -> generic fallback
    expect(view.name).toBe('Request to join');
    expect(view.shape).toBe('hexagon');
    expect(view.owner).toBe(ref.owner);
  });
});

describe('embedFromSummary SPACE_KINDS branch', () => {
  it('renders a resolved 30311 channel-definition summary as a CHANNEL card, not a generic post', () => {
    const summary: NostrEventSummary = {pubkey: 'c'.repeat(64), content: '', kind: 30311, title: 'Announcements'};
    const view = embedFromSummary(summary);
    expect(view).not.toBeNull();
    expect(view!.kind).toBe('CHANNEL');
    expect(view!.title).toBe('Announcements');
    expect(view!.shape).toBe('square');
  });

  it('renders a resolved 39000 group-definition summary as a PRIVATE SPACE card', () => {
    const summary: NostrEventSummary = {pubkey: 'd'.repeat(64), content: '', kind: 39000};
    const view = embedFromSummary(summary);
    expect(view).not.toBeNull();
    expect(view!.kind).toBe('PRIVATE SPACE');
    expect(view!.shape).toBe('hexagon');
  });

  it('leaves an ordinary channel MESSAGE (not a space definition) on the existing path', () => {
    // Kind.ChannelMessage lives in CHANNEL_KINDS, not SPACE_KINDS — must still read as
    // "Referenced channel post", unaffected by the new branch.
    const summary: NostrEventSummary = {pubkey: 'e'.repeat(64), content: 'hello', kind: 42};
    const view = embedFromSummary(summary);
    expect(view).not.toBeNull();
    expect(view!.kind).toBe('Referenced channel post');
  });
});

/**
 * A referenced COMMENT is identity-forward: the commenter's gradient + display name lead the card
 * (the same treatment a shared draft gets). The bug this pins: the card used to print the author in
 * BOTH the title line and the bottom "by" row — and, because AppRuntime.getEvent attributed to the
 * raw signer rather than the resolved author, both lines read as a throwaway npub with a gradient
 * seeded from a key nobody owns.
 */
describe('embedFromSummary comment branch — identity-forward', () => {
  const gradient = {type: 'linear' as const, angle: 135, stops: ['#ff0000', '#0000ff']};
  const commentSummary: NostrEventSummary = {
    pubkey: 'f'.repeat(64),
    kind: 1111,
    content: 'I think the epoch rotation should be organizer-driven.',
    name: 'Alice',
    rootTitle: 'How we handle keys',
    gradient,
  };

  it('leads with the commenter and carries their gradient; the body becomes the card content', () => {
    const view = embedFromSummary(commentSummary)!;
    expect(view.variant).toBe('identityForward');
    expect(view.identityLabel).toBe('Comment');
    expect(view.name).toBe('Alice');
    expect(view.gradient).toBe(gradient);
    expect(view.seed).toBe(commentSummary.pubkey);
    expect(view.where).toBe('How we handle keys');
    expect(view.title).toBe(commentSummary.content); // the comment's own words, not the author again
  });

  it('renders the author ONCE (identity row), above the thread line and the body', () => {
    const view = embedFromSummary(commentSummary)!;
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<RefEmbed view={view} />); });

    const texts = tree.root.findAll(n => n.type === Text).map(n => n.props.children).flat();
    expect(texts.filter(t => t === 'Alice')).toHaveLength(1); // no title/by-row stutter
    expect(texts.indexOf('Alice')).toBeLessThan(texts.indexOf(' · Comment'));
    expect(texts.indexOf(' · Comment')).toBeLessThan(texts.indexOf('in How we handle keys'));
    expect(texts.indexOf('in How we handle keys')).toBeLessThan(texts.indexOf(commentSummary.content));
    expect(texts).not.toContain('REFERENCED COMMENT'); // the identity row replaces the eyebrow
  });

  it('passes the resolved gradient (not just a seed) to the avatar', () => {
    const view = embedFromSummary(commentSummary)!;
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<RefEmbed view={view} />); });
    const avatar = tree.root.findAll(n => n.props?.accessibilityLabel === 'identity gradient')[0];
    expect(avatar).toBeDefined();
  });

  it('falls back to a short npub when the author has no known display name', () => {
    const view = embedFromSummary({...commentSummary, name: undefined})!;
    expect(view.name).toMatch(/^npub1/);
  });
});

describe('RefEmbed rendering (spoof-hardening: owner npub + title clamp)', () => {
  it('renders an owner npub line for a SPACE card view (distinguishes a spoof from the real space)', () => {
    const owner = 'a'.repeat(64);
    const ref: SpaceRef = {kind: 30311, owner, identifier: 'd', coordinate: `30311:${owner}:d`, name: 'General', private: false};
    const view = embedFromSpaceRef(ref);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RefEmbed view={view} />);
    });
    const text = tree.root.findAll(n => n.type === Text).map(n => n.props.children).flat().join(' | ');
    expect(text).toMatch(/by npub1/);
  });

  it('clamps the title Text to 2 lines so an over-long/hostile title cannot push the card open-ended', () => {
    const ref: SpaceRef = {
      kind: 30311, owner: 'a'.repeat(64), identifier: 'd', coordinate: `30311:${'a'.repeat(64)}:d`,
      name: 'General', private: false,
    };
    const view = embedFromSpaceRef(ref);
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RefEmbed view={view} />);
    });
    const titleNode = tree.root.findAll(n => n.type === Text && n.props.children === view.title)[0];
    expect(titleNode!.props.numberOfLines).toBe(2);
  });
});

/**
 * Phase 6 — embedFromDraftRef's `'identityForward'` variant: an identified draft leads with
 * `[GradientAvatar] · {name} · Draft` at the TOP instead of the generic eyebrow-first / author-last
 * layout every other embed kind (and an author-less draft) keeps.
 */
describe('embedFromDraftRef — identity-forward variant (Phase 6)', () => {
  it('sets the identityForward variant when the token carries an author', () => {
    const ref: DraftRef = {id: 'd1', title: 'My Piece', excerpt: 'a teaser', author: 'a'.repeat(64), authorName: 'Alice'};
    const view = embedFromDraftRef(ref);
    expect(view.variant).toBe('identityForward');
    expect(view.name).toBe('Alice');
  });

  it('falls back to the generic layout (no variant) when the token carries no author', () => {
    const ref: DraftRef = {id: 'd2', title: 'Anonymous piece', excerpt: 'a teaser'};
    const view = embedFromDraftRef(ref);
    expect(view.variant).toBeUndefined();
    expect(view.name).toBe('Read draft');
  });

  it('a legacy token never gets the identity-forward variant', () => {
    const view = embedFromDraftRef('legacy');
    expect(view.variant).toBeUndefined();
  });

  it('renders the identity row (avatar · name · "· Draft") ABOVE the title for the identity-forward variant', () => {
    const ref: DraftRef = {id: 'd3', title: 'My Piece', excerpt: 'a teaser', author: 'b'.repeat(64), authorName: 'Bob'};
    const view = embedFromDraftRef(ref);
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<RefEmbed view={view} />); });

    const texts = tree.root.findAll(n => n.type === Text).map(n => n.props.children).flat();
    const nameIdx = texts.indexOf('Bob');
    const dotIdx = texts.indexOf(' · Draft');
    const titleIdx = texts.indexOf('My Piece');
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(dotIdx).toBeGreaterThan(nameIdx);
    expect(titleIdx).toBeGreaterThan(dotIdx);
    // The generic layout's eyebrow ("DRAFT" kind label) is NOT rendered for this variant.
    expect(texts).not.toContain('DRAFT');
  });

  it('an author-less draft keeps the generic bottom "by" row layout (no identity-forward row)', () => {
    const ref: DraftRef = {id: 'd4', title: 'Anonymous piece', excerpt: 'a teaser'};
    const view = embedFromDraftRef(ref);
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<RefEmbed view={view} />); });

    const texts = tree.root.findAll(n => n.type === Text).map(n => n.props.children).flat();
    expect(texts).toContain('DRAFT'); // generic eyebrow (view.kind.toUpperCase())
    expect(texts).toContain('Read draft');
  });
});
