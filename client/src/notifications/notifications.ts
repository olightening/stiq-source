/**
 * Local notification layer for Stiq.
 *
 * Provider pattern: the actual delivery mechanism (e.g. @notifee/react-native) is injected
 * at startup via setNotificationProvider(). If no provider is registered the module is a
 * complete no-op, so the rest of the codebase can import and call freely without knowing
 * whether the native lib is present.
 *
 * Three notification types:
 *   dm      — new DM from a peer
 *   channel — new broadcast in a followed channel
 *   comment — new reply to the user's own post
 *
 * Notifications are TITLE-ONLY (product decision): no message body, npub, or event content is
 * ever surfaced in a notification. Each composer builds a NavTarget describing where a tap on
 * the notification should route, independent of the (already anonymized) title text.
 *
 * Every composer is gated by isPushAllowed() (see ./prefs) — isNotifAllowed() (the same decision
 * authority the live-derived notification list uses) ANDed with a second, push-only sub-model, so
 * a category can list in the notification center while staying silent as an OS push (never the
 * reverse) — in addition to the legacy per-source mute set below, which remains a push-only
 * pre-filter so existing ConversationView/ChannelDetail/GroupView mute toggles keep working
 * unchanged.
 *
 * Mute: any source ID can be silenced. Muted sources and per-source high-water marks are
 * persisted in AsyncStorage so they survive restarts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ensurePrefsLoaded,
  getPrefs,
  isNameHidden,
  isPushAllowed,
  type ChannelType,
  type NotifDescriptor,
  type PostType,
} from './prefs';
import {setNotifReadSlot, ensureReadStateLoaded, ensureNotifReadLoaded} from './readState';

// ─── Nav model ─────────────────────────────────────────────────────────────────

/** Where a notification tap routes. Post/reply always targets the ROOT post (never a comment).
 * `group_requests` routes to a group's Manage page (the pending join-request queue). */
export type NavTarget =
  | {kind: 'dm'; peer: string}
  | {kind: 'channel'; channelId: string; channelType: 'public' | 'group'}
  | {kind: 'post'; rootId: string}
  | {kind: 'group_requests'; groupId: string}
  /** Event detail by 31923 coordinate — used by event reminders (events/reminders.ts). */
  | {kind: 'event'; coordinate: string}
  /**
   * Owner's "Manage access" queue for one of THEIR OWN shared drafts (Phase 5§G — see
   * AppRuntime.deriveNotifications' draft-access-request block). `draftId` is the draft's stable
   * `shareId` (feed/drafts.ts) — the SAME id `getDraftAccessQueue`/`approveDraftAccess`/
   * `denyDraftAccess` key on, never the draft's local per-device `id`. Mirrors `group_requests`
   * exactly (a pending-decision queue, not a single request).
   */
  | {kind: 'draft_requests'; draftId: string}
  /**
   * A requester's now-unlocked draft, opened straight into its reader (Phase 5§G — the
   * draft-access-granted block). `draftId` is the shareId; `ownerPubkey` is the `DraftDelivery`'s
   * signer, threaded through so the reader can resolve `getMyDraftDelivery(draftId, ownerPubkey)`
   * without re-deriving the owner from scratch.
   */
  | {kind: 'draft_reader'; draftId: string; ownerPubkey: string};

/** The four notification-center sources (design filter chips: DMs / Channels / Comments / Posts). */
/** 'draft' = shared-draft access (Phase 5§G): someone asking to read a draft of mine, or an owner
 *  approving my request. Its own source rather than borrowing 'channel'/'dm' — those were stand-ins
 *  chosen before the category existed, and left a draft request filed under Channels with a
 *  megaphone glyph. See NotificationPrefs.drafts, which gates it. */
export type NotifKind = 'dm' | 'channel' | 'reply' | 'post' | 'draft';

/**
 * The 42×42 leading avatar of a center row. Person rows are identity-gradient circles; channel
 * rows are the channel's gradient in its identity shape (square, or octagon for open communities).
 * `gradient` may be absent — the renderer then derives a stable gradient from `seed`, exactly like
 * every other avatar surface.
 */
export interface NotifAvatar {
  // Mirrors GradientAvatar's AvatarShape (the renderer casts to it): circle → people/DMs;
  // square/octagon → channels; hexagon/diamond → groups (a join-request row uses the group's shape).
  shape: 'circle' | 'square' | 'octagon' | 'hexagon' | 'diamond';
  seed: string;
  gradient?: import('../media/gradient').GradientSpec;
}

/**
 * One row in the live-derived notification center (see AppRuntime.deriveNotifications).
 *
 * Text renders as: **actor** action *targetText* over a 2-line muted `preview`
 * (design: `**Pale Signal** commented on your post **“Staying reachable…”`).
 */
export interface NotifItem {
  id: string; // stable key: source event id (dedupe + React key + read-state key)
  ts: number; // created_at (unix seconds); list sorts desc
  kind: NotifKind;
  target: NavTarget; // tap routes here
  /** Read state at derive time (readState.isNotifRead) — drives the dot, chip counts, bell badge. */
  read: boolean;
  /** Bold lead: person display name, or the #channel when the channel itself is the actor. */
  actor: string;
  /** Secondary action phrase ("sent you a message", "commented on your post", "posted in", …). */
  action: string;
  /** Optional semibold target: post title in curly quotes, or #channel. */
  targetText?: string;
  /** Optional 2-line-clamped muted preview (message/comment text in curly quotes, post excerpt). */
  preview?: string;
  avatar: NotifAvatar;
}

/**
 * Serialize a NavTarget into a flat string map — the shape notifee's Android `data` payload
 * requires. Deserialize with decodeNavTarget, which returns null on any malformed input rather
 * than throwing (cold-start delivery of a stale/foreign payload must never crash the app).
 */
export function encodeNavTarget(t: NavTarget): Record<string, string> {
  switch (t.kind) {
    case 'dm':
      return {kind: 'dm', peer: t.peer};
    case 'channel':
      return {kind: 'channel', channelId: t.channelId, channelType: t.channelType};
    case 'post':
      return {kind: 'post', rootId: t.rootId};
    case 'group_requests':
      return {kind: 'group_requests', groupId: t.groupId};
    case 'event':
      return {kind: 'event', coordinate: t.coordinate};
    case 'draft_requests':
      return {kind: 'draft_requests', draftId: t.draftId};
    case 'draft_reader':
      return {kind: 'draft_reader', draftId: t.draftId, ownerPubkey: t.ownerPubkey};
  }
}

export function decodeNavTarget(data: unknown): NavTarget | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.kind === 'dm') {
    const peer = d.peer;
    if (typeof peer !== 'string' || !peer) return null;
    return {kind: 'dm', peer};
  }
  if (d.kind === 'channel') {
    const channelId = d.channelId;
    const channelType = d.channelType;
    if (typeof channelId !== 'string' || !channelId) return null;
    if (channelType !== 'public' && channelType !== 'group') return null;
    return {kind: 'channel', channelId, channelType};
  }
  if (d.kind === 'post') {
    const rootId = d.rootId;
    if (typeof rootId !== 'string' || !rootId) return null;
    return {kind: 'post', rootId};
  }
  if (d.kind === 'group_requests') {
    const groupId = d.groupId;
    if (typeof groupId !== 'string' || !groupId) return null;
    return {kind: 'group_requests', groupId};
  }
  if (d.kind === 'event') {
    const coordinate = d.coordinate;
    if (typeof coordinate !== 'string' || !coordinate) return null;
    return {kind: 'event', coordinate};
  }
  if (d.kind === 'draft_requests') {
    const draftId = d.draftId;
    if (typeof draftId !== 'string' || !draftId) return null;
    return {kind: 'draft_requests', draftId};
  }
  if (d.kind === 'draft_reader') {
    const draftId = d.draftId;
    const ownerPubkey = d.ownerPubkey;
    if (typeof draftId !== 'string' || !draftId) return null;
    if (typeof ownerPubkey !== 'string' || !ownerPubkey) return null;
    return {kind: 'draft_reader', draftId, ownerPubkey};
  }
  return null;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * Called by the notification backend (e.g. @notifee wrapper in App.tsx).
 * title is the only user-facing text (product lock: no body). channelId maps to the Android
 * notification channel ('dm' | 'channel' | 'comment'). target carries the tap-navigation payload.
 */
export type NotifyFn = (title: string, channelId: string, target: NavTarget) => Promise<void>;

let _provider: NotifyFn | null = null;

/**
 * Unix-seconds floor stamped when the provider first goes live. Events with created_at BELOW it are
 * historical relay replay (fresh install, community switch, clear-data, or reconnect backfill) and
 * must NEVER raise an OS notification — otherwise the first sync fires a push for every conversation's
 * latest DM, every accessible channel's latest broadcast, and every reply at once. Only genuinely
 * post-launch events notify; missed-while-offline items still appear in the in-app center + badge.
 */
let _sessionFloor = 0;

/** Register the delivery backend. Safe to call multiple times (last write wins). */
export function setNotificationProvider(fn: NotifyFn): void {
  _provider = fn;
  if (_sessionFloor === 0) _sessionFloor = Math.floor(Date.now() / 1000);
}

/**
 * How far back (seconds) the HEADLESS push-sync path rewinds the session floor so a push-triggered
 * background sync actually notifies the event that woke it. A push wake is content-free (T1): the app
 * derives its title-only notification locally after syncing over Tor. But setNotificationProvider
 * stamps `_sessionFloor` to `now` on first call, and the event that triggered the wake always has
 * `created_at < now` (a DM's true send time is a few seconds old; a group post likewise) — so without
 * an override, belowSessionFloor() would suppress the very event the wake was for and yield a silent
 * push. The headless task calls {@link setSessionFloor}(now - PUSH_NOTIFY_LOOKBACK_SECONDS) AFTER
 * registering the provider so events within the last 15 minutes still fire; the shared persisted HWM
 * prevents double-notifying one the foreground already advanced past. 900s also bounds the reach: an
 * offline backlog that all lands in one sync still can't flood, because anything older than the
 * lookback is marked seen (HWM advanced) and never notified.
 */
export const PUSH_NOTIFY_LOOKBACK_SECONDS = 900;

/**
 * Override the session floor (unix seconds), replacing the register-time `now` stamped by
 * setNotificationProvider. ONLY the headless background-sync path calls this (with
 * `now - PUSH_NOTIFY_LOOKBACK_SECONDS`) so a push-triggered sync can notify recent events; the
 * foreground never calls it, so its "historical relay replay never notifies" floor is unchanged.
 */
export function setSessionFloor(tsSeconds: number): void {
  _sessionFloor = tsSeconds;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const MUTE_KEY = 'stiq.notif.muted';
const HWM_KEY  = 'stiq.notif.hwm';

// Active account (KeyRing slot) — mute list + notification high-water-marks are namespaced PER ACCOUNT
// so two identities on one device don't share mutes or "already-notified" state (finding D1). Undefined
// ⇒ the pre-silo global keys. setNotificationAccount() flips it (+ resets read-state) on a slot switch.
let _slot: string | undefined;
const keyFor = (base: string): string => (_slot ? `${base}.${_slot}` : base);

let _loaded = false;
const _muteSet = new Set<string>();
const _hwmMap  = new Map<string, number>();

async function ensureLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const m = await AsyncStorage.getItem(keyFor(MUTE_KEY));
    if (m) {
      for (const id of JSON.parse(m) as string[]) {
        _muteSet.add(id);
      }
    }
    const h = await AsyncStorage.getItem(keyFor(HWM_KEY));
    if (h) {
      for (const [k, v] of Object.entries(JSON.parse(h) as Record<string, number>)) {
        _hwmMap.set(k, v);
      }
    }
  } catch { /* ignore — fresh state is fine */ }
}

async function saveHwm(): Promise<void> {
  const obj: Record<string, number> = {};
  for (const [k, v] of _hwmMap) { obj[k] = v; }
  await AsyncStorage.setItem(keyFor(HWM_KEY), JSON.stringify(obj));
}

/**
 * True if `ts` is historical replay (created before this session's provider went live) — and, when
 * so, advances the in-memory HWM to mark it seen. Callers then persist via saveHwm() and return
 * WITHOUT raising an OS notification. Guarded on _sessionFloor > 0 (belt-and-suspenders; a provider
 * is always registered before a composer runs, so the floor is set).
 */
function belowSessionFloor(key: string, ts: number): boolean {
  if (_sessionFloor === 0 || ts >= _sessionFloor) return false;
  _hwmMap.set(key, ts);
  return true;
}

// ─── Mute API ─────────────────────────────────────────────────────────────────

export async function muteSource(id: string): Promise<void> {
  await ensureLoaded();
  const already = _muteSet.has(id);
  _muteSet.add(id);
  try {
    await AsyncStorage.setItem(keyFor(MUTE_KEY), JSON.stringify([..._muteSet]));
  } catch (err) {
    // Revert the in-memory mutation so callers observe the pre-toggle state, then rethrow so a
    // failed write is never silently treated as success (the fire-and-forget bug this guards against).
    if (!already) _muteSet.delete(id);
    throw err;
  }
}

export async function unmuteSource(id: string): Promise<void> {
  await ensureLoaded();
  const wasMuted = _muteSet.has(id);
  _muteSet.delete(id);
  try {
    await AsyncStorage.setItem(keyFor(MUTE_KEY), JSON.stringify([..._muteSet]));
  } catch (err) {
    if (wasMuted) _muteSet.add(id);
    throw err;
  }
}

export async function isSourceMuted(id: string): Promise<boolean> {
  await ensureLoaded();
  return _muteSet.has(id);
}

/** Ensure the mute set + HWM are loaded — call once at startup so isSourceMutedSync is accurate. */
export async function ensureNotifLoaded(): Promise<void> {
  await ensureLoaded();
}

/**
 * Point ALL notification state (mutes + HWM here, plus read/seen + center state in readState) at the
 * given account (KeyRing slot). Drops the in-memory caches so the next access reloads that account's
 * persisted state, then eagerly reloads so isSourceMutedSync / unread counts are accurate immediately
 * after a switch. Idempotent — a no-op when the slot is unchanged. The runtime calls this on init and
 * on every community/account switch so two identities on one device never share notification state
 * (finding D1: cross-account read-state bleed).
 */
export async function setNotificationAccount(slotId: string | undefined): Promise<void> {
  setNotifReadSlot(slotId); // read/seen + notification-center read state (readState.ts)
  if (slotId !== _slot) {
    _slot = slotId;
    _loaded = false;
    _muteSet.clear();
    _hwmMap.clear();
  }
  // Eagerly reload all four caches for the new account so the synchronous mute check + unread counts
  // are accurate immediately after a switch (mirrors the eager warm init() used to do device-wide).
  await Promise.all([ensureLoaded(), ensureReadStateLoaded(), ensureNotifReadLoaded()]);
}

/**
 * Synchronous mute check against the in-memory set. The live-derived notification center
 * (AppRuntime.deriveNotifications) must gate on the SAME legacy per-source mute toggles as the push
 * path — otherwise a muted DM/channel stops pushing but still lists + re-lights the bell. Requires
 * ensureNotifLoaded() to have run (AppRuntime does so in init); returns false before then.
 */
export function isSourceMutedSync(id: string): boolean {
  return _muteSet.has(id);
}

/** Toggle mute for a source. Returns the new mute state. */
export async function toggleMute(id: string): Promise<boolean> {
  const muted = await isSourceMuted(id);
  if (muted) {
    await unmuteSource(id);
    return false;
  } else {
    await muteSource(id);
    return true;
  }
}

// ─── Trigger helpers ──────────────────────────────────────────────────────────

/**
 * Notify about a new incoming DM from a peer.
 * peerPubkey is used as the mute/HWM key — mute a peer to silence their DMs.
 * Title-only, per product lock: "Message from {displayName}" (unknown/empty name -> "Someone"),
 * or "New message" when hideNamesOnLockscreen is on.
 */
export async function notifyDm(
  peerPubkey: string,
  displayName: string,
  ts: number,
): Promise<void> {
  if (!_provider) return;
  await ensureLoaded();
  await ensurePrefsLoaded();
  const key = `dm:${peerPubkey}`;
  if (ts <= (_hwmMap.get(key) ?? 0)) return;
  if (belowSessionFloor(key, ts)) { await saveHwm(); return; }
  if (_muteSet.has(key)) return;

  const prefs = getPrefs();
  const descriptor: NotifDescriptor = {kind: 'dm', peer: peerPubkey};
  if (!isPushAllowed(prefs, descriptor)) return;

  _hwmMap.set(key, ts);
  await saveHwm();

  const title = isNameHidden(prefs, 'dm')
    ? 'New message'
    : `Message from ${displayName || 'Someone'}`;
  const target: NavTarget = {kind: 'dm', peer: peerPubkey};
  await _provider(title, 'dm', target);
}

/**
 * Notify about a new channel broadcast.
 * channelId is used as the mute/HWM key — mute a channel to silence it.
 * Title-only, per product lock: "#{channelName} — new post".
 */
export async function notifyChannel(
  channelId: string,
  channelName: string,
  channelType: 'public' | 'group',
  ts: number,
): Promise<void> {
  if (!_provider) return;
  await ensureLoaded();
  await ensurePrefsLoaded();
  const key = `ch:${channelId}`;
  if (ts <= (_hwmMap.get(key) ?? 0)) return;
  if (belowSessionFloor(key, ts)) { await saveHwm(); return; }
  if (_muteSet.has(key)) return;

  const prefs = getPrefs();
  // NIP-53 channel -> 'channel', NIP-29 group -> 'group' in the pref/descriptor vocabulary.
  const descChannelType: ChannelType = channelType === 'public' ? 'channel' : 'group';
  const descriptor: NotifDescriptor = {kind: 'channel', channelId, channelType: descChannelType};
  if (!isPushAllowed(prefs, descriptor)) return;

  _hwmMap.set(key, ts);
  await saveHwm();

  const title = `#${channelName} — new post`;
  const target: NavTarget = {kind: 'channel', channelId, channelType};
  await _provider(title, 'channel', target);
}

/**
 * Notify about a new comment on the user's own post.
 * rootId is used as the HWM key and is always the PARENT POST id (never the comment's own id) —
 * tapping a reply notification must always open the root post. Use allCommentsMuteId as the mute
 * key to silence all replies.
 * Title-only, per product lock: "{displayName} replied" (unknown/empty name -> "Someone replied"),
 * or "New reply" when hideNamesOnLockscreen is on.
 */
export async function notifyComment(
  rootId: string,
  displayName: string,
  postType: PostType | undefined,
  ts: number,
): Promise<void> {
  if (!_provider) return;
  await ensureLoaded();
  await ensurePrefsLoaded();
  const key = `co:${rootId}`;
  if (ts <= (_hwmMap.get(key) ?? 0)) return;
  if (belowSessionFloor(key, ts)) { await saveHwm(); return; }
  if (_muteSet.has(allCommentsMuteId)) return;

  const prefs = getPrefs();
  const descriptor: NotifDescriptor = {kind: 'reply', postType};
  if (!isPushAllowed(prefs, descriptor)) return;

  _hwmMap.set(key, ts);
  await saveHwm();

  const title = isNameHidden(prefs, 'reply')
    ? 'New reply'
    : (displayName ? `${displayName} replied` : 'Someone replied');
  const target: NavTarget = {kind: 'post', rootId};
  await _provider(title, 'comment', target);
}

/** Mute ID for a DM peer conversation. */
export const dmMuteId  = (peerPubkey: string): string => `dm:${peerPubkey}`;
/** Mute ID for a channel's broadcasts. */
export const chMuteId  = (channelId:  string): string => `ch:${channelId}`;
/** Mute ID for all comment replies. */
export const allCommentsMuteId = 'comments';
/**
 * Mute ID for a shared draft's access-request notifications (Phase 5§G) — keyed on the draft's
 * `shareId`. Nothing publishes to this key yet (no "mute requests for this draft" toggle exists in
 * any screen today), but `AppRuntime.deriveNotifications`'s draft-access-request block already
 * checks it — mirrors how `grp:<id>`/`dmMuteId`/`chMuteId` predate or coincide with their own UI
 * toggles, so a future "Manage access" mute control just works the moment it calls muteSource here.
 */
export const draftMuteId = (draftId: string): string => `draft:${draftId}`;
