/**
 * Notification prefs — isNotifAllowed / isNameHidden (pure decision logic) + getPrefs deep-merge
 * over a partial/stale persisted blob. AsyncStorage is mocked with the same shared in-memory
 * mockStore pattern as notifications.test.ts.
 */

// eslint-disable-next-line no-var
var mockStore: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (k: string) => Promise.resolve(mockStore[k] ?? null),
  setItem: (k: string, v: string) => {
    mockStore[k] = v;
    return Promise.resolve();
  },
  removeItem: (k: string) => {
    delete mockStore[k];
    return Promise.resolve();
  },
}));

import {DEFAULT_PREFS, isNameHidden, isNotifAllowed, isPushAllowed, type NotificationPrefs} from './prefs';

/** Build a full prefs object by overriding a few fields on top of DEFAULT_PREFS (deep enough for tests). */
function prefs(overrides: Partial<{
  dmsEnabled: boolean;
  dmOverrides: Record<string, 'always' | 'never'>;
  channelsEnabled: boolean;
  perChannel: Record<string, boolean>;
  byType: Partial<NotificationPrefs['channels']['byType']>;
  postTypes: Partial<NotificationPrefs['postTypes']>;
  replies: boolean;
  drafts: boolean;
  hideNames: boolean;
  push: Partial<{
    enabled: boolean;
    dms: boolean;
    channels: boolean;
    replies: boolean;
    drafts: boolean;
    postTypes: Partial<NotificationPrefs['push']['postTypes']>;
  }>;
}> = {}): NotificationPrefs {
  return {
    dms: {
      enabled: overrides.dmsEnabled ?? DEFAULT_PREFS.dms.enabled,
      overrides: overrides.dmOverrides ?? {},
    },
    channels: {
      enabled: overrides.channelsEnabled ?? DEFAULT_PREFS.channels.enabled,
      perChannel: overrides.perChannel ?? {},
      byType: {...DEFAULT_PREFS.channels.byType, ...(overrides.byType ?? {})},
    },
    postTypes: {...DEFAULT_PREFS.postTypes, ...(overrides.postTypes ?? {})},
    replies: overrides.replies ?? DEFAULT_PREFS.replies,
    drafts: overrides.drafts ?? DEFAULT_PREFS.drafts,
    hideNamesOnLockscreen: overrides.hideNames ?? DEFAULT_PREFS.hideNamesOnLockscreen,
    push: {
      enabled: overrides.push?.enabled ?? DEFAULT_PREFS.push.enabled,
      dms: overrides.push?.dms ?? DEFAULT_PREFS.push.dms,
      channels: overrides.push?.channels ?? DEFAULT_PREFS.push.channels,
      replies: overrides.push?.replies ?? DEFAULT_PREFS.push.replies,
      drafts: overrides.push?.drafts ?? DEFAULT_PREFS.push.drafts,
      postTypes: {...DEFAULT_PREFS.push.postTypes, ...(overrides.push?.postTypes ?? {})},
    },
  };
}

describe('isNotifAllowed', () => {
  describe('dm', () => {
    it('allows by default (master on, no override)', () => {
      expect(isNotifAllowed(prefs(), {kind: 'dm', peer: 'alice'})).toBe(true);
    });

    it('blocks all DMs when master is off', () => {
      expect(isNotifAllowed(prefs({dmsEnabled: false}), {kind: 'dm', peer: 'alice'})).toBe(false);
    });

    it('per-user "always" overrides a master-off', () => {
      const p = prefs({dmsEnabled: false, dmOverrides: {alice: 'always'}});
      expect(isNotifAllowed(p, {kind: 'dm', peer: 'alice'})).toBe(true);
      // Unrelated peer still blocked by master-off.
      expect(isNotifAllowed(p, {kind: 'dm', peer: 'bob'})).toBe(false);
    });

    it('per-user "never" overrides a master-on (the "banned" case)', () => {
      const p = prefs({dmsEnabled: true, dmOverrides: {alice: 'never'}});
      expect(isNotifAllowed(p, {kind: 'dm', peer: 'alice'})).toBe(false);
      expect(isNotifAllowed(p, {kind: 'dm', peer: 'bob'})).toBe(true);
    });
  });

  describe('channel', () => {
    it('allows by default (master on, byType on, no per-channel entry, no postType)', () => {
      const d = {kind: 'channel', channelId: 'ch1', channelType: 'channel'} as const;
      expect(isNotifAllowed(prefs(), d)).toBe(true);
    });

    it('blocks everything when the channels master is off', () => {
      const d = {kind: 'channel', channelId: 'ch1', channelType: 'channel'} as const;
      expect(isNotifAllowed(prefs({channelsEnabled: false}), d)).toBe(false);
    });

    it('blocks a channel TYPE that is switched off', () => {
      const p = prefs({byType: {group: false}});
      expect(isNotifAllowed(p, {kind: 'channel', channelId: 'g1', channelType: 'group'})).toBe(false);
      // Other types unaffected.
      expect(isNotifAllowed(p, {kind: 'channel', channelId: 'c1', channelType: 'channel'})).toBe(true);
    });

    it('blocks a specific channel switched off via perChannel', () => {
      const p = prefs({perChannel: {ch1: false}});
      expect(isNotifAllowed(p, {kind: 'channel', channelId: 'ch1', channelType: 'channel'})).toBe(false);
      // A channel absent from perChannel defaults to allowed.
      expect(isNotifAllowed(p, {kind: 'channel', channelId: 'ch2', channelType: 'channel'})).toBe(true);
    });

    it('an explicit perChannel:true does not get overridden by anything else', () => {
      const p = prefs({perChannel: {ch1: true}});
      expect(isNotifAllowed(p, {kind: 'channel', channelId: 'ch1', channelType: 'channel'})).toBe(true);
    });

    it('gates on postType when the channel post carries one (broadcast-of-a-post-type)', () => {
      const p = prefs({postTypes: {picture: false}});
      expect(
        isNotifAllowed(p, {kind: 'channel', channelId: 'ch1', channelType: 'channel', postType: 'picture'}),
      ).toBe(false);
      expect(
        isNotifAllowed(p, {kind: 'channel', channelId: 'ch1', channelType: 'channel', postType: 'note'}),
      ).toBe(true);
      // No postType (plain live-chat message) is never gated by postTypes.
      expect(isNotifAllowed(p, {kind: 'channel', channelId: 'ch1', channelType: 'channel'})).toBe(true);
    });
  });

  describe('reply', () => {
    it('allows by default', () => {
      expect(isNotifAllowed(prefs(), {kind: 'reply'})).toBe(true);
    });

    it('blocks all replies when the replies switch is off', () => {
      expect(isNotifAllowed(prefs({replies: false}), {kind: 'reply'})).toBe(false);
    });

    it('gates on postType when the replied-to post carries one', () => {
      const p = prefs({postTypes: {article: false}});
      expect(isNotifAllowed(p, {kind: 'reply', postType: 'article'})).toBe(false);
      expect(isNotifAllowed(p, {kind: 'reply', postType: 'note'})).toBe(true);
      expect(isNotifAllowed(p, {kind: 'reply'})).toBe(true);
    });
  });

  describe('post (public-posts notification source)', () => {
    it('allows by default', () => {
      expect(isNotifAllowed(prefs(), {kind: 'post', postType: 'note'})).toBe(true);
      expect(isNotifAllowed(prefs(), {kind: 'post'})).toBe(true);
    });

    it('gates on the postTypes toggles', () => {
      const p = prefs({postTypes: {poll: false}});
      expect(isNotifAllowed(p, {kind: 'post', postType: 'poll'})).toBe(false);
      expect(isNotifAllowed(p, {kind: 'post', postType: 'note'})).toBe(true);
    });
  });
});

describe('isPushAllowed (push ⊆ in-app: isNotifAllowed AND the push sub-model)', () => {
  it('defaults preserve current behavior byte-for-byte: everything that is in-app-allowed also pushes', () => {
    expect(isPushAllowed(prefs(), {kind: 'dm', peer: 'alice'})).toBe(true);
    expect(isPushAllowed(prefs(), {kind: 'channel', channelId: 'ch1', channelType: 'channel'})).toBe(true);
    expect(isPushAllowed(prefs(), {kind: 'reply'})).toBe(true);
    expect(isPushAllowed(prefs(), {kind: 'post', postType: 'note'})).toBe(true);
  });

  it('push.enabled=false suppresses push for every category while isNotifAllowed stays true (in-app unaffected)', () => {
    const p = prefs({push: {enabled: false}});
    const d = {kind: 'dm', peer: 'alice'} as const;
    expect(isNotifAllowed(p, d)).toBe(true);
    expect(isPushAllowed(p, d)).toBe(false);
  });

  it('per-category push-off (dms) suppresses push only, in-app list is untouched', () => {
    const p = prefs({push: {dms: false}});
    const d = {kind: 'dm', peer: 'alice'} as const;
    expect(isNotifAllowed(p, d)).toBe(true);
    expect(isPushAllowed(p, d)).toBe(false);
    // Unrelated category (channel) still pushes.
    const chan = {kind: 'channel', channelId: 'ch1', channelType: 'channel'} as const;
    expect(isPushAllowed(p, chan)).toBe(true);
  });

  it('per-category push-off (channels) suppresses channel push only', () => {
    const p = prefs({push: {channels: false}});
    expect(isPushAllowed(p, {kind: 'channel', channelId: 'ch1', channelType: 'channel'})).toBe(false);
    expect(isPushAllowed(p, {kind: 'dm', peer: 'alice'})).toBe(true);
  });

  it('per-category push-off (replies) suppresses reply push only', () => {
    const p = prefs({push: {replies: false}});
    expect(isPushAllowed(p, {kind: 'reply'})).toBe(false);
    expect(isPushAllowed(p, {kind: 'dm', peer: 'alice'})).toBe(true);
  });

  it('push.postTypes gates a channel/reply/post push carrying that postType', () => {
    const p = prefs({push: {postTypes: {picture: false}}});
    expect(
      isPushAllowed(p, {kind: 'channel', channelId: 'ch1', channelType: 'channel', postType: 'picture'}),
    ).toBe(false);
    expect(isPushAllowed(p, {kind: 'reply', postType: 'picture'})).toBe(false);
    expect(isPushAllowed(p, {kind: 'post', postType: 'picture'})).toBe(false);
    // Unaffected postType still pushes.
    expect(isPushAllowed(p, {kind: 'reply', postType: 'note'})).toBe(true);
  });

  it('in-app off ⇒ push off regardless of the push sub-model (⊆ relationship holds even with every push field on)', () => {
    // dms master off in-app, but every push field explicitly true.
    const p = prefs({dmsEnabled: false, push: {enabled: true, dms: true}});
    expect(isNotifAllowed(p, {kind: 'dm', peer: 'alice'})).toBe(false);
    expect(isPushAllowed(p, {kind: 'dm', peer: 'alice'})).toBe(false);

    // A per-user "never" override blocks in-app -> blocks push too, even with push.dms on.
    const p2 = prefs({dmOverrides: {bob: 'never'}, push: {dms: true}});
    expect(isNotifAllowed(p2, {kind: 'dm', peer: 'bob'})).toBe(false);
    expect(isPushAllowed(p2, {kind: 'dm', peer: 'bob'})).toBe(false);

    // A postType switched off in-app blocks both, even with push.postTypes on for it.
    const p3 = prefs({postTypes: {article: false}, push: {postTypes: {article: true}}});
    expect(isNotifAllowed(p3, {kind: 'reply', postType: 'article'})).toBe(false);
    expect(isPushAllowed(p3, {kind: 'reply', postType: 'article'})).toBe(false);
  });

  it('a per-user "always" override still requires the push gate on top', () => {
    // In-app: "always" forces isNotifAllowed true even with dms master off. Push still needs push.dms.
    const p = prefs({dmsEnabled: false, dmOverrides: {alice: 'always'}, push: {dms: false}});
    expect(isNotifAllowed(p, {kind: 'dm', peer: 'alice'})).toBe(true);
    expect(isPushAllowed(p, {kind: 'dm', peer: 'alice'})).toBe(false);
  });
});

describe('isNameHidden', () => {
  it('follows hideNamesOnLockscreen for dm and reply', () => {
    expect(isNameHidden(prefs({hideNames: true}), 'dm')).toBe(true);
    expect(isNameHidden(prefs({hideNames: false}), 'dm')).toBe(false);
    expect(isNameHidden(prefs({hideNames: true}), 'reply')).toBe(true);
    expect(isNameHidden(prefs({hideNames: false}), 'reply')).toBe(false);
  });

  it('is always false for channel, regardless of the pref', () => {
    expect(isNameHidden(prefs({hideNames: true}), 'channel')).toBe(false);
    expect(isNameHidden(prefs({hideNames: false}), 'channel')).toBe(false);
  });
});

describe('getPrefs deep-merge over a partial persisted blob', () => {
  const PREFS_KEY = 'stiq.notif.prefs';

  beforeEach(() => {
    mockStore = {};
    jest.resetModules();
  });

  it('fills in missing top-level and nested keys from DEFAULT_PREFS', async () => {
    // Simulate an older build's persisted blob: only dms.enabled and one postType were ever saved,
    // everything else (channels, replies, hideNamesOnLockscreen, other postTypes) is absent.
    mockStore[PREFS_KEY] = JSON.stringify({
      dms: {enabled: false},
      postTypes: {picture: false},
    });

    const mod = require('./prefs');
    await mod.ensurePrefsLoaded();
    const merged = mod.getPrefs();

    expect(merged.dms.enabled).toBe(false);
    expect(merged.dms.overrides).toEqual({});
    expect(merged.channels).toEqual(mod.DEFAULT_PREFS.channels);
    expect(merged.postTypes.picture).toBe(false);
    expect(merged.postTypes.note).toBe(true); // untouched key defaults safely
    expect(merged.replies).toBe(true);
    expect(merged.hideNamesOnLockscreen).toBe(false);
    // The blob predates the push split entirely (no `push` key at all) -> defaults to all-on, so an
    // upgrading install's push behavior is unchanged from before the split.
    expect(merged.push).toEqual(mod.DEFAULT_PREFS.push);
  });

  it('a stale blob lacking the `push` key entirely merges to all-push-on (upgrade parity)', async () => {
    // A realistic pre-push-split persisted blob: full old shape, no `push` field whatsoever.
    mockStore[PREFS_KEY] = JSON.stringify({
      dms: {enabled: true, overrides: {}},
      channels: {enabled: true, perChannel: {}, byType: {channel: true, group: true, broadcast: true}},
      postTypes: {note: true, article: true, picture: true, voice: true, poll: true},
      replies: true,
      hideNamesOnLockscreen: false,
    });

    const mod = require('./prefs');
    await mod.ensurePrefsLoaded();
    const merged = mod.getPrefs();

    expect(merged.push).toEqual({
      enabled: true,
      dms: true,
      channels: true,
      replies: true,
      // Absent from any blob written before the shared-drafts category existed, so it merges to the
      // default (ON) — the same upgrade-parity rule every other key here is asserting.
      drafts: true,
      postTypes: {note: true, article: true, picture: true, voice: true, poll: true},
    });
    // And isPushAllowed behaves exactly as isNotifAllowed would have pre-split, for every kind.
    const {isNotifAllowed, isPushAllowed} = mod;
    for (const d of [
      {kind: 'dm', peer: 'alice'},
      {kind: 'channel', channelId: 'ch1', channelType: 'channel'},
      {kind: 'reply'},
      {kind: 'post', postType: 'note'},
    ] as const) {
      expect(isPushAllowed(merged, d)).toBe(isNotifAllowed(merged, d));
    }
  });

  it('a partial `push` blob (only some push fields ever saved) still defaults the rest to on', async () => {
    mockStore[PREFS_KEY] = JSON.stringify({
      push: {dms: false},
    });

    const mod = require('./prefs');
    await mod.ensurePrefsLoaded();
    const merged = mod.getPrefs();

    expect(merged.push.dms).toBe(false);
    expect(merged.push.enabled).toBe(true);
    expect(merged.push.channels).toBe(true);
    expect(merged.push.replies).toBe(true);
    expect(merged.push.postTypes).toEqual(mod.DEFAULT_PREFS.push.postTypes);
  });

  it('loadPrefs/savePrefs round-trip through the mocked store and update the mirror', async () => {
    const mod = require('./prefs');
    const next = {
      ...mod.DEFAULT_PREFS,
      replies: false,
      dms: {enabled: false, overrides: {alice: 'never'}},
    };
    await mod.savePrefs(next);

    expect(mod.getPrefs().replies).toBe(false);
    expect(mod.getPrefs().dms.overrides).toEqual({alice: 'never'});
    expect(JSON.parse(mockStore[PREFS_KEY]!).replies).toBe(false);

    // A second module instance loads the same persisted value.
    jest.resetModules();
    const mod2 = require('./prefs');
    const loaded = await mod2.loadPrefs();
    expect(loaded.replies).toBe(false);
    expect(loaded.dms.overrides).toEqual({alice: 'never'});
  });

  it('defaults cleanly with nothing persisted at all', async () => {
    const mod = require('./prefs');
    const loaded = await mod.loadPrefs();
    expect(loaded).toEqual(mod.DEFAULT_PREFS);
  });
});

describe('draft access (shared drafts) — its own category, not a borrowed one', () => {
  // These notifications first shipped riding the group-channel descriptor (owner side) and the DM
  // descriptor (requester side), because no dedicated category existed. That coupling meant
  // silencing draft chatter also silenced group-join requests and DMs. These pin the decoupling.
  it('is allowed by default, both halves', () => {
    expect(isNotifAllowed(prefs(), {kind: 'draft', event: 'request'})).toBe(true);
    expect(isNotifAllowed(prefs(), {kind: 'draft', event: 'granted'})).toBe(true);
  });

  it('is silenced by its own switch, both halves', () => {
    const p = prefs({drafts: false});
    expect(isNotifAllowed(p, {kind: 'draft', event: 'request'})).toBe(false);
    expect(isNotifAllowed(p, {kind: 'draft', event: 'granted'})).toBe(false);
  });

  it('is INDEPENDENT of the channels/group and dm switches it used to borrow', () => {
    // Turning off group channels must no longer silence draft requests...
    const noGroups = prefs({byType: {group: false}});
    expect(isNotifAllowed(noGroups, {kind: 'draft', event: 'request'})).toBe(true);
    // ...and turning off DMs must no longer silence draft approvals.
    const noDms = prefs({dmsEnabled: false});
    expect(isNotifAllowed(noDms, {kind: 'draft', event: 'granted'})).toBe(true);
  });

  it('does not leak the other way either — silencing drafts leaves groups and DMs alone', () => {
    const p = prefs({drafts: false});
    expect(isNotifAllowed(p, {kind: 'channel', channelId: 'g1', channelType: 'group'})).toBe(true);
    expect(isNotifAllowed(p, {kind: 'dm', peer: 'p1'})).toBe(true);
  });

  it('push is gated by its own switch and still requires the in-app category (push ⊆ in-app)', () => {
    expect(isPushAllowed(prefs(), {kind: 'draft', event: 'request'})).toBe(true);
    expect(isPushAllowed(prefs({push: {drafts: false}}), {kind: 'draft', event: 'request'})).toBe(false);
    // In-app off ⇒ push off regardless of the push sub-switch.
    expect(isPushAllowed(prefs({drafts: false, push: {drafts: true}}), {kind: 'draft', event: 'granted'})).toBe(false);
  });
});
