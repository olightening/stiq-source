/**
 * NIP-29 relay-managed groups (client side).
 *
 * A group is a relay-enforced membership space identified by a short `groupID` carried in an
 * `h` tag. Unlike NIP-53 channels (open, owner-signed, ride the firehose), group membership and
 * moderation are enforced by the RELAY: only members may publish kind-9 chat, and the relay
 * emits authoritative `39000-39003` state events (metadata/admins/members/roles) that the
 * client reads. Clients send management events (9007 create, 9000 add, 9001 kick, 9002 edit,
 * 9021 join, 9022 leave); they never write the 39000-39003 state (the relay rejects that).
 *
 * Group chat kinds (9/11/12) and state kinds (39000-39003) are deliberately NOT on the feed
 * firehose — they are fetched with a group-scoped subscription (`#h`/`#d`), matching the
 * relay's RequireScopedGroupQuery anti-enumeration rule.
 */
import type {Event} from 'nostr-tools/pure';
import type {UnsignedEvent} from '../keys/keystore';
import type {EventStore} from '../nostr/store';
import type {GradientSpec} from '../media/gradient';
import {encodeGradient, decodeGradient} from '../media/gradient';
import {encryptForSpace, type SpaceKey} from './groupCrypto';
import {promotedTagFrom} from './promote';

export type {SpaceKey};

/**
 * Wrap a body for the wire: if `enc` is given, return the NIP-44 ciphertext + the encryption tags;
 * otherwise return the plaintext untouched (no extra tags). Centralised so every private-space
 * builder encrypts identically and the relay only ever sees ciphertext for a keyed space.
 */
function sealBody(content: string, enc?: SpaceKey): {content: string; tags: string[][]} {
  if (!enc) return {content, tags: []};
  return {
    content: encryptForSpace(content, enc.key),
    tags: [['encrypted', 'nip44'], ['ke', String(enc.epoch)]],
  };
}

/** The encryption epoch a message was sealed under (its `['ke', n]` tag), or null if plaintext. */
export function messageEpoch(event: Event): number | null {
  if (!event.tags.some(t => t[0] === 'encrypted' && t[1] === 'nip44')) return null;
  const ke = event.tags.find(t => t[0] === 'ke' && t[1] !== undefined)?.[1];
  if (ke === undefined) return null;
  const n = Number(ke);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** NIP-29 event kinds (mirrors relay/internal/groups). */
export const GroupKind = {
  Chat: 9,
  Thread: 11,
  Reply: 12,
  AddUser: 9000,
  RemoveUser: 9001,
  EditMetadata: 9002,
  Create: 9007,
  Delete: 9008,
  JoinRequest: 9021,
  LeaveRequest: 9022,
  /** Admin-signed invite grant (carried inside a 9021's `invite_grant` tag, never published). */
  InviteGrant: 9010,
  Metadata: 39000,
  Admins: 39001,
  Members: 39002,
  Roles: 39003,
  Pending: 39004,
} as const;

export const ROLE_ADMIN = 'admin';
export const ROLE_OWNER = 'owner';

export interface GroupMeta {
  name?: string;
  about?: string;
  picture?: string;
  /** closed = a join request needs an admin to add the user (vs open = auto-admit). */
  closed?: boolean;
  /** private = only members may read (vs public). */
  private?: boolean;
  gradient?: GradientSpec;
  /** broadcast = only admins may post top-level messages (relay-enforced in policy/groups.go);
   * members may still comment/react. This is an admins-only-posting flag, NOT firehose forwarding. */
  broadcast?: boolean;
  /** Emoji set admins enable as one-tap reactions on every post. Empty/absent = none.
   * Mirrors {@link ChannelMetadata.reactions} so the shared reactions tally works unchanged. */
  reactions?: string[];
}

export interface GroupState extends Required<Pick<GroupMeta, 'closed' | 'private'>> {
  id: string;
  name: string;
  about?: string;
  picture?: string;
  /** Hex pubkey of the group owner (from the relay's 39000 `owner` tag), if known. */
  owner?: string;
  gradient?: GradientSpec;
  broadcast?: boolean;
  /** Admin-configured reaction emojis shown on every post (kind-7 tallies). */
  reactions?: string[];
  /**
   * created_at of the 39000 this state was parsed from — when the space appeared (or was last
   * edited). The channels list uses it as the recency fallback for spaces with no readable messages,
   * so a fresh empty private space sorts near the top instead of burying below week-old rows.
   */
  metaAt?: number;
}

export interface GroupSummary {
  id: string;
  name: string;
  memberCount: number;
  /** Whether the viewer is an admin of this group. */
  isAdmin: boolean;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** A short random group id for a freshly-created group. */
export function newGroupId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function metaTags(meta: GroupMeta): string[][] {
  const tags: string[][] = [];
  if (meta.name) tags.push(['name', meta.name]);
  if (meta.about) tags.push(['about', meta.about]);
  if (meta.picture) tags.push(['picture', meta.picture]);
  tags.push([meta.closed ? 'closed' : 'open']);
  tags.push([meta.private ? 'private' : 'public']);
  if (meta.gradient) {
    const encoded = encodeGradient(meta.gradient);
    if (encoded) tags.push(['gradient', encoded]);
  }
  if (meta.broadcast) tags.push(['broadcast']);
  // Reaction set as a single multi-value tag: ['reactions', '👍', '🔥', '🙏'] — identical
  // format to buildChannelTags so tallyEmojiReactions counts group + channel posts the same way.
  const reactions = (meta.reactions ?? []).map(e => e.trim()).filter(Boolean);
  if (reactions.length > 0) tags.push(['reactions', ...reactions]);
  return tags;
}

// ── management event builders ────────────────────────────────────────────────────────────────

export function buildGroupCreate(groupId: string, meta: GroupMeta = {}): UnsignedEvent {
  return {
    kind: GroupKind.Create,
    created_at: nowSec(),
    tags: [['h', groupId], ...metaTags(meta)],
    content: '',
  };
}

/**
 * Local, self-authored OPTIMISTIC group state (39000 metadata + 39001 admins + 39002 members) so a
 * freshly-created NIP-29 space renders correctly and IMMEDIATELY — right name/type/gradient, the
 * creator recognized as owner+admin+member (so the composer + encryption banner show at once) — with
 * no wait on the relay's authoritative 39000-39003 round-trip over Tor. Each carries an `['optimistic']`
 * marker so any relay copy supersedes it on arrival ({@link betterState}). These are stored LOCALLY
 * only (the relay rejects client-authored state), never published.
 */
export function buildOptimisticGroupState(groupId: string, meta: GroupMeta, owner: string): UnsignedEvent[] {
  const created_at = nowSec();
  const opt = ['optimistic'];
  return [
    {kind: GroupKind.Metadata, created_at, content: '', tags: [['d', groupId], ...metaTags(meta), ['owner', owner], opt]},
    {kind: GroupKind.Admins,   created_at, content: '', tags: [['d', groupId], ['p', owner, ROLE_ADMIN], opt]},
    {kind: GroupKind.Members,  created_at, content: '', tags: [['d', groupId], ['p', owner], opt]},
  ];
}

export function buildGroupEditMetadata(groupId: string, meta: GroupMeta): UnsignedEvent {
  return {
    kind: GroupKind.EditMetadata,
    created_at: nowSec(),
    tags: [['h', groupId], ...metaTags(meta)],
    content: '',
  };
}

/**
 * A kind-9021 join request. The relay's state machine ignores both extras but STORES the event:
 *  - `content` may carry the sealed intro-note envelope (see channels/membership.ts) — admins
 *    fetch the raw 9021 back on a group-scoped sub and unseal their copy for the review queue;
 *  - `invited` marks an ACCEPT of a DM invite (`['invite']` tag) — any online admin's client
 *    auto-approves a pending pubkey that is also in the space's folded invited set.
 */
export function buildGroupJoinRequest(
  groupId: string,
  content = '',
  invited = false,
  inviteGrant?: string,
): UnsignedEvent {
  const tags: string[][] = [['h', groupId]];
  if (invited) tags.push(['invite']);
  // A relay-verifiable invite grant (base64 kind-9010 event, minted by the inviting admin) admits
  // the invitee to membership immediately — no online admin needed. The relay ignores an
  // absent/invalid grant and queues the request as pending instead (see groups/groups.go).
  if (inviteGrant) tags.push(['invite_grant', inviteGrant]);
  return {kind: GroupKind.JoinRequest, created_at: nowSec(), tags, content};
}

/**
 * An admin-signed invite grant: a kind-9010 event attesting "I invite <invitedPubkey> to <groupId>,
 * valid until <expiresAt>". The relay admits an invitee who presents a valid grant (signed by a
 * CURRENT admin, for THIS group + THIS pubkey, unexpired) straight to membership — the
 * relay-verifiable half of accept-first invites. It is delivered inside the invite DM and never
 * published on its own, so the relay stays blind to who was invited until an invitee acts.
 */
export function buildInviteGrant(
  groupId: string,
  invitedPubkey: string,
  expiresAt: number,
): UnsignedEvent {
  return {
    kind: GroupKind.InviteGrant,
    created_at: nowSec(),
    tags: [['h', groupId], ['p', invitedPubkey], ['exp', String(Math.floor(expiresAt))]],
    content: '',
  };
}

export function buildGroupLeaveRequest(groupId: string): UnsignedEvent {
  return {kind: GroupKind.LeaveRequest, created_at: nowSec(), tags: [['h', groupId]], content: ''};
}

export function buildGroupAddUser(groupId: string, pubkey: string, asAdmin = false): UnsignedEvent {
  const p = asAdmin ? ['p', pubkey, ROLE_ADMIN] : ['p', pubkey];
  return {kind: GroupKind.AddUser, created_at: nowSec(), tags: [['h', groupId], p], content: ''};
}

export function buildGroupRemoveUser(groupId: string, pubkey: string): UnsignedEvent {
  return {
    kind: GroupKind.RemoveUser,
    created_at: nowSec(),
    tags: [['h', groupId], ['p', pubkey]],
    content: '',
  };
}

export function buildGroupChat(
  groupId: string,
  content: string,
  replyTo?: string,
  enc?: SpaceKey,
): UnsignedEvent {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('group message is empty');
  }
  const tags: string[][] = [['h', groupId]];
  // A reply is a normal in-timeline message that quotes its parent (Telegram-style) via an
  // `['e', <parentId>, '', 'reply']` marker — distinct from the 'edit' marker so the fold ignores it.
  // The `e` tag is an event id (public anyway), so it stays outside the encrypted content.
  if (replyTo) tags.push(['e', replyTo, '', 'reply']);
  // For a private group, the body (incl. the author's display-name header) is encrypted; the relay
  // sees only ciphertext + the encryption marker tags.
  const sealed = sealBody(trimmed, enc);
  return {kind: GroupKind.Chat, created_at: nowSec(), tags: [...tags, ...sealed.tags], content: sealed.content};
}

/** The parent message id this kind-9 message replies to (its `['e', id, '', 'reply']` marker), or null. */
export function groupReplyParentId(event: Event): string | null {
  if (event.kind !== GroupKind.Chat) return null;
  const t = event.tags.find(tag => tag[0] === 'e' && tag[3] === 'reply');
  return t?.[1] ?? null;
}

/** A position-preserving EDIT of a prior group message (folded at read time, like channel edits). */
export function buildGroupChatEdit(
  groupId: string,
  originalId: string,
  content: string,
  enc?: SpaceKey,
): UnsignedEvent {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('group message is empty');
  }
  const sealed = sealBody(trimmed, enc);
  return {
    kind: GroupKind.Chat,
    created_at: nowSec(),
    tags: [['h', groupId], ['e', originalId, '', 'edit'], ...sealed.tags],
    content: sealed.content,
  };
}

/** The group message id this event edits (its `["e", id, "", "edit"]` marker), or null. */
export function groupEditTargetId(event: Event): string | null {
  if (event.kind !== GroupKind.Chat) return null;
  const t = event.tags.find(tag => tag[0] === 'e' && tag[3] === 'edit');
  return t?.[1] ?? null;
}

/** A threaded reply (kind 12) to a parent group message, carrying an `e` tag to the parent. */
export function buildGroupReply(
  groupId: string,
  parentId: string,
  content: string,
  enc?: SpaceKey,
): UnsignedEvent {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error('group reply is empty');
  }
  const sealed = sealBody(trimmed, enc);
  return {
    kind: GroupKind.Reply,
    created_at: nowSec(),
    tags: [['h', groupId], ['e', parentId, '', 'reply'], ...sealed.tags],
    content: sealed.content,
  };
}

/** Owner-only: delete the group entirely (kind 9008). */
export function buildGroupDelete(groupId: string): UnsignedEvent {
  return {kind: GroupKind.Delete, created_at: nowSec(), tags: [['h', groupId]], content: ''};
}

/** Owner-only: transfer ownership to another member (9000 with the transient `owner` role). */
export function buildGroupTransferOwner(groupId: string, pubkey: string): UnsignedEvent {
  return {
    kind: GroupKind.AddUser,
    created_at: nowSec(),
    tags: [['h', groupId], ['p', pubkey, ROLE_OWNER]],
    content: '',
  };
}

// ── tag helpers + parsers for relay-generated state ────────────────────────────────────────

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find(t => t[0] === name && t[1])?.[1];
}

function hasFlag(event: Event, name: string): boolean {
  return event.tags.some(t => t[0] === name);
}

/** d-tag (group id) of a relay-generated 3900x state event. */
export function stateGroupId(event: Event): string | undefined {
  return tagValue(event, 'd');
}

/** The group id an h-tagged event targets (chat/management), or undefined. */
export function eventGroupId(event: Event): string | undefined {
  return tagValue(event, 'h');
}

/** Parse a 39000 metadata event. */
export function parseGroupMetadata(event: Event): GroupState | null {
  if (event.kind !== GroupKind.Metadata) return null;
  const id = stateGroupId(event);
  if (!id) return null;
  const reactionsTag = event.tags.find(t => t[0] === 'reactions');
  const reactions = reactionsTag ? reactionsTag.slice(1).filter(Boolean) : undefined;
  return {
    id,
    name: tagValue(event, 'name') ?? 'group',
    about: tagValue(event, 'about'),
    picture: tagValue(event, 'picture'),
    owner: tagValue(event, 'owner'),
    closed: hasFlag(event, 'closed'),
    private: hasFlag(event, 'private'),
    gradient: decodeGradient(tagValue(event, 'gradient') ?? ''),
    broadcast: hasFlag(event, 'broadcast'),
    reactions: reactions && reactions.length > 0 ? reactions : undefined,
    metaAt: event.created_at,
  };
}

/** Pubkeys listed in a 39001 (admins) or 39002 (members) event's `p` tags. */
export function parseGroupPubkeys(event: Event): string[] {
  const out: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === 'p' && tag[1]) out.push(tag[1]);
  }
  return out;
}

// ── store selectors (latest replaceable state wins) ───────────────────────────────────────

/**
 * A locally-seeded OPTIMISTIC state event (see {@link buildOptimisticGroupState}) — written by the
 * creator so a fresh NIP-29 space renders correctly at once, and ALWAYS superseded by any relay copy.
 */
function isOptimistic(ev: Event): boolean {
  return ev.tags.some(t => t[0] === 'optimistic');
}

/**
 * Pick the winning replaceable-state event: a relay (authoritative, non-optimistic) copy beats an
 * optimistic seed regardless of timestamp (so the seed can never shadow real relay state, even under
 * clock skew); among events of the same authority, the latest `created_at` wins.
 */
function betterState(prev: Event | undefined, ev: Event): Event {
  if (!prev) return ev;
  const pOpt = isOptimistic(prev);
  const eOpt = isOptimistic(ev);
  if (pOpt !== eOpt) return pOpt ? ev : prev;
  return ev.created_at > prev.created_at ? ev : prev;
}

function latestStateByGroup(store: EventStore, kind: number, groupId: string): Event | undefined {
  let best: Event | undefined;
  for (const e of store.query({kinds: [kind]})) {
    if (stateGroupId(e) === groupId) best = betterState(best, e);
  }
  return best;
}

export function groupState(store: EventStore, groupId: string): GroupState | null {
  const ev = latestStateByGroup(store, GroupKind.Metadata, groupId);
  return ev ? parseGroupMetadata(ev) : null;
}

export function groupMembers(store: EventStore, groupId: string): string[] {
  const ev = latestStateByGroup(store, GroupKind.Members, groupId);
  return ev ? parseGroupPubkeys(ev) : [];
}

export function groupAdmins(store: EventStore, groupId: string): string[] {
  const ev = latestStateByGroup(store, GroupKind.Admins, groupId);
  return ev ? parseGroupPubkeys(ev) : [];
}

/** Pending join requests for a closed group (from the relay's latest 39004). */
export function groupPending(store: EventStore, groupId: string): string[] {
  const ev = latestStateByGroup(store, GroupKind.Pending, groupId);
  return ev ? parseGroupPubkeys(ev) : [];
}

export function isGroupMember(store: EventStore, groupId: string, pubkey: string): boolean {
  return groupMembers(store, groupId).includes(pubkey);
}

export function isGroupAdmin(store: EventStore, groupId: string, pubkey: string): boolean {
  return groupAdmins(store, groupId).includes(pubkey);
}

export function isGroupOwner(store: EventStore, groupId: string, pubkey: string): boolean {
  return groupState(store, groupId)?.owner === pubkey;
}

/** Group chat messages (kind 9) for a group, oldest first, with author edits folded in place. */
export function groupChatMessages(store: EventStore, groupId: string): Event[] {
  const all = store
    .query({kinds: [GroupKind.Chat]})
    .filter(e => eventGroupId(e) === groupId);

  // Keyed by (target, author) so a foreign edit can never rewrite or shadow the genuine one.
  const editsByKey = new Map<string, Event>();
  for (const ev of all) {
    const target = groupEditTargetId(ev);
    if (!target) continue;
    const key = `${target} ${ev.pubkey}`;
    const cur = editsByKey.get(key);
    if (!cur || ev.created_at > cur.created_at) editsByKey.set(key, ev);
  }

  const folded: Event[] = [];
  for (const m of all) {
    if (groupEditTargetId(m)) continue; // an edit never renders as its own message
    const edit = editsByKey.get(`${m.id} ${m.pubkey}`);
    folded.push(
      edit
        ? {...m, content: edit.content, tags: [...m.tags, ['edited', String(edit.created_at)], ...promotedTagFrom(edit)]}
        : m,
    );
  }
  return folded.sort((a, b) => a.created_at - b.created_at);
}

/**
 * The single-message analogue of the {@link groupChatMessages} fold: `original` with its author's
 * latest edit applied in place, or null when unedited. Same author-scoping rule as the full fold —
 * see foldChannelEdit in channels.ts for why single-event resolvers (embed previews) need this.
 */
export function foldGroupChatEdit(store: EventStore, original: Event): Event | null {
  if (original.kind !== GroupKind.Chat || groupEditTargetId(original)) return null;
  let latest: Event | null = null;
  for (const ev of store.query({kinds: [GroupKind.Chat]})) {
    if (groupEditTargetId(ev) !== original.id || ev.pubkey !== original.pubkey) continue;
    if (!latest || ev.created_at > latest.created_at) latest = ev;
  }
  return latest
    ? {...original, content: latest.content, tags: [...original.tags, ['edited', String(latest.created_at)], ...promotedTagFrom(latest)]}
    : null;
}

/** The parent message id a kind-12 reply targets (its `e` tag), or undefined. */
export function replyParentId(event: Event): string | undefined {
  return event.tags.find(t => t[0] === 'e' && t[1])?.[1];
}

/**
 * Threaded replies (kind 12) for a group, grouped by the parent message id they reference.
 * Each list is oldest-first. Lets the chat render replies nested under their parent message.
 */
export function groupRepliesByParent(store: EventStore, groupId: string): Map<string, Event[]> {
  const byParent = new Map<string, Event[]>();
  const replies = store
    .query({kinds: [GroupKind.Reply]})
    .filter(e => eventGroupId(e) === groupId)
    .sort((a, b) => a.created_at - b.created_at);
  for (const r of replies) {
    const parent = replyParentId(r);
    if (!parent) continue;
    const list = byParent.get(parent) ?? [];
    list.push(r);
    byParent.set(parent, list);
  }
  return byParent;
}

/**
 * Summaries of every group the viewer is a member of, derived from cached 39002 member lists.
 * Drives the "my groups" list without bloating the snapshot with full member/admin sets.
 */
export function myGroupSummaries(store: EventStore, myPubkey: string | undefined): GroupSummary[] {
  if (!myPubkey) return [];
  // Latest 39002 per group id.
  const latest = new Map<string, Event>();
  for (const ev of store.query({kinds: [GroupKind.Members]})) {
    const id = stateGroupId(ev);
    if (!id) continue;
    const prev = latest.get(id);
    if (!prev || ev.created_at > prev.created_at) latest.set(id, ev);
  }
  const out: GroupSummary[] = [];
  for (const [id, membersEvent] of latest) {
    const members = parseGroupPubkeys(membersEvent);
    if (!members.includes(myPubkey)) continue;
    const meta = groupState(store, id);
    out.push({
      id,
      name: meta?.name ?? 'group',
      memberCount: members.length,
      isAdmin: isGroupAdmin(store, id, myPubkey),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── groupSummariesForIds perf cache ──────────────────────────────────────────────────────────
//
// Without caching, each call does ~3N store queries (metadata + members + admins per group id).
// With N joined groups at 4 snapshots/sec that's ~12N queries/sec — O(N²) churn on the JS thread.
//
// Fix (two layers):
//   1. Single-pass indexing: query each relevant kind bucket ONCE per call, index by groupId in
//      one pass, then derive every summary from the in-memory map — ~3 queries total, not ~3N.
//   2. Cross-call version cache: if the store exposes `versionOf` (InMemoryEventStore does, though
//      the EventStore interface doesn't declare it), memoize the result and skip even those 3
//      queries when none of the group-state kinds changed since the last call.

const GROUP_STATE_KINDS = [GroupKind.Metadata, GroupKind.Members, GroupKind.Admins] as const;

/** Shape of the cross-call memo held for a single `store` + `myPubkey` pair. */
interface SummaryCache {
  version: number;
  myPubkey: string | undefined;
  idsKey: string;
  result: GroupSummary[];
}

// WeakMap so the store object is the key — automatically GC'd when the store is dropped.
const _summaryCacheByStore = new WeakMap<object, SummaryCache>();

/**
 * Summaries for an explicit set of group ids the viewer has locally joined/created. Unlike
 * {@link myGroupSummaries} (which scans cached 39002 for the viewer's pubkey), this is driven by
 * local membership *intent* so the list is authoritative for the viewer: leaving removes a group
 * immediately even when the relay won't drop the viewer (e.g. an OWNER, whom NIP-29 forbids from
 * leaving). State (name/members/admin) is still read from cache; a group whose state hasn't
 * arrived yet shows a placeholder until its 39000/39002 stream in.
 */
export function groupSummariesForIds(
  store: EventStore,
  ids: Iterable<string>,
  myPubkey: string | undefined,
): GroupSummary[] {
  // Materialise ids once so we can both compute an idsKey and iterate later.
  const idList = Array.isArray(ids) ? (ids as string[]) : [...ids];
  const idsKey = idList.join('\0');

  // Layer 2: cross-call version cache (only when the store supports versionOf).
  // `versionOf` is on InMemoryEventStore but NOT declared on the EventStore interface, so we
  // check at runtime. The `in` narrowing is strict-TS-safe.
  if ('versionOf' in store && typeof (store as {versionOf: unknown}).versionOf === 'function') {
    const storeWithVersion = store as {versionOf: (kinds: readonly number[]) => number};
    const currentVersion = storeWithVersion.versionOf(GROUP_STATE_KINDS);
    const cached = _summaryCacheByStore.get(store);
    if (
      cached !== undefined &&
      cached.version === currentVersion &&
      cached.myPubkey === myPubkey &&
      cached.idsKey === idsKey
    ) {
      return cached.result;
    }
    const result = _buildSummaries(store, idList, myPubkey);
    _summaryCacheByStore.set(store, {version: currentVersion, myPubkey, idsKey, result});
    return result;
  }

  // Layer 1 only: single-pass indexing (no version API available).
  return _buildSummaries(store, idList, myPubkey);
}

/**
 * Core implementation: query each group-state kind ONCE, index by groupId, then derive summaries.
 * This is ~3 queries total regardless of how many ids are requested (vs ~3N before).
 */
function _buildSummaries(
  store: EventStore,
  idList: string[],
  myPubkey: string | undefined,
): GroupSummary[] {
  // Query each kind bucket once and keep only the latest event per groupId (replaceable state).
  const latestMeta = new Map<string, Event>();
  const latestMembers = new Map<string, Event>();
  const latestAdmins = new Map<string, Event>();

  // betterState: a relay copy supersedes an optimistic seed; otherwise latest created_at wins.
  for (const ev of store.query({kinds: [GroupKind.Metadata]})) {
    const gid = stateGroupId(ev);
    if (gid) latestMeta.set(gid, betterState(latestMeta.get(gid), ev));
  }
  for (const ev of store.query({kinds: [GroupKind.Members]})) {
    const gid = stateGroupId(ev);
    if (gid) latestMembers.set(gid, betterState(latestMembers.get(gid), ev));
  }
  for (const ev of store.query({kinds: [GroupKind.Admins]})) {
    const gid = stateGroupId(ev);
    if (gid) latestAdmins.set(gid, betterState(latestAdmins.get(gid), ev));
  }

  const out: GroupSummary[] = [];
  for (const id of idList) {
    const metaEv = latestMeta.get(id);
    const meta = metaEv ? parseGroupMetadata(metaEv) : null;

    const membersEv = latestMembers.get(id);
    const memberCount = membersEv ? parseGroupPubkeys(membersEv).length : 0;

    let isAdmin = false;
    if (myPubkey) {
      const adminsEv = latestAdmins.get(id);
      if (adminsEv) {
        isAdmin = parseGroupPubkeys(adminsEv).includes(myPubkey);
      }
    }

    out.push({
      id,
      name: meta?.name ?? 'group',
      memberCount,
      isAdmin,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── NIP-11 capability gate ────────────────────────────────────────────────────────────────
// The NIP-11 capability parsing moved to `nostr/capabilities.ts`, where it was generalised into the
// full RelayCapabilities negotiation. These thin re-exports keep existing importers (this module's
// tests, and any NIP-29 gate reader) resolving them from `channels/groups` unchanged.
export {parseSupportedNips, supportsNip29, fetchRelaySupportsNip29} from '../nostr/capabilities';
