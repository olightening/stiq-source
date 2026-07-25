/**
 * Notification preferences — the decision authority for whether any notification (push or
 * live-derived list row) is allowed through.
 *
 * Two gates, one AND relationship (push ⊆ in-app):
 *   - isNotifAllowed  — the SOLE authority for the live-derived notification-center list
 *                        (AppRuntime.deriveNotifications). Unchanged by the push split below.
 *   - isPushAllowed   — isNotifAllowed(...) && the `push` sub-model. The OS-push composers
 *                        (notifyDm/notifyChannel/notifyComment in ./notifications) gate on THIS,
 *                        so a category can list in-app while staying silent as an OS push, but
 *                        never the reverse (push can't fire for something in-app has suppressed).
 *
 * Mirrors the readState.ts / notifications.ts idiom: an in-memory mirror loaded once from
 * AsyncStorage, read synchronously thereafter, written back on every change. Persisted at
 * 'stiq.notif.prefs' as a single JSON blob (the whole NotificationPrefs shape) rather than
 * per-field keys, since prefs are always edited as one settings pane and read as one object.
 *
 * `getPrefs()` is deep-merged over DEFAULT_PREFS on load/save so a persisted blob from an older
 * build (missing a key this version added, e.g. the whole `push` sub-model) still produces a
 * fully-populated, safely-defaulted NotificationPrefs — no `undefined` ever leaks into
 * isNotifAllowed's/isPushAllowed's checks, and an upgrading install defaults every push field ON
 * so its push behavior is unchanged from before the split.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type PostType = 'note' | 'article' | 'picture' | 'voice' | 'poll';
/** NIP-53 live-activity channel / NIP-29 group / broadcast (owner-only channel). */
export type ChannelType = 'channel' | 'group' | 'broadcast';

export interface NotificationPrefs {
  dms: {enabled: boolean; overrides: Record<string, 'always' | 'never'>};
  channels: {
    enabled: boolean;
    /** channelId -> on/off. Covers BOTH joined and merely-accessible (not-joined) channels. */
    perChannel: Record<string, boolean>;
    byType: {channel: boolean; group: boolean; broadcast: boolean};
  };
  postTypes: {note: boolean; article: boolean; picture: boolean; voice: boolean; poll: boolean};
  replies: boolean;
  /**
   * Shared-draft access (Phase 5§G): someone asking to read a draft of YOURS, and an owner
   * approving YOUR request. Its own category deliberately — these first shipped borrowing the
   * `channel`/`dm` descriptors as the closest existing analogs, which meant silencing draft
   * requests also silenced group-join requests, and silencing an approval also silenced DMs. One
   * switch could not express "I want DMs but not draft chatter".
   */
  drafts: boolean;
  /** Hide the actual name/handle in the notification title. Default FALSE — names are shown. */
  hideNamesOnLockscreen: boolean;
  /**
   * Second, narrower gate layered ON TOP of the fields above for the OS-push surface only (see
   * isPushAllowed). push ⊆ in-app: if the corresponding in-app field is off, push is off too,
   * regardless of what's here. Deliberately flat (no per-peer/per-channel push overrides) — the
   * existing dms.overrides / channels.perChannel granularity already suppresses BOTH surfaces
   * (isNotifAllowed is the first half of the AND), so a peer/channel silenced there never reaches
   * this gate; a second, independent per-peer push override would let push diverge from in-app for
   * an individual peer with no product ask for that. Category-level control is all this ships with.
   */
  push: {
    /** Master push kill switch. Off ⇒ nothing pushes, no matter what else is set below. */
    enabled: boolean;
    dms: boolean;
    channels: boolean;
    replies: boolean;
    drafts: boolean;
    postTypes: {note: boolean; article: boolean; picture: boolean; voice: boolean; poll: boolean};
  };
}

export const DEFAULT_PREFS: NotificationPrefs = {
  dms: {enabled: true, overrides: {}},
  channels: {enabled: true, perChannel: {}, byType: {channel: true, group: true, broadcast: true}},
  postTypes: {note: true, article: true, picture: true, voice: true, poll: true},
  replies: true,
  drafts: true,
  hideNamesOnLockscreen: false,
  // Every field ON by default so an upgrading install's push behavior is byte-for-byte identical to
  // today's (before this split, "in-app allowed" WAS "push allowed" — this preserves that outcome).
  push: {
    enabled: true,
    dms: true,
    channels: true,
    replies: true,
    drafts: true,
    postTypes: {note: true, article: true, picture: true, voice: true, poll: true},
  },
};

/** What isNotifAllowed judges. Built identically by the push composers and deriveNotifications. */
export type NotifDescriptor =
  | {kind: 'dm'; peer: string}
  | {kind: 'channel'; channelId: string; channelType: ChannelType; postType?: PostType}
  | {kind: 'reply'; postType?: PostType}
  /** A member's new public feed post (notification-center "Posts" source; no push composer). */
  | {kind: 'post'; postType?: PostType}
  /**
   * Shared-draft access (Phase 5§G) — `request` is someone asking to read a draft of mine,
   * `granted` is an owner approving my request. One prefs switch covers both: they are two halves
   * of one conversation, and a user who does not want draft chatter does not want either half.
   */
  | {kind: 'draft'; event: 'request' | 'granted'};

// ─── Persistence ──────────────────────────────────────────────────────────────

const PREFS_KEY = 'stiq.notif.prefs';

let _loaded = false;
let _prefs: NotificationPrefs = mergeWithDefaults(undefined);

/**
 * Deep-merge a (possibly partial or stale) persisted blob over DEFAULT_PREFS. Every leaf is
 * individually defaulted so a missing/malformed field never becomes `undefined` — a build that
 * adds a new pref key reads it as the default until the user actually changes it.
 */
function mergeWithDefaults(raw: unknown): NotificationPrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<NotificationPrefs> & Record<string, unknown>;
  const dms = (p.dms ?? {}) as Partial<NotificationPrefs['dms']>;
  const channels = (p.channels ?? {}) as Partial<NotificationPrefs['channels']>;
  const byType = (channels.byType ?? {}) as Partial<NotificationPrefs['channels']['byType']>;
  const postTypes = (p.postTypes ?? {}) as Partial<NotificationPrefs['postTypes']>;
  const push = (p.push ?? {}) as Partial<NotificationPrefs['push']>;
  const pushPostTypes = (push.postTypes ?? {}) as Partial<NotificationPrefs['push']['postTypes']>;

  return {
    dms: {
      enabled: typeof dms.enabled === 'boolean' ? dms.enabled : DEFAULT_PREFS.dms.enabled,
      overrides: {...DEFAULT_PREFS.dms.overrides, ...(dms.overrides ?? {})},
    },
    channels: {
      enabled: typeof channels.enabled === 'boolean' ? channels.enabled : DEFAULT_PREFS.channels.enabled,
      perChannel: {...DEFAULT_PREFS.channels.perChannel, ...(channels.perChannel ?? {})},
      byType: {
        channel: typeof byType.channel === 'boolean' ? byType.channel : DEFAULT_PREFS.channels.byType.channel,
        group: typeof byType.group === 'boolean' ? byType.group : DEFAULT_PREFS.channels.byType.group,
        broadcast: typeof byType.broadcast === 'boolean' ? byType.broadcast : DEFAULT_PREFS.channels.byType.broadcast,
      },
    },
    postTypes: {
      note: typeof postTypes.note === 'boolean' ? postTypes.note : DEFAULT_PREFS.postTypes.note,
      article: typeof postTypes.article === 'boolean' ? postTypes.article : DEFAULT_PREFS.postTypes.article,
      picture: typeof postTypes.picture === 'boolean' ? postTypes.picture : DEFAULT_PREFS.postTypes.picture,
      voice: typeof postTypes.voice === 'boolean' ? postTypes.voice : DEFAULT_PREFS.postTypes.voice,
      poll: typeof postTypes.poll === 'boolean' ? postTypes.poll : DEFAULT_PREFS.postTypes.poll,
    },
    replies: typeof p.replies === 'boolean' ? p.replies : DEFAULT_PREFS.replies,
    // Absent on every blob persisted before this category existed, so an upgrading install falls
    // through to the default (ON) — matching how these notifications already behaved when they were
    // riding the channels/dms toggles, which also defaulted ON.
    drafts: typeof p.drafts === 'boolean' ? p.drafts : DEFAULT_PREFS.drafts,
    hideNamesOnLockscreen:
      typeof p.hideNamesOnLockscreen === 'boolean' ? p.hideNamesOnLockscreen : DEFAULT_PREFS.hideNamesOnLockscreen,
    push: {
      enabled: typeof push.enabled === 'boolean' ? push.enabled : DEFAULT_PREFS.push.enabled,
      dms: typeof push.dms === 'boolean' ? push.dms : DEFAULT_PREFS.push.dms,
      channels: typeof push.channels === 'boolean' ? push.channels : DEFAULT_PREFS.push.channels,
      replies: typeof push.replies === 'boolean' ? push.replies : DEFAULT_PREFS.push.replies,
      drafts: typeof push.drafts === 'boolean' ? push.drafts : DEFAULT_PREFS.push.drafts,
      postTypes: {
        note: typeof pushPostTypes.note === 'boolean' ? pushPostTypes.note : DEFAULT_PREFS.push.postTypes.note,
        article:
          typeof pushPostTypes.article === 'boolean' ? pushPostTypes.article : DEFAULT_PREFS.push.postTypes.article,
        picture:
          typeof pushPostTypes.picture === 'boolean' ? pushPostTypes.picture : DEFAULT_PREFS.push.postTypes.picture,
        voice: typeof pushPostTypes.voice === 'boolean' ? pushPostTypes.voice : DEFAULT_PREFS.push.postTypes.voice,
        poll: typeof pushPostTypes.poll === 'boolean' ? pushPostTypes.poll : DEFAULT_PREFS.push.postTypes.poll,
      },
    },
  };
}

/** Load persisted prefs into memory once. Safe to await repeatedly. */
export async function ensurePrefsLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    if (raw) _prefs = mergeWithDefaults(JSON.parse(raw));
  } catch { /* defaults are fine */ }
}

/** Current prefs, deep-merged over DEFAULT_PREFS. Synchronous — call after ensurePrefsLoaded(). */
export function getPrefs(): NotificationPrefs {
  return _prefs;
}

/** Load (if needed) and return the current prefs. */
export async function loadPrefs(): Promise<NotificationPrefs> {
  await ensurePrefsLoaded();
  return _prefs;
}

/** Persist new prefs and update the in-memory mirror immediately (so getPrefs() reflects it). */
export async function savePrefs(next: NotificationPrefs): Promise<void> {
  _loaded = true;
  _prefs = mergeWithDefaults(next);
  try {
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(_prefs));
  } catch { /* best effort — mirror already updated, matches readState.ts */ }
}

// ─── Decision authority ───────────────────────────────────────────────────────

/**
 * SOLE authority for "should this fire?". Pure — no I/O, no reads of live prefs state. Used by
 * BOTH the push-generation path (notifications.ts composers) and the live-derived list
 * (AppRuntime.deriveNotifications).
 */
export function isNotifAllowed(prefs: NotificationPrefs, d: NotifDescriptor): boolean {
  switch (d.kind) {
    case 'dm': {
      const override = prefs.dms.overrides[d.peer];
      if (override === 'never') return false;
      if (override === 'always') return true;
      return prefs.dms.enabled;
    }
    case 'channel': {
      if (!prefs.channels.enabled) return false;
      if (!prefs.channels.byType[d.channelType]) return false;
      if (prefs.channels.perChannel[d.channelId] === false) return false;
      if (d.postType && !prefs.postTypes[d.postType]) return false;
      return true;
    }
    case 'reply': {
      if (!prefs.replies) return false;
      if (d.postType && !prefs.postTypes[d.postType]) return false;
      return true;
    }
    case 'post': {
      // The "Post types" toggles are the gate for the public-posts source (as well as refining
      // channel/reply descriptors above): switch a type off and members' posts of that type stop
      // listing in the center.
      if (d.postType && !prefs.postTypes[d.postType]) return false;
      return true;
    }
    case 'draft':
      return prefs.drafts;
  }
}

/**
 * SECOND authority, layered on top of isNotifAllowed, for "should this raise an OS push?". push ⊆
 * in-app by construction: this ALWAYS starts by requiring isNotifAllowed, so turning a category off
 * in-app turns its push off too, regardless of the push sub-model. Used ONLY by the push composers
 * (notifyDm/notifyChannel/notifyComment in ./notifications) — the live-derived notification-center
 * list keeps reading isNotifAllowed alone, so an item can be push-suppressed yet still list in-app.
 */
export function isPushAllowed(prefs: NotificationPrefs, d: NotifDescriptor): boolean {
  if (!isNotifAllowed(prefs, d)) return false;
  if (!prefs.push.enabled) return false;
  switch (d.kind) {
    case 'dm':
      return prefs.push.dms;
    case 'channel':
      if (!prefs.push.channels) return false;
      if (d.postType && !prefs.push.postTypes[d.postType]) return false;
      return true;
    case 'reply':
      if (!prefs.push.replies) return false;
      if (d.postType && !prefs.push.postTypes[d.postType]) return false;
      return true;
    case 'post':
      // No push composer exists for 'post' today (see NotifDescriptor), but the postType gate is
      // implemented for parity/future-proofing, mirroring isNotifAllowed's own 'post' case.
      if (d.postType && !prefs.push.postTypes[d.postType]) return false;
      return true;
    case 'draft':
      // Like 'post', no push composer exists for draft access yet — these are derived live in
      // AppRuntime.deriveNotifications. Implemented for parity so a push composer added later is
      // gated the moment it calls through, rather than silently pushing past a disabled category.
      return prefs.push.drafts;
  }
}

/**
 * Whether the notification title should anonymize the sender/author. dm/reply follow the
 * lockscreen pref; channel titles never carry a personal name (just the channel name), so they
 * are never hidden.
 */
export function isNameHidden(prefs: NotificationPrefs, kind: 'dm' | 'channel' | 'reply'): boolean {
  if (kind === 'channel') return false;
  return prefs.hideNamesOnLockscreen;
}
