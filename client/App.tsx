/**
 * Root component.
 *
 * Bootstraps the bundled Tor daemon (PLAN.md §3.2) and drives the AppShell from a live
 * AppRuntime: enrollment, lock state, and feed are derived from the real pieces, not
 * hardcoded. A blank app (or a build without the native secure store) resolves to
 * onboarding; once enrolled + unlocked it shows the feed (which reads from cache, so it
 * renders even while Tor is offline).
 *
 * On device, `secureStorage` is the native keystore, `store` is SQLite, and a Tor-routed
 * RelayClient supplies `publish` + cache updates. Here those native pieces are absent, so
 * the app resolves to onboarding — driven by real logic (see AppRuntime tests).
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Alert, AppState, DeviceEventEmitter, InteractionManager, Linking, PermissionsAndroid, Platform, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View} from 'react-native';

// Ask Tor for fresh circuits. Onion rendezvous circuits are per-circuit flaky on a throttling
// network, so the relay-retry path rotates the circuit instead of reusing the dead one.
const requestNewTorCircuit = (): void => {
  try {
    // Resolves NativeModules.StiqArti via getTorDaemonControl() rather than reading it directly —
    // see daemonControl.ts for why every off-seam native call is routed through that one chokepoint.
    getTorDaemonControl()?.newCircuit?.();
  } catch {
    // native module absent (non-Android build) — ignore
  }
};
import {ErrorBoundary} from './src/app/ErrorBoundary';
import {
  createTorManager,
  deriveOnionAuth,
  getActiveOnionAuth,
  getTorDaemonControl,
  type OnionAuth,
  type TorManager,
} from './src/tor';
// Not yet re-exported from './src/tor' (P2 multi-mirror onion-auth, synthesis §1.7/§1.9) — imported
// straight from the module, matching this file's existing direct-module imports (e.g. './src/tor/bridges').
import {getActiveOnionAuthExtra, preserveDisplacedActivePrimary} from './src/tor/onionAuth';
import type {ConnectionState} from './src/connection';
import {AppShell} from './src/app';
import {StiqAlertHost} from './src/ui/StiqAlert';
import {Toast} from './src/ui/Toast';
import {SplashScreen} from './src/app/screens/SplashScreen';
import {colors, radius, space, type as typeScale, weight} from './src/ui/theme';
import {AppRuntime, type AppSnapshot} from './src/app/AppRuntime';
import {createDeferredSlot, type DeferredSlot} from './src/app/deferredSnapshotSlot';
import {EMPTY_TOKEN_STATUS} from './src/app/tokenEconomyStatus';
import {isCurrentInitAttempt} from './src/app/initAttempt';
import {MAX_JOIN_CODE_LEN, enrollKeyMatchesCid} from './src/onboarding/join';
import {urlHost, getQueryParam} from './src/util/url';
import {log} from './src/util/log';
import {InMemoryEventStore, PersistentEventStore, SwappableEventStore, type EventStore} from './src/nostr/store';
import {createEncryptedEventStore} from './src/nostr/sqliteFactory';
import {createSecureStorage} from './src/keys';
import type {SecureStorage} from './src/keys/keystore';
import type {RelayClientOptions} from './src/nostr/RelayClient';
import {createEventVerifier} from './src/nostr/nativeVerify';
import {MirrorSet} from './src/nostr/MirrorSet';
import {
  relayBackoffMs,
  shouldRotateCircuit,
  isTransportCondemned,
} from './src/nostr/reconnectBackoff';
import {createFeedAndDmPlan, buildFeedFilter, buildReconcileFilter, SYNC_ROUTINE_WINDOW_SECONDS, TEXT_ONLY_FEED_KINDS, highWaterSince, FEED_KINDS, FIREHOSE_FEED_KINDS, groupChatSince, channelChatSince, buildOpenChatFilters, buildSpaceKeyRecoveryFilters} from './src/nostr/subscriptionPlan';
import {loadWatermark, saveWatermark, setWatermarkRuntime, getWatermarkRuntime} from './src/nostr/syncWatermark';
import {recordSyncStat} from './src/nostr/syncStats';
import {buildFeedSnapshot, saveFeedSnapshot, loadFeedSnapshot} from './src/nostr/feedSnapshot';
import {prefetchPriorityContent} from './src/nostr/prefetch';
import {communityId, CommunityStore} from './src/communities/communityStore';
import {setJoinStateResolver} from './src/channels/spaceCta';
import {setEventLiveResolver} from './src/events/eventCardState';
import {setReminderStorage} from './src/events/reminders';
import type {EventsApi} from './src/events/api';
import {toRetentionPolicy, type ModScope} from './src/moderation/organizerConfig';
import {randomizedSyncPeriodMinutes, SYNC_FLEX_MINUTES} from './src/background/syncSchedule';
import {pushEnabled, buildRegistration, registerWithWatcher, registerApp, getDistributor, getEndpoint, hasUnifiedPushModule} from './src/push/unifiedPush';
import {Kind, GroupKind, type Event} from './src/contracts';
import {createTorRelaySocket} from './src/nostr/torSocket';
import {torFetchText} from './src/media/torHttp';
import {getActiveCommunityKey} from './src/blind/communityKey';
import {warmAuthorResolution} from './src/blind/identity';
import {RELAY_ONION_WS, ENROLL_POW_DIFFICULTY, ORGANIZER_NPUB, NEGENTROPY_SYNC, COLD_FEED_LIMIT, RELAY_SUPPORTS_NIP29, GUIDED_AUTO_LADDER, TOR_DORMANCY, T4_METRIC, COMMUNITY_SEEDED_BRIDGES, SYNC_TOR_TUNING, SYNC_LOW_BANDWIDTH, SYNC_TOR_BUCKETS, SYNC_TOR_FRAME_BYTES, COMPACTION_V2, PUSH_UNIFIEDPUSH, TIMING_JITTER, APK_UPDATES, AUTO_LOCK_MS, LOCK_ON_BACKGROUND, IDLE_LOCK_ENABLED, SCOPED_CHANNEL_SYNC} from './src/config';
// Signed in-app APK updates (T9, ship-dark behind APK_UPDATES). Fed the active community's join-code
// update repo (up/uf/af/ua) resolved below; both entry points no-op with the flag off / native module
// absent, so importing them is inert until a supported build with a repo-carrying community.
import {checkForUpdate, downloadAndInstall, type UpdateRepoConfig} from './src/update/updater';
import {DEFAULT_TAG_POLICY, KIND_TAG_POLICY} from './src/feed/tagPolicy';
import {DEFAULT_LABELS} from './src/feed/labels';
import {DEFAULT_POST_RULES} from './src/feed/postRules';
import {DEFAULT_PICTURE_RULES} from './src/feed/pictureRules';
import {DEFAULT_AUDIO_RULES} from './src/feed/audioRules';
import {DEFAULT_REASONS} from './src/moderation/reasons';
import {DEFAULT_RANKING} from './src/feed/sort';
import {RemovalSheet} from './src/moderation/components/RemovalSheet';
import {BanSheet} from './src/moderation/components/BanSheet';
import type {PostLabel} from './src/feed/labels';
import {
  prepareCredentialExchange,
  runCredentialExchange,
  type ExchangeResult,
  type PreparedCredentialExchange,
  type CircuitHooks,
} from './src/onboarding/exchange';
import {RealBlindRsa} from './src/onboarding/realBlindRsa';
import type {Community} from './src/onboarding/community';
import type {Session} from './src/onboarding/enrollment';
import {
  startCommunityPrefetch,
  type CommunityPrefetch,
} from './src/onboarding/prefetchCommunity';
import {parseRelayCapabilities} from './src/nostr/capabilities';
import {fetchFreshBridges} from './src/tor/bridgeFetch';
import {createBootstrapCoalescer} from './src/tor/bootstrapCoalescer';
import {
  BRIDGE_LADDER,
  DEFAULT_OBFS4_BRIDGES,
  DEFAULT_SNOWFLAKE_BRIDGES,
  PREFERRED_TRANSPORT,
  defaultBridgeLines,
  pickRandom,
} from './src/tor/bridges';
import type {BootstrapProgress, TransportType} from './src/tor/types';
import {
  customBridgesForTransport,
  DEFAULT_TOR_PREFS,
  getTorConnectionPrefs,
  inferCustomTransport,
  TorSettingsStore,
  validateBridgeLine,
  type TorConnectionPrefs,
} from './src/tor/torSettings';
import {
  loadCachedBridges,
  saveCachedBridges,
  clearCachedBridges,
  loadCachedBridgesForClass,
  saveCachedBridgesForClass,
  clearCachedBridgesForClass,
  loadFetchedBridges,
  saveFetchedBridges,
} from './src/tor/bridgeCache';
// Guided auto-fallback ladder (T2): pure model consumed by connectGuided() below.
import {
  AUTO_LADDER,
  describePhase,
  nextRungIndex,
  type AutoRung,
  type ConnectionPhase,
} from './src/tor/ladder';
// Coarse network class for the per-network-class warm cache (T2-S2).
import {getNetworkClass} from './src/tor/daemonControl';
// Native dormancy transitions (T4): SIGNAL DORMANT/ACTIVE instead of a force-kill on background.
import {torDormant, torActive} from './src/tor/dormancy';
// Battery-optimization exemption nudge (Tor stability+speed, contract C3 — the single App.tsx call
// site for W3's reliability module; the detailed OEM guidance sheet lives in Settings → Reliability).
import {
  maybePromptReliability,
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
  setReliabilityPromptDismissed,
} from './src/power/reliability';
import {workManager} from './src/background/syncTask';
import {
  setForegroundOwnsTor,
  backgroundSyncOwnsTorNow,
  requestBackgroundSyncAbort,
  waitForBackgroundSyncRelease,
  runYieldingToBackgroundSync,
  setDormantDaemon,
} from './src/tor/foregroundLock';
import type {Draft, DraftStoreApi} from './src/feed/drafts';
import {setMediaService, createMediaService} from './src/media/mediaService';
import {setMediaBlobService, createMediaBlobService} from './src/media/mediaBlobService';
import {LinkDialogHost} from './src/ui/LinkDialog';
import {listInstalledBrowsers} from './src/browser/browserData';
import {setPreferredBrowserWriter} from './src/browser/browserSettings';
import {
  setNotificationProvider,
  encodeNavTarget,
  decodeNavTarget,
  type NavTarget,
} from './src/notifications/notifications';
import {DEFAULT_PREFS, type NotificationPrefs} from './src/notifications/prefs';

// @notifee/react-native requires its native module to be compiled into the APK. Guard the
// import so the app launches (with notifications silently disabled) when the native module
// is absent (e.g. APKs built before notifee was added to the native build).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let notifee: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let NotifeeEventType: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const notifeeModule = require('@notifee/react-native');
  notifee = notifeeModule.default;
  NotifeeEventType = notifeeModule.EventType;
} catch { /* native module not linked — notifications are a no-op */ }

function tryCreateSecureStorage(): SecureStorage | null {
  try {
    return createSecureStorage();
  } catch {
    return null; // native keystore not present on this build
  }
}

async function requestNotificationPermission(): Promise<void> {
  // iOS: notifications require an explicit UNUserNotificationCenter authorization request, which
  // notifee.requestPermission() wraps. It is called NOWHERE else, so without this every
  // displayNotification() silently no-ops forever on iOS. Fire it and return (no PermissionsAndroid
  // on iOS). Best-effort — a denied grant just means no local notifications, never a crash.
  if (Platform.OS === 'ios') {
    try { await notifee?.requestPermission(); } catch { /* notifee absent or denied — no-op */ }
    return;
  }
  // POST_NOTIFICATIONS is required on Android 13+ for TorService to show its
  // foreground notification. Without it the service may be killed by the OS.
  if (
    Platform.OS === 'android' &&
    typeof Platform.Version === 'number' &&
    Platform.Version >= 33
  ) {
    const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (perm) { await PermissionsAndroid.request(perm); }
  }
}

const INITIAL: AppSnapshot = {
  enrolled: false,
  lock: 'locked',
  pinEnabled: true,
  feed: {items: [], log: []},
  inbox: [],
  channels: [],
  subscribedChannelIds: [],
  notifUnreadCount: 0,
  groups: [],
  spaceInvites: [],
  joiningSpaces: [],
  currentUserPubkey: null,
  isModerator: false,
  modScopes: [],
  sendStatus: new Map(),
  sendReasons: new Map(),
  sendQueuedOffline: new Set(),
  postsDelivered: 0,
  tagPolicy: DEFAULT_TAG_POLICY,
  labels: DEFAULT_LABELS,
  postRules: DEFAULT_POST_RULES,
  postingGuidelines: null,
  communityName: null,
  communityCid: null,
  reasons: DEFAULT_REASONS,
  ranking: DEFAULT_RANKING,
  allowVoice: false,
  pictureRules: DEFAULT_PICTURE_RULES,
  audioRules: DEFAULT_AUDIO_RULES,
  picturesSpentBytes: 0,
  bookmarkedPostIds: [],
  lockedPostIds: [],
  pinnedPostIds: [],
  storeVersions: {channels: 0, groups: 0, identity: 0, thread: 0, config: 0},
  syncing: false,
  tokenStatus: EMPTY_TOKEN_STATUS,
};

/**
 * Shown when `runtime.init()` blows past the timeout raced against it in the App effect (see
 * `attemptInit`) — e.g. a corrupt/locked per-community SQLCipher DB whose open() never resolves.
 * Deliberately NOT the normal feed/lock chrome: the runtime may be only half set up (identity/
 * store unresolved), so routing there risks rendering over broken state. Retry re-runs the same
 * init()-vs-timeout race; if init later finishes on its own (just slow, not permanently stuck),
 * the effect's own completion handler clears this screen and hands off to the real UI with no
 * user action needed.
 */
function InitRecoveryScreen({onRetry}: {onRetry: () => void}): React.JSX.Element {
  return (
    <SafeAreaView style={recoveryStyles.root}>
      <View style={recoveryStyles.card}>
        <Text style={recoveryStyles.title}>Couldn’t finish loading</Text>
        <Text style={recoveryStyles.body}>
          Stiq is taking longer than expected to start. This can happen if a local database is
          locked or damaged. Try again — if it keeps happening, give it a moment and reopen the
          app.
        </Text>
        <Pressable style={recoveryStyles.btn} onPress={onRetry}>
          <Text style={recoveryStyles.btnText}>Retry</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const recoveryStyles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: space.xl},
  card: {maxWidth: 360, alignItems: 'center'},
  title: {fontSize: typeScale.heading, fontWeight: weight.bold, color: colors.textPrimary, marginBottom: space.md, textAlign: 'center'},
  body: {fontSize: typeScale.body, color: colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: space.xl},
  btn: {backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: space.md, paddingHorizontal: space.xl},
  btnText: {color: colors.onAccent, fontSize: typeScale.label, fontWeight: weight.semibold},
});

function App(): React.JSX.Element {
  const [connection, setConnection] = useState<ConnectionState>('disconnected');
  // Whether the relay has synced at least once this process. Set on the first relay onSynced, which
  // is a STRICTLY stronger signal than Tor 'connected': it means an onion rendezvous completed and
  // the feed drained, i.e. we are past the fragile window rather than merely holding a circuit.
  // Only consumer today is the reliability nudge, which must not steal focus mid-rendezvous.
  const [relayEverSynced, setRelayEverSynced] = useState(false);
  // Live Tor bootstrap progress (real percent + Tor's own summary), surfaced so the onboarding
  // connect step shows the actual circuit coming up instead of a faked timer. Null when not
  // bootstrapping (disconnected / offline / pre-start).
  const [torBootstrap, setTorBootstrap] = useState<BootstrapProgress | null>(null);
  // Guided auto-ladder plain-language phase (T2, ship-dark behind GUIDED_AUTO_LADDER). Null when the
  // flag is off (byte-identical to today) or when there is no live guided attempt to narrate; set by
  // connectGuided() at every rung transition/ceiling and reset to null on the same onChange
  // 'offline'/'disconnected' branch that nulls torBootstrap. Consumed by the onboarding connect step
  // + shell banner in T2-S5 (a separate UI subtask); intentionally not yet threaded into a render
  // prop here so this subtask touches only App.tsx.
  const [torPhase, setTorPhase] = useState<ConnectionPhase | null>(null);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(INITIAL);
  /**
   * Coalescing slot for NON-URGENT (throttled relay-churn) snapshots — see the runtime.subscribe
   * handler in the mount effect for why those are deferred through InteractionManager rather than
   * applied inline, and deferredSnapshotSlot.ts for the two guards (coalesce + supersede) it
   * enforces and the bugs each one prevents.
   *
   * Lives at COMPONENT scope, not inside the mount effect where this logic used to be a pair of
   * `let`s: a queued flush holds an OLDER snapshot, so any code path that applies a fresher one
   * directly must be able to cancel it — and an effect-local closure is unreachable from the
   * component body. handleMarkFeedSeen below is exactly such a path.
   *
   * `useRef(...)` rather than `useMemo`: this must be created exactly once for the component's
   * lifetime (a re-created slot would silently orphan a queued flush), which useMemo does not
   * guarantee. The lazy-init dance keeps the factory from running on every render.
   */
  const nonUrgentFlushRef = useRef<DeferredSlot<AppSnapshot> | null>(null);
  if (nonUrgentFlushRef.current === null) {
    // No `disposed` guard needed on the apply: the mount effect's cleanup calls
    // cancelPendingSnapshotFlush(), and cancel() RETIRES the scheduled handle rather than leaving it
    // to fire and no-op — so a flush cannot run after teardown at all. (That is precisely the
    // difference between the two guards; see deferredSnapshotSlot.ts.)
    nonUrgentFlushRef.current = createDeferredSlot<AppSnapshot>(setSnapshot, cb =>
      InteractionManager.runAfterInteractions(cb),
    );
  }
  const nonUrgentFlush = nonUrgentFlushRef.current;
  /**
   * Drop any queued non-urgent flush. MUST be called immediately before any setSnapshot() that
   * applies a fresher snapshot outside the deferral path (an urgent emit, or a direct read like
   * handleMarkFeedSeen's) — otherwise the queued flush later overwrites it with older state.
   */
  const cancelPendingSnapshotFlush = useCallback((): void => {
    nonUrgentFlush.cancel();
  }, [nonUrgentFlush]);
  // False until AppRuntime.init() has read the keystore and emitted the real enrolled state. The
  // initial snapshot defaults to enrolled:false, so without this gate an already-enrolled user
  // would see a flash of the onboarding welcome on every cold start before the lock screen appears.
  const [hydrated, setHydrated] = useState(false);
  // True once runtime.init() has blown past its timeout (see attemptInit in the mount effect) —
  // e.g. a corrupt/locked per-community DB whose open() never resolves. `hydrated` still flips
  // true so the splash hands off, but to a dedicated recovery screen instead of the normal
  // feed/lock (which would render over a half-initialized runtime). Cleared automatically if the
  // same init() later finishes on its own, or by a Retry that re-runs the race.
  const [initTimedOut, setInitTimedOut] = useState(false);
  // A moderator/channel-owner hide is pending a reason pick (drives the RemovalSheet).
  const [pendingRemoval, setPendingRemoval] = useState<
    {kind: 'post' | 'channel'; targetId: string; authorPubkey?: string} | null
  >(null);
  // A "hide user" action opens the ban sheet (message + duration).
  const [pendingBan, setPendingBan] = useState<{pubkey: string} | null>(null);
  // A member "Report" opens the same reason sheet so reports use the organizer's reason buckets.
  const [pendingReport, setPendingReport] = useState<{postId: string; authorPubkey: string} | null>(null);
  const [incomingJoinCode, setIncomingJoinCode] = useState<string | null>(null);
  // A tap on a delivered notification routes here (foreground/background live taps, or a
  // cold-start launch via notifee.getInitialNotification — see the setup effect below). Mirrors
  // the incomingJoinCode/onJoinCodeConsumed consumed-signal pattern.
  const [pendingNav, setPendingNav] = useState<NavTarget | null>(null);
  // True while "Join another community" is running the onboarding flow in ADD mode over the live
  // app (the user is already enrolled; this is additive — a new identity slot + community).
  const [addCommunityMode, setAddCommunityMode] = useState(false);
  // Active community's signed-update trust anchor (T9, ship-dark behind APK_UPDATES). Resolved from
  // the active EnrolledCommunity's join-code update fields (up/uf/af/ua) by the effect below; null
  // until a repo-carrying community is active. Drives the Settings "App updates" section's data-driven
  // gate. Stays null forever with the flag off (the effect early-returns), so the section stays hidden.
  const [updateCfg, setUpdateCfg] = useState<UpdateRepoConfig | null>(null);
  const runtimeRef = useRef<AppRuntime | null>(null);
  // Mirrors setup()'s local `relay` variable (a RelayClient instance, reassigned deep inside that
  // async closure on connect/disconnect/community-switch/teardown) so the render body can reach the
  // LIVE relay for one-shot scroll-back pagination (bug #3) — the same "ref shadows a closure-local"
  // pattern runtimeRef uses for the runtime itself.
  const relayRef = useRef<MirrorSet | null>(null);
  // Thin scroll-back pagination wrappers (bug #3) — one-shot REQs for older history past whatever a
  // surface has cached locally. requestOlder itself dedupes an in-flight page by subKey; MainScreen
  // adds its own re-entrancy guard on top so a stationary scroll doesn't refire every tick.
  const requestOlderFeed = (until: number): void => {
    // FIREHOSE_FEED_KINDS, not FEED_KINDS: scroll-back must ask for exactly the universe the firehose
    // owns. Under SCOPED_CHANNEL_SYNC channel messages are not in it — paging the feed back in time
    // would otherwise re-pull every channel's history unscoped, which is the bug. A channel's own
    // scroll-back has always had its own scoped primitive (requestOlderChannelPage, just below).
    relayRef.current?.requestOlder({subKey: 'feed', filter: {kinds: FIREHOSE_FEED_KINDS}, until});
  };
  const requestOlderChannelPage = (coordinate: string, until: number): void => {
    // Channel messages (kind 1311) carry an `['a', coordinate, '', 'root']` tag — see channels.ts.
    relayRef.current?.requestOlder({
      subKey: `channel:${coordinate}`,
      filter: {kinds: [Kind.LiveChat], '#a': [coordinate]},
      until,
    });
  };
  const requestOlderGroupPage = (groupId: string, until: number): void => {
    relayRef.current?.requestOlder({
      subKey: `group:${groupId}`,
      filter: {kinds: [GroupKind.Chat, GroupKind.Thread, GroupKind.Reply], '#h': [groupId]},
      until,
    });
  };
  // Mirrors snapshot.enrolled for the setup() closure (AppState handler) to read synchronously.
  // While NOT enrolled (onboarding), backgrounding must NOT tear Tor down — the user routinely
  // switches apps to copy the join code, and they should return to a live circuit, not a reconnect.
  const enrolledRef = useRef(false);
  /** Set during setup() once the Tor manager exists — runs the automated enroll exchange. */
  const exchangeFnRef = useRef<
    | ((
        community: Community,
        inviteCode: string,
        hooks?: CircuitHooks,
      ) => Promise<ExchangeResult>)
    | null
  >(null);
  // Releases the temporary join-code onion credential after enrollment completes, or restores the
  // active community's credential when an additive join is cancelled.
  const releaseOnboardingTorRef = useRef<((restoreActive: boolean) => void) | null>(null);
  // Set during setup() — opens the just-joined community's REAL per-(cid, slot) store and runs the
  // REAL relay plan into it during the connecting step, so a first-run member lands on a warm
  // Updates tab instead of an empty one (onboarding/prefetchCommunity.ts).
  const startCommunityPrefetchRef = useRef<((session: Session) => CommunityPrefetch) | null>(null);
  // The live prefetch handle, held from the connecting step until enrollment consumes it: enrollment
  // must close it (releasing the native SQLCipher handle) BEFORE reopening the same file, and must
  // adopt its pre-minted account slot or it opens a different, empty database instead.
  const communityPrefetchRef = useRef<CommunityPrefetch | null>(null);
  // Set during setup() — start a posting-token draw NOW. Called right after enrollment so the first
  // batch is drawn while the member is still arriving, rather than after the feed relay's onion
  // rendezvous completes. Only useful because the prefetch already put `stiq:token-keys` in the
  // store: without it the draw pays an extra cold Tor fetch first (the 2026-07-21 fresh-enroll gap).
  const kickTokenDrawRef = useRef<(() => void) | null>(null);
  // Lazy draft store: delegates to the runtime's DraftStore once it exists. Stable identity so
  // the composer's autosave effect doesn't churn.
  const draftStoreRef = useRef<DraftStoreApi>({
    all: () => runtimeRef.current?.drafts.all() ?? Promise.resolve([] as Draft[]),
    save: (d: Draft) => runtimeRef.current?.drafts.save(d) ?? Promise.resolve(),
    delete: (id: string) => runtimeRef.current?.drafts.delete(id) ?? Promise.resolve(),
  });
  // Bridges fetched at runtime from the moat API; empty = use bundled bridges.
  const freshBridgesRef = useRef<string[]>([]);
  // Set during setup() — closes the current relay socket so startRelay() reconnects to the new URL.
  const forceRelayReconnectRef = useRef<((newUrl: string) => void) | null>(null);
  // Set during startRelay() — spends a read-token over a fresh dedicated Tor socket to unlock a
  // locked post's content epoch (C7 content-encryption meter). SHIPS DARK: no feed item is ever
  // locked until the relay advertises content encryption AND the organizer seals posts, so this is
  // never invoked today. Mirrors the doDrawTokens bridge (the connect factory + active relay live
  // inside the relay effect, not the render scope).
  const unlockContentRef = useRef<((epoch: number) => Promise<boolean>) | null>(null);
  // Set during setup() — reconnect the feed relay to the now-ACTIVE community, restarting the Tor
  // daemon first if that community's onion client-auth key isn't loaded (a plain socket bounce can't
  // reach an onion whose credential the running daemon was never started with). Used by the community/
  // identity switchers and community-remove, where the active onion may change.
  const reconnectActiveRelayRef = useRef<((newUrl: string) => void) | null>(null);
  // Set during setup() — a FULL Tor restart under the freshly-saved connection prefs (used when the
  // user changes mode in Settings, or hits Retry on the connecting overlay).
  const applyTorPrefsRef = useRef<(() => void) | null>(null);
  // Set during setup() (T4, ship-dark behind TOR_DORMANCY) — enter/exit the low-power dormant Tor
  // state on background/resume instead of the legacy force-kill. Both closures live inside setup()'s
  // relay closure, so the AppState handler (defined in the outer effect) reaches them via this ref,
  // the same pattern as applyTorPrefsRef. Null (and never invoked) when the flag is off.
  const torDormancyRef = useRef<{enter: () => void; exit: () => void} | null>(null);
  // Wall-clock ms at which the app last went to 'background', or null when foregrounded. iOS suspends
  // the process within seconds of backgrounding, FREEZING the 30s grace timer that drives
  // torDormancyRef.enter() — so on iOS dormancy frequently never enters at all. The AppState 'active'
  // handler and exit() live in DIFFERENT closure scopes (outer effect vs setup()'s relay closure), so
  // this ref is how exit() learns how long we were actually suspended. Set even pre-enrollment
  // (harmless); read-and-cleared by the 'active' branch. See exit() for how the elapsed drives one
  // forced relay bounce past RESUME_STALE_SOCKET_MS.
  const backgroundedAtRef = useRef<number | null>(null);

  // T4-S4 instrumentation: cold/resume-to-usable timing anchor. Initialized to the cold path at
  // mount (≈ app launch); the AppState 'active' handler re-anchors it to 'resume' before a
  // reconnect, and the first relay onSynced after each (re)connect emits one [T4-METRIC] line
  // (see the onSynced hook), gated on the T4_METRIC config flag (committed default OFF).
  const t4MetricRef = useRef<{start: number; path: 'cold' | 'resume'; pending: boolean}>({
    start: Date.now(),
    path: 'cold',
    pending: true,
  });
  // Set during setup() once `runtime` exists — re-runs the init()-vs-timeout race (attemptInit) so
  // the recovery screen's Retry button can recover from a hung init() without a full remount.
  const retryInitRef = useRef<() => void>(() => {});
  // Set during setup() to the single in-process Tor manager (a local const inside that closure), so
  // the render body can reach it for the signed-update fetches (T9). Mirrors the "ref shadows a
  // closure-local" pattern relayRef/runtimeRef use. Null (and never read) until the flag is on AND a
  // repo-carrying community is active, so a flag-off build never dereferences it.
  const managerRef = useRef<TorManager | null>(null);

  // Deep-link handler: a scanned join-code QR (stiq://join?c=<code>) launches the app and
  // prefills the onboarding code field. (The credential response travels inside the automatic
  // Tor exchange, so there is no member-facing response deep link.)
  //
  // A deep link is attacker-reachable — any web page or QR can fire stiq://. So we bound the
  // input before parsing, act ONLY on the `join` host (every other host, including the retired
  // `cred-resp`, is ignored), and hand the code on only within the join-code size cap. Structural
  // validation of the code itself happens in parseJoinCode; the user still confirms on the code
  // step (which shows the community/organizer/relay) before anything is enrolled.
  const handleDeepLink = useCallback((url: string) => {
    if (typeof url !== 'string' || url.length > MAX_JOIN_CODE_LEN + 256) {
      return;
    }
    try {
      // Parse with the Hermes-safe string helpers, NOT `new URL()`: on-device Hermes ships a URL
      // whose `.hostname`/`.searchParams` getters throw "not implemented" (the whatwg-url polyfill
      // does not reliably load), which silently dropped scanned/tapped join links — the code field
      // never prefilled. urlHost/getQueryParam are pure string ops (see src/util/url.ts).
      const host = urlHost(url);
      if (host === 'join') {
        const code = getQueryParam(url, 'c');
        if (code && code.length <= MAX_JOIN_CODE_LEN) {
          setIncomingJoinCode(code);
          // On first run (!enrolled) the OnboardingScreen is already on-screen and consumes
          // incomingJoinCode directly. But once you're in the app (an anonymous identity is created
          // on first launch, so `enrolled` is effectively always true), the onboarding screen is not
          // routed to — so a join deep-link would otherwise do nothing. Open the "add community"
          // flow (the same onboarding code screen, in add mode) with the code prefilled.
          if (enrolledRef.current) {
            setAddCommunityMode(true);
          }
        }
      } else if (host === 'channel') {
        // A private-space invite link: stiq://channel/<id>#k=<key>&e=<epoch>. Pass the RAW url so
        // the runtime can split the fragment itself (the key never reaches a server) — it stores
        // any carried E2E key, then joins. No-op until the runtime is enrolled/ready.
        void runtimeRef.current?.acceptInviteLink(url);
      }
    } catch {
      // malformed URL — ignore
    }
  }, []);

  // Keep the synchronous enrolled mirror current for the setup() AppState handler.
  useEffect(() => {
    enrolledRef.current = snapshot.enrolled;
  }, [snapshot.enrolled]);

  // One-time reliability nudge (Tor stability+speed, contract C3): on devices whose OS/OEM is prone
  // to freezing or killing the backgrounded Tor daemon, fire the battery-optimization exemption
  // request once.
  //
  // Driven off the enrolled false→true TRANSITION, not a one-shot read of the post-init snapshot
  // (the original X3 call site, in runtime.init().finally()). That read happens before a first-time
  // user has joined anything, so someone who enrolled DURING this session — precisely when the
  // background daemon starts mattering — was never nudged and had to relaunch the app before the
  // prompt could ever appear. The transition covers both cases from one call site: an
  // already-enrolled cold start flips false→true at hydration (what X3 caught), and a fresh
  // enrollment flips it when onboarding completes (what X3 missed).
  //
  // The ref keeps it once-per-process. maybePromptReliability() still owns the policy (OEM
  // aggressiveness + prior dismissal, which persists across launches); we skip the system dialog
  // when the exemption is already granted, since an aggressive-but-exempt device gets its
  // OEM-specific step list from the Settings → Reliability pill rather than a redundant dialog; and
  // dismissal is recorded only after actually asking, so a later-revoked exemption re-nudges.
  //
  // ALSO GATED ON relayEverSynced, and that is not cosmetic. Enrolled-only, this fired ~6s into a
  // cold start — mid onion-rendezvous — and the system dialog stole focus, which bounces AppState
  // through background→'active' and drives the whole dormancy-resume path (SIGNAL ACTIVE + an
  // immediate relay dial) straight into the connection it was trying to establish. On device that
  // burned one of the four failures that trigger transport escalation. A nudge about background
  // reliability has no reason to race the foreground connection: wait until the relay has actually
  // synced, which proves a rendezvous completed and the fragile window is over.
  const reliabilityNudgedRef = useRef(false);
  useEffect(() => {
    if (!snapshot.enrolled || !relayEverSynced || reliabilityNudgedRef.current) {
      return;
    }
    reliabilityNudgedRef.current = true;
    void (async () => {
      if (!(await maybePromptReliability())) return;
      if (await isIgnoringBatteryOptimizations()) return;
      requestIgnoreBatteryOptimizations();
      void setReliabilityPromptDismissed(true);
    })();
  }, [snapshot.enrolled, relayEverSynced]);

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];

    // The foreground app owns the single in-process Tor daemon for its whole lifetime. This both
    // (a) makes the background WorkManager sync (a separate, older Tor driver) bail instead of
    // stopping/starting the daemon out from under us, and (b) is cleared on unmount. Cancelling any
    // KEEP-persisted sync job here closes the cold-launch window where a job scheduled in a prior
    // session could fire during onboarding and crash tor's in-process restart. See foregroundLock.ts.
    setForegroundOwnsTor(true);
    workManager.cancelSync();

    // Created once and shared by the bridge cache, the encrypted store, and the runtime.
    const secureStorage = tryCreateSecureStorage();
    // Event reminders persist their records through the same storage (provider-registration
    // idiom, like setNotificationProvider below) — without this, scheduled reminders still fire
    // but getReminder/listReminders read back empty after a restart.
    setReminderStorage(secureStorage);

    // A fresh/additive join may target an auth-gated onion that is not active yet. While that
    // exchange is pending, its join-code credential must win over the active-community resolver.
    // `undefined` means no onboarding override; `null` deliberately selects a public onion.
    let onboardingOnionAuth: OnionAuth | null | undefined;

    // Fallback per-attempt deadline used ONLY if some future call site omits its own
    // bootstrapTimeoutMs override — every call site in this cascade passes one explicitly today (see
    // WARM_BOOTSTRAP_TIMEOUT_MS/DIRECT_BOOTSTRAP_TIMEOUT_MS/coldTimeoutFor below), so this is
    // presently a defensive default rather than a live timeout. Kept coherent with those: 120s
    // clears the MEASURED ~100s cold-consensus plateau (see WARM_BOOTSTRAP_TIMEOUT_MS) with the same
    // margin, so a call site that forgets to pass its own deadline fails safe instead of dying at a
    // C-tor-era 90s that would kill a healthy Arti connect mid-fetch.
    // resolveOnionAuth is pulled at each connect so the manager always reaches the ACTIVE
    // community's onion (lever 2). Null until a members-only (community-code v4) community is
    // active, so a public onion is unaffected.
    const manager = createTorManager({
      transport: 'webtunnel',
      bootstrapTimeoutMs: 120_000,
      // T4 (ship-dark): threads into TorStartConfig.dormancy → Arti's DormantMode::Soft, applied to
      // the TorClient at construction (arti-ffi/src/lib.rs finish_start) and toggled live via
      // arti_set_dormant thereafter. false (default) omits the field entirely (buildStartConfig
      // drops it), so the client is built non-dormant — every connect is byte-identical to today.
      dormancy: TOR_DORMANCY,
      resolveOnionAuth: () =>
        onboardingOnionAuth !== undefined ? onboardingOnionAuth : getActiveOnionAuth(),
      // Secondary-mirror reach credentials (P2 §1.7/§1.9 multi-relay client transport). Inert
      // until a joined community actually carries a distinct-key secondary mirror — the active
      // community's onion-auth set is empty otherwise, so a single-mirror build is unaffected.
      // Also folds in the ACTIVE community's primary credential when a pending join's
      // onboardingOnionAuth override has displaced it from the native "primary" slot (A3: multi-
      // community onion-auth clobber) — see preserveDisplacedActivePrimary.
      resolveOnionAuthExtra: () =>
        preserveDisplacedActivePrimary(
          getActiveOnionAuthExtra(),
          getActiveOnionAuth(),
          onboardingOnionAuth !== undefined,
          onboardingOnionAuth ?? null,
        ),
    });
    // Expose the manager to the render body for the signed-update fetches (T9). Cleared on unmount
    // (below) so a stale manager can't be dialed after teardown.
    managerRef.current = manager;
    cleanups.push(() => { managerRef.current = null; });

    // Bind the media service to this manager so images and links fetch over Tor (never the OS
    // network stack). Torn down on unmount so a stale manager can't be used.
    setMediaService(createMediaService(manager));
    cleanups.push(() => setMediaService(null));

    // Let the app-root link dialog change the default browser ("Make default" in its secure-browser
    // sheet). The dialog is mounted above every screen and has no props, so the writer is bound here
    // rather than drilled; unbinding on teardown keeps a stale runtime from being written to.
    setPreferredBrowserWriter(id => {
      void runtimeRef.current?.setPreferredBrowser(id);
    });
    cleanups.push(() => setPreferredBrowserWriter(null));

    // Deadline for the "warm" path (cached bridges + warm Tor dataDir). MEASURED (real device): a
    // genuinely warm Arti connect (directory already cached) finishes in ~3.5s — but "warm" here
    // only means the BRIDGES are known-good, not that Arti's own on-disk directory cache is still
    // valid. When it isn't, this pays the same cold consensus fetch as a fresh start, which MEASURED
    // ~100s on a real device while Arti's percent stream (conn*0.15 + dir*0.85) sat at a FLAT 15%
    // the whole time — no intermediate progress at all to re-arm a shorter timer against. A
    // too-short deadline abandons a working bridge set mid-fetch and falls back to a cold retry that
    // may land on *worse* (dead) bridges. 120s clears that ~100s plateau with the same margin
    // ladder.ts's AUTO_LADDER noProgressMs uses for the identical reason — keep the two coherent.
    const WARM_BOOTSTRAP_TIMEOUT_MS = 120_000;

    // Grace added to a guided rung's OUTER hard ceiling (T2) before the walker abandons it. The
    // ceiling races against manager.connect() whose INNER no-progress guard (rung.noProgressMs) is
    // meant to fire first; this small grace keeps the outer race from tripping a rung that is about
    // to escalate on its own. Only consulted when GUIDED_AUTO_LADDER is on.
    const CEILING_GRACE_MS = 3_000;

    // Deadline for a DIRECT Tor connection with NO cached bridge to fall back on — this can be the
    // very first connect this device has ever attempted, so Arti's dataDir may be completely empty.
    // That is exactly the cold-consensus case MEASURED at ~100s of flat 15% (see
    // WARM_BOOTSTRAP_TIMEOUT_MS above); anything shorter would abandon a healthy direct connect
    // before the consensus finishes and fall back to bridges for no reason. 120s matches
    // AUTO_LADDER's 'direct' rung noProgressMs (ladder.ts) — same daemon, same plateau, same bound.
    const DIRECT_BOOTSTRAP_TIMEOUT_MS = 120_000;

    // Shorter deadline for RE-PROBING direct on a cold start when we already have a working cached
    // bridge to fall straight back to. This is what makes bridge escalation recoverable: a network
    // that has recovered (or simply changed) drops back to fast direct Tor instead of staying
    // pinned to a slow cached bridge forever. Unlike DIRECT_BOOTSTRAP_TIMEOUT_MS above, a device
    // that reaches this branch has already connected successfully once (that's where the cached
    // bridge came from), so Arti's directory cache is very likely still warm here too — MEASURED at
    // ~3.5s for a real warm connect. 20s is comfortable headroom on top of that while still failing
    // fast: if direct hasn't produced a live circuit well within it, we conclude direct is still
    // blocked here and use the cached bridge instead — so a still-censored network pays only this
    // brief check, not the full 120s DIRECT_BOOTSTRAP_TIMEOUT_MS ceiling.
    const DIRECT_REPROBE_TIMEOUT_MS = 20_000;

    // Per-transport cold bootstrap deadline (legacy/preset cascade; connectGuided's equivalent is
    // AUTO_LADDER in ladder.ts). WebTunnel/obfs4 face the same cold consensus fetch MEASURED at
    // ~100s of flat 15% (see WARM_BOOTSTRAP_TIMEOUT_MS above), so 120s here matches ladder.ts's
    // bridge-rung noProgressMs for the same reason. Snowflake's WebRTC rendezvous is slower to
    // provision on top of that same consensus fetch, so it keeps a longer 180s ceiling before we
    // give up on a tier and escalate.
    const coldTimeoutFor = (transport: TransportType): number =>
      transport === 'snowflake' ? 180_000 : 120_000;

    // Whether we currently WANT a live Tor connection. Set false while the app is backgrounded
    // (after the grace period) so the reconnect cascade stops cleanly instead of fighting the
    // deliberate shutdown. Every async step in the cascade re-checks this.
    let desiredConnected = true;
    // Single-flight guard: only one connect cascade runs at a time. Without it the warm-fail
    // fallthrough, the offline auto-retry, and the foreground-resume can each launch an
    // overlapping cascade — and a disconnect() from one tears down a Tor start from another,
    // which is exactly how Tor failed to come back after the warm path expired.
    let cascadeRunning = false;
    // Set when the user applies a NEW connection mode while a cascade is already in flight. The
    // single-flight guard would otherwise drop the apply's runCascade(); instead the running
    // cascade re-loops under the new prefs (dropping any connection it just made under the old
    // mode). This makes "apply mode" take effect promptly without a second overlapping cascade.
    let rerunRequested = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    // Deep links that arrive before runtime.init() has actually completed must not be processed
    // immediately: identity/store aren't hydrated yet, so e.g. acceptInviteLink's join silently
    // no-ops (AppRuntime `if (!this.identity) return`) — a cold-start `stiq://channel/...` or
    // `stiq://join?...` tap would be silently dropped. Queue the URL instead; attemptInit()'s
    // completion handler (below, once `runtime` exists in setup()) replays it exactly once init is
    // genuinely ready. Deliberately gated on real init completion, NOT `hydrated` — `hydrated` can
    // flip true early via the init timeout below while the runtime is still not ready.
    let initComplete = false;
    let pendingDeepLink: string | null = null;
    const deliverDeepLink = (url: string): void => {
      if (initComplete) {
        handleDeepLink(url);
      } else {
        pendingDeepLink = url;
      }
    };

    // A cold-start launch from tapping a notification (app was killed) arrives via
    // notifee.getInitialNotification() below, before runtime hydration has happened. Queue it the
    // same way as a cold-start deep link and replay it in the SAME post-init spot (see
    // attemptInit()'s finally handler) so navigation only fires once the feed/runtime is ready.
    let pendingColdNav: NavTarget | null = null;

    // Bounds runtime.init(): none of its internal awaits (SQLCipher open, keystore reads,
    // per-community DB migrate) carry their own timeout, so a corrupt/locked per-community DB can
    // hang forever — pinning the splash with no way out. attemptInit() (defined in setup(), once
    // `runtime` exists) races init() against this deadline; retryInitRef lets the recovery screen's
    // Retry button re-run the same race.
    const INIT_TIMEOUT_MS = 25_000;
    let initAttempt = 0;
    let currentInitTimer: ReturnType<typeof setTimeout> | undefined;

    // Transport fallback ladder position (PLAN.md §3.2). The cascade walks DOWN BRIDGE_LADDER
    // (webtunnel → obfs4 → snowflake) as onion rendezvous keeps failing on the active transport:
    //
    //   bridgeStartTier = -1  → direct Tor is still allowed (tried ahead of any bridge).
    //   bridgeStartTier =  0+ → direct has proven unusable for the onion on this network; start
    //                           the cold cascade at this BRIDGE_LADDER index and never try direct.
    //
    // `activeTier` is the ladder index of whatever transport is currently connected (-1 = direct),
    // so a later onion failure can escalate to exactly the NEXT tier. Both are sticky for the
    // session so we never flap back to a path that already proved dead for the onion.
    let bridgeStartTier = -1;
    let activeTier = -1;
    // Rungs condemned by the DEFERRED reachability verdict this session (manager.onReach below).
    // A condemned rung "connects" off a cached consensus and only proves dead seconds later, so
    // without this memory the retry cascade would re-pick it forever and never reach the rungs
    // past it. Cleared wherever bridgeStartTier de-escalates (network change, prefs apply) and on
    // ladder exhaustion, so a wrong verdict can never strand the app with zero rungs.
    const deadRungs = new Set<TransportType>();
    // The warm-cache write for the rung that just connected, deferred until the reachability
    // verdict confirms it (saving at connect time is exactly how a lying rung used to poison the
    // warm cache). Null when nothing is pending.
    let pendingWarmSave: (() => Promise<void>) | null = null;
    // Single-flight guard for startRelay()'s live reach-credential install (see its reach handoff).
    let reachInstallInFlight = false;
    let reachEnsured = false;
    // Wall-clock of when the CURRENT transport reached 'connected' (0 = not connected). Read only by
    // the escalation gate, to distinguish "this transport has been failing the onion for a while"
    // from "we got a fast burst of failures seconds after connecting".
    let transportConnectedAt = 0;
    /** Ladder index of a transport (-1 for direct, which sits above the ladder). */
    const tierOf = (transport: TransportType): number =>
      transport === 'direct' ? -1 : BRIDGE_LADDER.indexOf(transport);

    // The AutoRung the guided walker (connectGuided, T2) is currently attempting, or null between
    // attempts. The app-level manager.onBootstrap handler reads it to fold live bootstrap percent
    // into torPhase. Plain outer-scope `let` (like bridgeStartTier) so both connectGuided and the
    // onBootstrap subscription registered in setup() close over the same value. Stays null when
    // GUIDED_AUTO_LADDER is off (connectGuided never runs).
    let currentRung: AutoRung | null = null;

    // True while the app is dormant in the background (T4, ship-dark behind TOR_DORMANCY): the
    // native daemon is signalled DORMANT but kept alive, the relay socket is closed, and reconnect
    // is paused. Declared in the outer effect scope (not setup()) so BOTH the outer runCascade guard
    // and setup()'s enter/exit/onChange closures read the same flag. Stays false forever when the
    // flag is off (enter() is only reached from the TOR_DORMANCY AppState branch), so the guards
    // that reference it below are inert and the legacy behaviour is byte-identical.
    let dormant = false;

    // A default-network switch (Wi-Fi↔cellular) arrived WHILE dormant (T4). We deliberately stay
    // dormant on such an event (no relay churn in the background); this remembers it so the next
    // exit() (foreground return) forces exactly ONE relay-WS bounce onto the new network, then clears
    // it. Never set when TOR_DORMANCY is off (the network-change listener only latches it while
    // `dormant`, which stays false), so the legacy network-change path is unchanged.
    let networkChangedWhileDormant = false;

    // Whether the user's selected preset implies a censored/bridged network. On such a network the
    // bridge-list fetch must be domain-fronted only (audit #50): a non-fronted moat/GitHub hop would
    // reveal Tor-bootstrap intent from the device's real IP to that destination. 'auto'/'fast' try
    // direct first (open-network assumption) so they keep the fuller multi-hop fetch; 'bridges' and
    // 'reach' are always censored; 'custom' counts unless the user pinned plain direct Tor.
    const frontedBridgeFetch = (): boolean => {
      const prefs = getTorConnectionPrefs();
      if (prefs.mode === 'bridges' || prefs.mode === 'reach') return true;
      if (prefs.mode === 'custom') {
        return (prefs.preferredTransport ?? inferCustomTransport(prefs)) !== 'direct';
      }
      return false;
    };

    // Pre-fetch fresh WebTunnel bridges into memory (not the verified persistent cache) so a
    // later cold fallback doesn't pay the moat round-trip. Runs in the background.
    let bridgePrimeInFlight: Promise<void> | null = null;
    const primeFreshBridges = async (): Promise<void> => {
      if (freshBridgesRef.current.length > 0) return;
      if (bridgePrimeInFlight) return bridgePrimeInFlight;

      bridgePrimeInFlight = (async () => {
        const cached = secureStorage
          ? await loadFetchedBridges(secureStorage, 'webtunnel')
          : null;
        if (cached && cached.length > 0) {
          freshBridgesRef.current = cached;
          return;
        }
        const fresh = await fetchFreshBridges('webtunnel', {frontedOnly: frontedBridgeFetch()});
        if (fresh.length > 0) {
          freshBridgesRef.current = fresh;
          if (secureStorage) {
            await saveFetchedBridges(secureStorage, 'webtunnel', fresh);
          }
        }
      })();
      try {
        await bridgePrimeInFlight;
      } finally {
        bridgePrimeInFlight = null;
      }
    };

    // Direct Tor: no pluggable transport, no bridges — a normal circuit to public guard
    // relays. By far the most reliable/fastest path on an open (uncensored) network, where
    // flaky bridges are the main cause of failed connects. Returns true on success and caches
    // 'direct' as the preferred mode for the next launch.
    const directConnect = async (
      bootstrapTimeoutMs: number = DIRECT_BOOTSTRAP_TIMEOUT_MS,
    ): Promise<boolean> => {
      if (!desiredConnected) {
        return false;
      }
      const state = await manager.connect({
        transport: 'direct',
        bridgeLines: [],
        bootstrapTimeoutMs,
      });
      if (state === 'connected') {
        activeTier = -1;
        if (secureStorage) {
          await saveCachedBridges(secureStorage, 'direct', []);
        }
      }
      return state === 'connected';
    };

    // Cap on a merged webtunnel/obfs4 bridge list (T14): Tor stalls past ~32 circuits, so keep the
    // combined seeded + fetched/bundled set well under that. Seeded lines are prepended before the
    // Set-dedupe so they survive this slice.
    const SEEDED_BRIDGE_CAP = 16;

    // Organizer-seeded obfs4/webtunnel bridge lines for the active community (T14, ship-dark behind
    // COMMUNITY_SEEDED_BRIDGES) — a zero-network bootstrap source that closes the WebTunnel gap
    // (DEFAULT_WEBTUNNEL_BRIDGES is empty, so a cold start with moat blocked otherwise skips the
    // webtunnel tier). Returns [] unless the flag is on, so resolveBridges is byte-identical today.
    // The active community's parsed+validated seededBridges reach here via the runtime's existing
    // getCommunities() accessor (no new AppRuntime surface); each line is re-checked with
    // validateBridgeLine so only lines actually of the requested transport are dialed.
    const seededBridgesFor = async (transport: TransportType): Promise<string[]> => {
      if (!COMMUNITY_SEEDED_BRIDGES) return [];
      const runtime = runtimeRef.current;
      if (!runtime) return [];
      const {list, activeId} = await runtime.getCommunities();
      const active = activeId ? list.find(c => c.id === activeId) : undefined;
      const lines = active?.seededBridges ?? [];
      return lines.filter(l => validateBridgeLine(l) === transport);
    };

    // Resolve the bridge lines to dial for a bridge transport. Sustainable fetching: prefer the
    // in-memory prefetch / persistent fetched cache so a launch where moat is blocked can still
    // reuse bridges fetched earlier, and only pay a fresh network fetch when nothing is cached.
    //   webtunnel — moat-only (no bundled fallback); empty result means "skip this tier".
    //   obfs4     — fetched set MERGED with a small bundled backstop, or bundled-only offline.
    //   snowflake — bundled WebRTC bridges; needs no fetch.
    const resolveBridges = async (transport: TransportType): Promise<string[]> => {
      if (transport === 'snowflake') {
        return [...DEFAULT_SNOWFLAKE_BRIDGES];
      }
      if (transport === 'webtunnel') {
        await primeFreshBridges();
        // Prepend organizer-seeded webtunnel lines (tried first) so a moat-blocked cold start still
        // has a zero-network webtunnel set. Guarded on the flag so the flag-off return is the exact
        // original `freshBridgesRef.current` reference.
        if (COMMUNITY_SEEDED_BRIDGES) {
          const seeded = await seededBridgesFor('webtunnel');
          if (seeded.length > 0) {
            return [...new Set([...seeded, ...freshBridgesRef.current])].slice(0, SEEDED_BRIDGE_CAP);
          }
        }
        return freshBridgesRef.current;
      }
      // obfs4. Balance two failure modes: too many bridges (40+) overloads Tor's 32-circuit
      // limit and stalls at 45-50%; too few RANDOM bundled bridges can be all-dead and stall at
      // 2%. Use the fresh/cached collector set (current, almost always live) plus a small bundled
      // backstop, staying well under 32 total.
      let fresh = secureStorage ? (await loadFetchedBridges(secureStorage, 'obfs4')) ?? [] : [];
      if (fresh.length === 0) {
        fresh = await fetchFreshBridges('obfs4', {frontedOnly: frontedBridgeFetch()});
        if (fresh.length > 0 && secureStorage) {
          await saveFetchedBridges(secureStorage, 'obfs4', fresh);
        }
      }
      const bundledTopUp = pickRandom(DEFAULT_OBFS4_BRIDGES, 6);
      const base = fresh.length > 0
        ? [...new Set([...fresh, ...bundledTopUp])]
        : pickRandom(DEFAULT_OBFS4_BRIDGES, 8);
      // Merge organizer-seeded obfs4 lines (seeded first, Set-deduped, capped). Guarded on the flag
      // so the flag-off return is the exact original `base` expression.
      if (COMMUNITY_SEEDED_BRIDGES) {
        const seeded = await seededBridgesFor('obfs4');
        if (seeded.length > 0) {
          return [...new Set([...seeded, ...base])].slice(0, SEEDED_BRIDGE_CAP);
        }
      }
      return base;
    };

    // Bring up a single bridge transport. Returns true once Tor bootstraps on it (records the
    // ladder tier + caches the working set), false if it had no bridges to dial or failed to
    // bootstrap. The caller decides whether to escalate to the next tier.
    const connectTransport = async (
      transport: TransportType,
      timeoutFor: (t: TransportType) => number = coldTimeoutFor,
    ): Promise<boolean> => {
      const bridgeLines = await resolveBridges(transport);
      if (!desiredConnected) {
        return false;
      }
      if (bridgeLines.length === 0) {
        return false; // e.g. WebTunnel with no fetchable bridges — skip this tier
      }
      const state = await manager.connect({
        transport,
        bridgeLines,
        bootstrapTimeoutMs: timeoutFor(transport),
      });
      if (state === 'connected') {
        activeTier = tierOf(transport);
        if (secureStorage) {
          await saveCachedBridges(secureStorage, transport, bridgeLines);
        }
        return true;
      }
      return false;
    };

    // Walk the bridge ladder (webtunnel → obfs4 → snowflake) starting at `startTier`, stopping at
    // the first transport that bootstraps Tor. After the preferred tier, the rest of the ladder is
    // tried WITH WRAPAROUND so we always land on a transport that can at least bootstrap — never
    // stuck cycling on a higher tier that won't even start (e.g. Snowflake when its broker is
    // blocked). Each failed tier is torn down before the next so we never stack half-open starts.
    const coldConnect = async (
      startTier: number,
      timeoutFor: (t: TransportType) => number = coldTimeoutFor,
    ): Promise<void> => {
      const n = BRIDGE_LADDER.length;
      const start = Math.max(0, Math.min(startTier, n - 1));
      for (let k = 0; k < n; k++) {
        if (!desiredConnected) {
          return;
        }
        if (await connectTransport(BRIDGE_LADDER[(start + k) % n]!, timeoutFor)) {
          return;
        }
        if (!desiredConnected) {
          return;
        }
        await manager.disconnect();
      }
    };

    // Connect with the best available transport, in reliability order:
    //   1. The last mode that actually bootstrapped (cached) — direct or a bridge set — under
    //      a warm deadline, so a relaunch reconnects immediately.
    //   2. DIRECT Tor — fast and reliable on an open network (skipped once we've escalated).
    //   3. The cold bridge ladder from the current tier (WebTunnel → obfs4 → Snowflake).
    // Each step that fails drops to the next; on success the working mode + tier are recorded.
    const connectBest = async (): Promise<void> => {
      let cached = secureStorage ? await loadCachedBridges(secureStorage) : null;
      // Once we've escalated to bridges THIS session, ignore a cached 'direct' (direct has just
      // proven unusable here) and stay on the ladder.
      if (bridgeStartTier >= 0 && cached?.transport === 'direct') {
        cached = null;
      }
      if (!desiredConnected) {
        return;
      }
      // A cached BRIDGE set to fall back on (the last bridge transport that bootstrapped here).
      const cachedBridge = cached && cached.transport !== 'direct' ? cached : null;

      // DIRECT Tor is the preferred transport (fastest + most reliable on an open network), so try
      // it FIRST on every cold start unless we've already escalated this session. This keeps bridge
      // escalation RECOVERABLE: a network that has recovered (or simply changed since the bridge was
      // cached) de-escalates back to direct instead of staying pinned to a slow cached bridge
      // forever. When a cached bridge exists we probe direct with a short deadline, so a network
      // that is still censored barely pays for the check before falling back to its known-good set.
      // (directConnect caches 'direct' + sets activeTier=-1 on success.)
      if (bridgeStartTier < 0) {
        const directTimeout = cachedBridge ? DIRECT_REPROBE_TIMEOUT_MS : DIRECT_BOOTSTRAP_TIMEOUT_MS;
        if (await directConnect(directTimeout)) {
          return;
        }
        if (!desiredConnected) {
          return; // superseded by a deliberate disconnect (e.g. backgrounded)
        }
        await manager.disconnect();
        if (!desiredConnected) {
          return;
        }
      }

      // Direct is blocked or we've escalated: fast warm reconnect on the last-working bridge set
      // (avoids a cold re-fetch of possibly-dead bridges), else walk the cold ladder.
      if (cachedBridge) {
        const state = await manager.connect({
          transport: cachedBridge.transport,
          bridgeLines: cachedBridge.bridgeLines,
          bootstrapTimeoutMs: WARM_BOOTSTRAP_TIMEOUT_MS,
        });
        if (state === 'connected') {
          activeTier = tierOf(cachedBridge.transport);
          void primeFreshBridges(); // warm the in-memory set for the next cold fallback
          return;
        }
        if (!desiredConnected) {
          return;
        }
        // Cached bridge set is stale — drop it and run the full cold ladder.
        if (secureStorage) {
          await clearCachedBridges(secureStorage);
        }
        await manager.disconnect();
        if (!desiredConnected) {
          return;
        }
      }
      // Direct Tor is blocked/escalated here — fall back to the bridge ladder.
      await coldConnect(Math.max(0, bridgeStartTier));
    };

    // ── Connection-mode policy (user-selectable presets) ──────────────────────────────────────
    // connectBest() above IS the 'auto' policy. A preset only reshapes WHICH of those steps run
    // and in what order, reusing the very same helpers — it never removes the bridge-ladder
    // fallback, so no preset can strand the user offline. The active preset is read live from the
    // TorSettingsStore module getter (no value threaded through the cascade).

    // Patient per-transport deadline for the 'reach' preset (Snowflake's WebRTC rendezvous is slow).
    const longTimeoutFor = (transport: TransportType): number =>
      transport === 'snowflake' ? 240_000 : 120_000;

    // Walk the bridge ladder only (never direct): warm-start from the cached set when it's a bridge
    // transport, then cold-walk from `startTier`. Shared by the bridges/reach/fallback paths.
    const connectBridgesOnly = async (
      startTier: number,
      timeoutFor: (t: TransportType) => number = coldTimeoutFor,
    ): Promise<void> => {
      let cached = secureStorage ? await loadCachedBridges(secureStorage) : null;
      if (cached?.transport === 'direct') {
        cached = null; // skip a cached direct for the bridge-first presets
      }
      if (!desiredConnected) {
        return;
      }
      if (cached) {
        const state = await manager.connect({
          transport: cached.transport,
          bridgeLines: cached.bridgeLines,
          bootstrapTimeoutMs: WARM_BOOTSTRAP_TIMEOUT_MS,
        });
        if (state === 'connected') {
          activeTier = tierOf(cached.transport);
          void primeFreshBridges();
          return;
        }
        if (!desiredConnected) {
          return;
        }
        if (secureStorage) {
          await clearCachedBridges(secureStorage);
        }
        await manager.disconnect();
        if (!desiredConnected) {
          return;
        }
      }
      await coldConnect(startTier, timeoutFor);
    };

    // 'custom': dial the user's exact transport with their pasted bridges first, then the app's
    // fetched/bundled set as backup. 'direct' carries no bridges. Returns true on success.
    const connectCustom = async (prefs: TorConnectionPrefs): Promise<boolean> => {
      // Prefer the explicit transport; otherwise dial the transport the pasted bridges are for (so
      // a user who pastes obfs4 lines without picking a pill still dials them), else the default.
      const transport =
        prefs.preferredTransport ?? inferCustomTransport(prefs) ?? PREFERRED_TRANSPORT;
      if (transport === 'direct') {
        const state = await manager.connect({
          transport: 'direct',
          bridgeLines: [],
          bootstrapTimeoutMs: prefs.bootstrapTimeoutMs ?? DIRECT_BOOTSTRAP_TIMEOUT_MS,
        });
        if (state === 'connected') {
          activeTier = -1;
          if (secureStorage) {
            await saveCachedBridges(secureStorage, 'direct', []);
          }
          return true;
        }
        return false;
      }
      const backup = await resolveBridges(transport);
      const bridgeLines = [...new Set([...customBridgesForTransport(prefs, transport), ...backup])];
      if (!desiredConnected || bridgeLines.length === 0) {
        return false;
      }
      const state = await manager.connect({
        transport,
        bridgeLines,
        bootstrapTimeoutMs: prefs.bootstrapTimeoutMs ?? coldTimeoutFor(transport),
      });
      if (state === 'connected') {
        activeTier = tierOf(transport);
        if (secureStorage) {
          await saveCachedBridges(secureStorage, transport, bridgeLines);
        }
        return true;
      }
      return false;
    };

    // The cascade entry point that honors the user's preset. 'auto' is the original connectBest().
    // Every other preset still ends at connectBridgesOnly() so a failed preference can't strand us.
    const connectByMode = async (): Promise<void> => {
      const prefs = getTorConnectionPrefs();
      switch (prefs.mode) {
        case 'fast': {
          // Direct Tor first (fastest on an open network / behind a VPN). Skip it only once direct
          // has proven unusable for the onion on this network (escalated). Always falls back to
          // the full ladder — never direct-only.
          if (bridgeStartTier < 0) {
            if (await directConnect()) {
              return;
            }
            if (!desiredConnected) {
              return;
            }
            await manager.disconnect();
            if (!desiredConnected) {
              return;
            }
          }
          await connectBridgesOnly(Math.max(0, bridgeStartTier));
          return;
        }
        case 'bridges':
          // Skip the doomed direct attempt; go straight to the bridge ladder.
          await connectBridgesOnly(Math.max(0, bridgeStartTier));
          return;
        case 'reach':
          // Hardest-to-block first (Snowflake), with wraparound + patient timeouts.
          await connectBridgesOnly(Math.max(0, BRIDGE_LADDER.indexOf('snowflake')), longTimeoutFor);
          return;
        case 'custom': {
          if (await connectCustom(prefs)) {
            return;
          }
          if (!desiredConnected) {
            return;
          }
          await manager.disconnect();
          if (!desiredConnected) {
            return;
          }
          await connectBridgesOnly(Math.max(0, bridgeStartTier)); // safety net
          return;
        }
        case 'auto':
        default:
          await connectBest();
          return;
      }
    };

    // ── Guided auto-fallback ladder (T2, ship-dark behind GUIDED_AUTO_LADDER) ──────────────────────
    // The AutoRung whose label best matches a cached transport, for the warm-start phase text. obfs4
    // → 'obfs4-bundled', webtunnel → 'fetched-bridges', direct → 'direct'; anything off-ladder (e.g.
    // a cached snowflake set from a preset connect) falls back to the first rung's label only — the
    // actual dial still uses the cached transport+lines, this is purely the plain-language label.
    const rungForTransport = (t: TransportType): AutoRung =>
      AUTO_LADDER.find(r => r.transport === t) ?? AUTO_LADDER[0]!;

    // Map the sticky bridgeStartTier concept onto an AUTO_LADDER start index. bridgeStartTier < 0
    // means direct is still allowed → start at rung 0 (direct). Once direct has proven unusable for
    // the onion this session (bridgeStartTier >= 0), skip it → start at rung 1 (the first bridge
    // rung, obfs4-bundled). AUTO_LADDER order (direct→obfs4→webtunnel) differs from BRIDGE_LADDER's,
    // so this is a pragmatic "skip direct or not" mapping rather than a shared index.
    const bridgeStartTierToRungIndex = (): number => (bridgeStartTier < 0 ? 0 : 1);

    // Walk AUTO_LADDER (direct → bundled-obfs4 → moat-fetched-bridges), racing each rung's
    // manager.connect() against an OUTER hard wall-clock ceiling while TorManager's INNER no-progress
    // guard (rung.noProgressMs, passed as bootstrapTimeoutMs) is preserved. Warm-starts the transport
    // last known to work on this network CLASS, and saves the working set under that class on success.
    // Surfaces a stiq-authored ConnectionPhase (never Tor's raw summary) at every transition. A
    // non-'auto' preset stays authoritative (the Advanced escape hatch), so we delegate to
    // connectByMode() then. Flag OFF: this closure is never called (runCascade uses connectByMode).
    const connectGuided = async (): Promise<void> => {
      // Preset picker remains authoritative when the user has chosen a non-auto mode.
      if (getTorConnectionPrefs().mode !== 'auto') {
        return connectByMode();
      }
      if (!desiredConnected) {
        return;
      }

      const netClass = await getNetworkClass();

      // Per-network-class warm cache first, then the legacy global cache as an explicit fallback so
      // the precedence is visible here (loadCachedBridgesForClass never falls back internally).
      let warm = secureStorage
        ? (await loadCachedBridgesForClass(secureStorage, netClass)) ??
          (await loadCachedBridges(secureStorage))
        : null;
      // Once we've escalated to bridges this session, ignore a cached 'direct' — direct just proved
      // unusable for the onion here — mirroring connectBest()'s stale-direct guard.
      if (bridgeStartTier >= 0 && warm?.transport === 'direct') {
        warm = null;
      }
      // A warm entry for a rung the deferred verdict condemned this session is poison, not warmth.
      if (warm && deadRungs.has(warm.transport)) {
        warm = null;
      }

      if (warm && desiredConnected) {
        const rung = rungForTransport(warm.transport);
        currentRung = rung;
        setTorPhase(describePhase(rung, 'starting'));
        const state = await manager.connect({
          transport: warm.transport,
          bridgeLines: warm.bridgeLines,
          bootstrapTimeoutMs: WARM_BOOTSTRAP_TIMEOUT_MS,
        });
        if (state === 'connected') {
          activeTier = tierOf(warm.transport);
          currentRung = null;
          setTorPhase(describePhase(rung, 'connected'));
          return;
        }
        if (!desiredConnected) {
          return;
        }
        // Warm set is stale on this class — drop that class entry and run the cold walk.
        if (secureStorage) {
          await clearCachedBridgesForClass(secureStorage, netClass);
        }
        await manager.disconnect();
        if (!desiredConnected) {
          return;
        }
      }

      // Cold walk. Each rung is torn down before the next so we never stack half-open starts.
      for (let i = bridgeStartTierToRungIndex(); i !== -1; i = nextRungIndex(i)) {
        if (!desiredConnected) {
          return;
        }
        const rung = AUTO_LADDER[i]!;
        // Condemned this session by the deferred reachability verdict — walk past it.
        if (deadRungs.has(rung.transport)) {
          continue;
        }
        currentRung = rung;
        setTorPhase(describePhase(rung, 'starting'));
        // Fetched-bridge rungs go through resolveBridges (moat + any organizer-seeded lines); bundled
        // rungs (direct/obfs4) use their zero-network default set.
        const lines = rung.useFetchedBridges
          ? await resolveBridges(rung.transport)
          : defaultBridgeLines(rung.transport);
        if (!desiredConnected) {
          return;
        }
        // A bridge rung with no bridges to dial (e.g. webtunnel with moat blocked) is skipped.
        if (rung.transport !== 'direct' && lines.length === 0) {
          continue;
        }
        // INNER guard: rung.noProgressMs is TorManager's existing per-attempt no-progress timeout.
        // OUTER guard: a hard wall-clock ceiling that ALWAYS fires even while Tor keeps advancing.
        // The `.catch` keeps this promise handled after the ceiling wins the race and orphans it
        // (a rejected connect then reads as a failed attempt rather than an unhandled rejection).
        const connectP = manager
          .connect({
            transport: rung.transport,
            bridgeLines: lines,
            bootstrapTimeoutMs: rung.noProgressMs,
          })
          .catch((): ConnectionState => 'offline');
        const ceilingP = new Promise<'ceiling'>(res =>
          setTimeout(() => res('ceiling'), rung.hardCeilingMs + CEILING_GRACE_MS),
        );
        const r = await Promise.race([connectP, ceilingP]);
        if (r === 'connected') {
          activeTier = tierOf(rung.transport);
          if (secureStorage) {
            const storage = secureStorage;
            // Deferred until the reachability verdict confirms the rung (manager.onReach below) —
            // recording it at connect is exactly how a lying rung used to poison the warm cache.
            // (Skips 'unknown' internally, so a device that can't classify never poisons a bucket.)
            pendingWarmSave = () => saveCachedBridgesForClass(storage, netClass, rung.transport, lines);
          }
          currentRung = null;
          setTorPhase(describePhase(rung, 'connected'));
          return;
        }
        if (!desiredConnected) {
          return;
        }
        // Ceiling fired, or the attempt reported offline: surface the plain-language state, tear the
        // rung down, and (if another rung remains) narrate the escalation before continuing.
        setTorPhase(describePhase(rung, 'ceiling-exceeded'));
        await manager.disconnect();
        if (!desiredConnected) {
          return;
        }
        if (nextRungIndex(i) !== -1) {
          setTorPhase(describePhase(rung, 'escalating'));
        }
      }
      // Every rung's ceiling fired without a connect. The onChange('offline') path + scheduleRetry
      // then reschedules a fresh runCascade, restarting the ladder from the top (or bridgeStartTier).
      currentRung = null;
      // Exhaustion resets the condemned set: if every rung is dead we would otherwise have zero
      // rungs forever, and a full re-walk re-earns each verdict at the cost of one probe apiece.
      deadRungs.clear();
      setTorPhase(describePhase(AUTO_LADDER[AUTO_LADDER.length - 1]!, 'exhausted'));
    };

    const clearRetry = (): void => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    // Force-kill teardown of the daemon: the legacy background lifecycle AND the TOR_DORMANCY
    // fallback (enter() calls this when the daemon can't be idled dormant). Marks intent BEFORE
    // disconnecting so an in-flight cascade bails instead of immediately reconnecting, cancels any
    // pending auto-retry, and clears the adoptable-dormant-daemon handle so a WorkManager sync can't
    // adopt a daemon we're tearing down. The onChange('disconnected') handler closes the relay. This
    // is the ONE lifecycle disconnect() call site — both teardown paths route through here.
    const teardownTor = (): void => {
      desiredConnected = false;
      clearRetry();
      setDormantDaemon(null);
      void manager.disconnect();
    };

    // Run the connect cascade under the single-flight guard. No-op if a cascade is already
    // running or we no longer want a connection (backgrounded). This is the ONLY entry point
    // for (re)connecting, so the triggers below can never overlap.
    const runCascade = async (): Promise<void> => {
      // `dormant` is added to the single-flight guard (T4) so a stray trigger can't wake the cascade
      // over a daemon we deliberately idled in the background. Always false when TOR_DORMANCY is off.
      if (cascadeRunning || !desiredConnected || dormant) {
        return;
      }
      cascadeRunning = true;
      // Most open networks finish direct Tor quickly and never need a bridge fetch. If direct is
      // still working after a short grace period, warm WebTunnel bridges in parallel so a blocked
      // direct attempt can fall through immediately instead of then paying another 30s of moat
      // time. primeFreshBridges is single-flight, so bridge-first modes safely coalesce with it.
      const bridgePrimeTimer = setTimeout(() => {
        void primeFreshBridges();
      }, 5_000);
      try {
        do {
          rerunRequested = false;
          // T2: the guided auto-ladder replaces preset-driven connect when GUIDED_AUTO_LADDER is on.
          // Flag OFF → connectByMode() exactly as before (connectGuided is never entered).
          await (GUIDED_AUTO_LADDER ? connectGuided() : connectByMode());
          // A mode change arrived mid-cascade: drop a connection made under the OLD prefs so the
          // re-run actually switches transport (manager.connect() no-ops while already connected).
          if (rerunRequested && desiredConnected && manager.getState() === 'connected') {
            await manager.disconnect();
          }
        } while (rerunRequested && desiredConnected);
      } catch {
        // Swallow — the onChange 'offline' handler reschedules a retry.
      } finally {
        clearTimeout(bridgePrimeTimer);
        cascadeRunning = false;
      }
    };

    const scheduleRetry = (ms: number): void => {
      clearRetry();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void runCascade();
      }, ms);
    };

    // Handle deep links that arrive while the app is running. Routed through deliverDeepLink so one
    // that arrives before init() has actually finished is queued instead of processed early (see
    // deliverDeepLink above).
    const linkingSub = Linking.addEventListener('url', ({url}) => deliverDeepLink(url));
    cleanups.push(() => linkingSub.remove());
    // Handle deep links that launched the app cold. This is the racy path (bug): getInitialURL()'s
    // native round-trip routinely resolves before runtime.init() does, so this must go through the
    // same queue rather than calling handleDeepLink directly.
    void Linking.getInitialURL().then(url => { if (url) deliverDeepLink(url); });

    // AppState: schedule the WorkManager periodic sync when we go to background; cancel it
    // when we return to foreground (the live connection loop handles sync there). The sync PERIOD is
    // randomized per background transition (T15, ~15-26 min under TIMING_JITTER; fixed 15 flag-off)
    // on top of the 5-min flex window, so a fixed schedule can't be locked onto for timing correlation.
    // On background, Tor is stopped after a 30-second grace period so the OS can reclaim
    // resources; WorkManager reconnects on the next jittered wake cycle.
    let backgroundGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const appStateSub = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        // Un-park relay-driven deferred emits FIRST so the snapshot the resumed UI renders is fresh.
        runtimeRef.current?.setAppBackgrounded(false);
        if (backgroundGraceTimer !== undefined) {
          clearTimeout(backgroundGraceTimer);
          backgroundGraceTimer = undefined;
        }
        workManager.cancelSync();
        desiredConnected = true;
        // T4-S4 metric: this resume path (re)connects Tor; the next relay onSynced emits the
        // [T4-METRIC] resume-to-usable timing. A still-live defensive resume cancels it below.
        t4MetricRef.current = {start: Date.now(), path: 'resume', pending: true};
        if (TOR_DORMANCY) {
          // T4: exit() signals the daemon ACTIVE (before any liveness check) and re-opens the relay
          // it closed on the way into dormancy. It also (a) recovers the OS-killed-daemon case by
          // falling through to the full cold cascade when Tor isn't live, (b) coordinates with an
          // in-flight background sync via the same abort/wait handshake the legacy path uses so the
          // two never race the shared cache, and (c) forces one relay bounce if the network changed
          // while we were dormant.
          torDormancyRef.current?.exit();
        } else {
          // ── Legacy resume (byte-identical to pre-T4) ──
          // Tor may have been stopped while backgrounded — by our grace timer, or by the OS
          // killing the service. disconnect() nulls the socks proxy synchronously but only flips
          // state to 'disconnected' AFTER backend.stop() resolves (see TorManager.isLive() doc) — so
          // a quick background→foreground bounce can land here while getState() still stale-reports
          // 'connected' for that brief window even though the SOCKS proxy is already gone. Under
          // Arti that window is now tiny (StiqArtiModule.stopTor is a near-instant in-memory drop,
          // not the old C-tor bounded poll), but it is not literally zero, so isLive() (the real
          // state+socks pair) remains the correct check, not getState().
          if (!manager.isLive()) {
            if (backgroundSyncOwnsTorNow()) {
              // The headless WorkManager sync (a SEPARATE TorManager instance) is currently mid-flight
              // on the ONE shared native Tor daemon — most likely it woke during this exact background
              // window. Racing it with our own startTor() here is exactly the concurrent-start bug this
              // guard exists to prevent (see foregroundLock.ts). Ask it to abort at its next checkpoint
              // and wait (bounded) for it to actually release ownership before running our own cascade,
              // rather than starting a second daemon attempt on top of it.
              requestBackgroundSyncAbort();
              void (async () => {
                await waitForBackgroundSyncRelease(2_000);
                if (desiredConnected && !manager.isLive()) {
                  void runCascade();
                }
              })();
            } else {
              void runCascade();
            }
          } else {
            // Still-live resume: no reconnect will happen, so cancel the pending T4-METRIC so a
            // much-later reconnect can't emit a stale resume dt.
            t4MetricRef.current.pending = false;
            // Defensive resume: the manager reports a live connection, so don't reconnect — but a
            // relay could have silently dropped our standing feed REQ without closing the socket,
            // which would otherwise sit invisible until the next reconnect. The standing REQ (see
            // startRelay) is the primary delivery mechanism; this is just a lightweight backstop, the
            // same warm-path resync pull-to-refresh already uses (RelayClient.resyncFeed coalesces if
            // one is already in flight, so this can never pile up redundant rounds).
            void runtimeRef.current?.refreshFeed();
            // G4/foreground hook: a still-live connection never reruns startRelay()'s post-connect
            // token top-up (maybeDrawTokens/stockAuxiliaryWallets — both live in setup()'s scope,
            // unreachable from this outer AppState handler). foregroundLowWaterRefill is the
            // runtime-side equivalent, reachable via runtimeRef from anywhere: it uses
            // deps.drawTokensNow/deps.connectForDraw directly, both already wired into the runtime
            // regardless of which scope calls it, and is internally gated/single-flighted at the host
            // — a free no-op on an already-warm wallet, never a foreground wait.
            void runtimeRef.current?.foregroundLowWaterRefill();
          }
        }
        // Consumed by exit()/the legacy branch above (both read backgroundedAtRef via closure while
        // they run); clear AFTER so the next 'active' without an intervening 'background' can't reuse a
        // stale suspension length. null ⇒ foregrounded.
        backgroundedAtRef.current = null;
      } else if (nextState === 'background') {
        // Stamp the moment we backgrounded so exit()/the legacy resume can measure the real suspension
        // length (iOS freezes timers seconds in, so the grace timer's own clock can't be trusted). Set
        // BEFORE the pre-enrollment early-return — harmless, and keeps the background/active stamp
        // symmetric no matter which branch consumed it.
        backgroundedAtRef.current = Date.now();
        // Park relay-driven deferred emits while nothing is on screen (a full snapshot build + tree
        // render per burst is wasted battery in the background); foreground flushes one coalesced
        // emit. Set BEFORE the pre-enrollment early-return so onboarding backgrounds park too.
        runtimeRef.current?.setAppBackgrounded(true);
        // During onboarding (not yet enrolled) the user routinely backgrounds to copy the join code
        // from another app (Telegram/email) or to read the notifications-permission dialog. Keep Tor
        // connected so they return to a LIVE circuit — tearing it down here forces a reconnect churn
        // (and, before the native teardown barrier, could crash tor's in-process restart) right in
        // the middle of connecting. Background sync is pointless pre-enrollment anyway.
        if (!enrolledRef.current) {
          return;
        }
        // Lock immediately on backgrounding so a resumed app always re-prompts for the PIN/biometric
        // (security finding #22). Relying on the inactivity timer alone left the app fully unlocked on
        // a quick resume — a device-seizure gap — and background timers are throttled/unreliable
        // anyway. No-op when the user has turned the lock screen off. Also drops the vault session.
        //
        // REVERSED by user decision, bug round 2026-07-15 (see config.ts's LOCK_ON_BACKGROUND):
        // finding #22's device-seizure defense had a worse cost — the OS image/document/camera
        // picker backgrounds the app as its own foreground Activity (it briefly takes over the
        // screen), so this fired on EVERY picture pick, locking the app before the user had even
        // chosen a photo. Unlocking then remounted a brand-new MainScreen straight to the feed,
        // silently discarding the whole in-progress composer and the picked photo — a page-blanking
        // loop the user could not get past. The user chose to accept the reduced device-seizure
        // protection in exchange for a working picker: PIN now re-locks only on a genuine cold
        // start (AutoLock's `state` starts 'locked' and is never persisted, so any real process
        // restart — including "swipe out of recents" — still requires the PIN). Gated, not deleted,
        // so finding #22 is a one-flag revert if this tradeoff is ever revisited.
        if (LOCK_ON_BACKGROUND) {
          runtimeRef.current?.lock();
        }
        // T15-S4 (timing-correlation defense): with TIMING_JITTER on (ships default-ON), the PERIOD
        // itself is randomized in [15,26] min per background transition — not just the flex window —
        // so the background sync's observable relay/onion activity doesn't fall on a fixed cadence.
        // Flag OFF → scheduleSync(15, SYNC_FLEX_MINUTES) = scheduleSync(15, 5), byte-identical to today.
        workManager.scheduleSync(TIMING_JITTER ? randomizedSyncPeriodMinutes() : 15, SYNC_FLEX_MINUTES);
        // TS-5: consecutive 'background' transitions without an intervening 'active' (e.g. Android
        // firing background→inactive→background) must not leak the previous grace timer — an
        // uncleared one fires later against whatever state has since changed underneath it. Clear
        // before reassigning in both branches below.
        if (backgroundGraceTimer !== undefined) {
          clearTimeout(backgroundGraceTimer);
          backgroundGraceTimer = undefined;
        }
        // GRACE PERIOD is platform-tuned. Android: 30s (the process keeps running backgrounded; the
        // only cost of waiting is battery). iOS: 20s — the process only stays alive as long as the
        // native "stiq.tor.quiesce" UIBackgroundTask assertion (StiqTor.swift), and measured grants
        // are ~25s (sim, 2026-07-18: begin→expired 26s); a 30s timer fires AFTER the assertion
        // expires, i.e. never while genuinely backgrounded. 20s fits the grant with margin so the
        // designed quiesce actually runs on iOS; a quick app-switch back within 20s still cancels it.
        const graceMs = Platform.OS === 'ios' ? 20_000 : 30_000;
        if (TOR_DORMANCY) {
          // T4: after the grace period, idle Tor DORMANT (daemon kept alive, relay closed, reconnect
          // paused) instead of force-killing it. desiredConnected stays TRUE throughout dormancy —
          // the `dormant` guards, not a desiredConnected flip, are what stop the cascade churning.
          // enter() itself falls back to teardownTor() when the daemon isn't live or the native
          // DORMANT signal can't be delivered, so a daemon we can't idle is never left half-alive.
          backgroundGraceTimer = setTimeout(() => {
            backgroundGraceTimer = undefined;
            torDormancyRef.current?.enter();
          }, graceMs);
        } else {
          // ── Legacy background teardown (byte-identical to pre-T4) ──
          // After a grace period, stop Tor so WorkManager owns background connectivity.
          // The onChange listener in setup() sees the state change and closes the relay.
          backgroundGraceTimer = setTimeout(() => {
            backgroundGraceTimer = undefined;
            teardownTor();
          }, graceMs);
        }
      }
    });
    cleanups.push(() => {
      appStateSub.remove();
      if (backgroundGraceTimer !== undefined) {
        clearTimeout(backgroundGraceTimer);
      }
    });

    // Async setup: build the persistent encrypted cache first, then wire the runtime + relay.
    const setup = async (): Promise<void> => {
      let relay: MirrorSet | null = null;
      // T16-S3 (ship-dark behind COMPACTION_V2): per-cid durable feed-snapshot high-water floor,
      // seeded from secure storage on cold boot in startRelay() and read by the reconcile filter so a
      // compaction-blanked low-volume kind isn't re-fetched over Tor. Stays empty (and is never read)
      // when the flag is off — every consumer gates on COMPACTION_V2 first.
      const snapshotHighWaterByCid = new Map<string, Record<number, number>>();
      // T1 (ship-dark behind PUSH_UNIFIEDPUSH): the member's joined-group ids, mirrored from the
      // runtime snapshot so the push registration's coarse `h:` trigger keys stay current. Only ever
      // updated when the flag is on (the mirror in runtime.subscribe below is flag-guarded).
      let pushGroupIds: string[] = [];
      // Track the current relay socket so the community switcher can close it (→ reconnect).
      let activeSocket: ReturnType<typeof createTorRelaySocket> | null = null;
      // Arrival listeners for the lazy media-blob fetch service (see setMediaBlobService below).
      // Session-stable ON PURPOSE, rather than handing the service `relay.onEvent` directly: a blob
      // fetch keeps its listener registered for the whole FETCH_TIMEOUT_MS deadline, and `relay` is
      // rebuilt on every (re)connect — a reconnect inside that window would strand the listener on a
      // closed MirrorSet and the fetch would report a bogus timeout for bytes that did arrive. Fed by
      // the live relay's onEvent handler in startRelay(); empty unless a chip has a fetch in flight.
      const blobEventListeners = new Set<(event: Event) => void>();
      // Suppresses the relay's auto-reconnect while a community switch tears the socket down on
      // purpose — the runtime reconnects to the NEW community's relay right after the swap, so we
      // must not let the down-handler race a reconnect to the OLD one.
      let suppressReconnect = false;

      // Per-community event store factory: each community gets its OWN SQLCipher-encrypted DB file
      // (or its own hardware-encrypted blob when op-sqlite isn't linked), so switching communities
      // never mixes their feeds/DMs. The runtime opens the active community's store on init() and
      // swaps to the target's on every switch. RAM-only on a build without secure storage.
      const makeStore = async (cid: string | null, slotId: string | null): Promise<EventStore> => {
        if (!secureStorage) return new InMemoryEventStore();
        // T16-S2 (ship-dark behind COMPACTION_V2): seed the per-account SqliteEventStore with the
        // organizer-tuned retention caps at open, so cold boot prunes with the org policy BEFORE the
        // first prune fires. Flag OFF → `policy` is undefined and the 4th arg is dropped, so the call
        // is byte-identical to today (default caps). The active community's storagePolicy is read from
        // a fresh CommunityStore (constructed only on this branch, so flag-off never touches storage).
        const policy = COMPACTION_V2
          ? toRetentionPolicy((await new CommunityStore(secureStorage).active())?.storagePolicy)
          : undefined;
        // Per-(community, ACCOUNT) store (finding #4): appending the account slot gives each account
        // its OWN encrypted DB file / SQLCipher key / fallback blob, so two accounts in one community
        // never share a cache holding the public feed AND their kind-1059 DM gift-wraps.
        const created =
          (await createEncryptedEventStore(secureStorage, cid ?? undefined, slotId ?? undefined, policy)) ??
          (await PersistentEventStore.create(secureStorage, cid ?? undefined, slotId ?? undefined));
        // T16-S3: on every REAL compaction (SqliteEventStore fires this ONLY when COMPACTION_V2 pruned
        // something), snapshot the feed high-water so aggressive pruning never blanks the cold-boot
        // feed or forces a Tor re-fetch. Only SqliteEventStore exposes the observer; the in-memory /
        // persistent fallbacks lack it, so the optional-call `?.` no-ops there. Flag OFF → never fires.
        // Namespaced per-(cid, slot) so account A's floor never applies to account B's fresh store.
        if (COMPACTION_V2) {
          (created as {setCompactionObserver?: (cb: (s: EventStore) => void) => void})
            .setCompactionObserver?.(s => {
              const snap = buildFeedSnapshot(s, FEED_KINDS);
              void saveFeedSnapshot(secureStorage, cid ?? undefined, snap, slotId ?? undefined);
            });
        }
        return created;
      };
      // A swappable shell held by BOTH the runtime and every RelayClient, so a community switch only
      // needs to swap the inner store (the runtime does this) and both sides follow. Starts empty;
      // runtime.init() opens the active community's real store into it.
      const store = new SwappableEventStore(new InMemoryEventStore());
      if (disposed) {
        return;
      }

      // Bind the lazy media-blob service to this session's store + relay, mirroring setMediaService
      // above. This is the thing that turns a tap on a blob-backed picture/voice chip into a REAL
      // id-scoped REQ over Tor (media/mediaBlobService.ts); unbound, such a chip fails honestly as
      // 'offline' rather than spinning. Torn down on unmount so a stale relay/store can't be dialed.
      //
      // Deliberately inside setup() (not beside setMediaService at the top of this effect): the deps
      // it needs — `store` and `relay` — only exist here. It follows the two lifetimes correctly:
      //   • `store` is the ONE SwappableEventStore held for the whole session. A community switch
      //     swaps its INNER store, so getById automatically follows the switch and can never answer
      //     a blob out of the wrong silo — no rebind needed, which is why this binds once.
      //   • `relay` is a `let` torn down and rebuilt on every (re)connect / dormancy cycle, so
      //     fetchById and isConnected read it LIVE through a closure — exactly the idiom `publish`
      //     and `fetchEvents` use below — rather than capturing one MirrorSet a reconnect would
      //     strand.
      setMediaBlobService(
        createMediaBlobService({
          getById: id => store.getById(id),
          fetchById: ids => relay?.fetchById(ids),
          onEvent: cb => {
            blobEventListeners.add(cb);
            return () => {
              blobEventListeners.delete(cb);
            };
          },
          // `relay` is non-null only between a completed Tor bootstrap (startRelay) and the next
          // offline/disconnect/dormancy teardown — the SAME liveness test `publish` uses to decide a
          // write is "offline". A tap while Tor is down then fails fast and honestly instead of
          // spinning for the full fetch deadline to arrive at the answer we already had.
          isConnected: () => relay !== null,
        }),
      );
      cleanups.push(() => setMediaBlobService(null));

      // Set once the token-draw orchestration is defined below; lets the runtime force a fresh token
      // draw on demand (empty wallet at write time) so posting/voting never blocks on the invisible
      // anti-spam token. Until then it's a no-op.
      let doDrawTokens: (() => Promise<boolean>) | null = null;

      // Set in startRelay (where the Tor manager + active relay URL are live); lets the runtime open a
      // fresh dedicated draw socket to stock the AUXILIARY token wallets (space-write, media-write)
      // and cover an on-demand space-token spend. Until then it's a no-op (auxiliary domains ship
      // dark, so the runtime simply skips stocking them).
      let connectForDrawFn: (() => ReturnType<typeof createTorRelaySocket>) | null = null;

      const runtime = new AppRuntime({
        secureStorage,
        store,
        // PIN lock triggers (bug round 2026-07-15, user decision — see config.ts's
        // IDLE_LOCK_ENABLED for the full reasoning). false (default): Infinity disables
        // AutoLock's idle timer entirely (lock/autolock.ts's arm() then never schedules), so the
        // PIN never re-locks from foreground inactivity — only a genuine cold start (a fresh
        // AutoLock always constructs 'locked') or an explicit lock() call (see LOCK_ON_BACKGROUND
        // below) locks it. true restores the AUTO_LOCK_MS-based idle lock byte-identical to
        // before this round.
        autoLockMs: IDLE_LOCK_ENABLED ? AUTO_LOCK_MS : Number.POSITIVE_INFINITY,
        // Lets the runtime open/swap each community's own encrypted store on init and on switch.
        createStore: makeStore,
        // Transparent on-demand token top-up: called when a blind write finds the wallet empty.
        drawTokensNow: () => doDrawTokens?.() ?? Promise.resolve(false),
        // Fresh draw socket for the auxiliary token wallets (tokens-everywhere). Late-bound: throws
        // until startRelay wires the Tor manager + active relay URL, so the runtime's callers (which
        // guard/try-catch) simply skip auxiliary stocking while dark or pre-connect.
        connectForDraw: () => {
          if (!connectForDrawFn) throw new Error('draw socket unavailable (relay not connected)');
          return connectForDrawFn();
        },
        // Close the live relay BEFORE a switch swaps identity/store, so no in-flight write lands in
        // the incoming community's store or gets signed with the new npub. The runtime reconnects
        // afterwards via forceRelayReconnectRef (see handleSwitchCommunity).
        onRelayTeardown: async () => {
          suppressReconnect = true;
          // close() tears down ALL secondary mirror children (Tor circuits + reconcile/reconnect
          // timers) as well as the primary — without it, orphaned secondaries keep ingesting into the
          // shared store, which the runtime swaps in place to the NEW community's DB (cross-community
          // contamination). suppressReconnect guards the induced onRelayDown; double-close is harmless.
          try { relay?.close(); } catch { /* ignore */ }
          if (activeSocket) {
            try { activeSocket.close(); } catch { /* ignore */ }
          }
          relay = null;
          relayRef.current = null;
          activeSocket = null;
        },
        organizerNpub: ORGANIZER_NPUB || undefined,
        // Lazy publish: delegates to the relay once it's connected. When the relay socket isn't up
        // yet (Tor still building the onion circuit, or a dropped connection), report `offline` so
        // the runtime keeps the post queued and auto-resends it on reconnect — rather than flashing
        // a misleading "failed" on a post the user made while still connecting.
        publish: event =>
          relay
            ? relay.publish(event)
            : Promise.resolve({accepted: false, message: 'relay not connected', offline: true}),
        // Lazily fetch quoted posts (NIP-18/27 embeds) not yet in the cache.
        fetchEvents: ids => relay?.fetchById(ids),
        // Lazily fetch uncached naddr embeds (NIP-23 articles) by {kind,author,#d} filter.
        fetchByFilter: filters => relay?.fetchByFilter(filters),
        // NIP-29: open a group-scoped subscription (chat by #h, relay state by #d) while a
        // group view is on screen. Both filters are scoped, satisfying the relay's group query
        // rule. Closed when the view unmounts.
        subscribeGroup: groupId => {
          // Incremental chat resub: the since tail only pulls messages/reactions newer than this
          // group's cached high-water mark (minus a 300s overlap for relay lag). Without this, every
          // reconnect — and resubscribeGroups() re-opens EVERY joined group on every reconnect —
          // re-streamed the whole chat history of every group over Tor and re-verified each event.
          // On a FRESH group (no cached chat yet) `since` is bounded instead by a `limit`
          // (newest-first) rather than the full history — this REQ then stays open and doubles as
          // the live delivery tail, same shape as the feed's cold path (bug #3: no more oldest-first
          // full-history download). A newest-first bounded page ALWAYS rides alongside the since
          // tail: the cached high-water can sit ABOVE a hole the tail can never see (the 2026-07-28
          // "posts not loading" field bug — see buildOpenChatFilters), and these kinds have no
          // reconcile pass to heal it. State kinds (39000-39005) are replaceable/addressable, so the
          // relay only returns their latest regardless.
          relay?.subscribeScoped(`group:${groupId}`, [
            ...buildOpenChatFilters(
              [9, 11, 12, 7],
              '#h',
              groupId,
              groupChatSince(store, groupId, 300),
              COLD_FEED_LIMIT,
            ),
            {kinds: [39000, 39001, 39002, 39003, 39004], '#d': [groupId]},
            {kinds: [39005], '#h': [groupId]},
            // Raw join requests: 39004 above carries pending PUBKEYS only — the sealed intro note
            // + request time ride the stored 9021s (membership handoff). Small volume, `#h`-scoped.
            {kinds: [9021], '#h': [groupId]},
            // The space's shared 30078 docs by `#d`: the admins' invited-set doc (space-invites)
            // AND the admin-signed settings doc (space-settings). The settings doc previously had
            // NO delivery path at all — the feed sub omits 30078 and org-config is organizer-scoped
            // — so another admin's rules/reactions/pin never actually arrived until now.
            {kinds: [30078], '#d': [`space-invites:${groupId}`, `space-settings:${groupId}`]},
            // Space-key recovery (2026-07-28): re-fetch this space's 30079 key deliveries on open
            // (the standing space-keys sub's global `since` can pin itself above a delivery this
            // member never received — the message backfill's since-poisoning shape, healed the same
            // way), and pull any stranded member's key-redelivery request docs so a keyed admin
            // opening the space can answer them. See buildSpaceKeyRecoveryFilters.
            ...buildSpaceKeyRecoveryFilters(groupId),
          ]);
        },
        unsubscribeGroup: groupId => relay?.closeSub(`group:${groupId}`),
        // Bug 8 (SCOPED_CHANNEL_SYNC): open a channel-scoped kind-1311 subscription while a channel
        // view is on screen — the NIP-53 twin of subscribeGroup above, and gated here so that with
        // the flag OFF the dep is undefined, AppRuntime.openChannel/closeChannel are no-ops, and
        // nothing about today's firehose behaviour changes.
        //
        // Why this exists ALONGSIDE the plan's standing `channels` sub: that one covers channels the
        // member is already IN. This covers the channel they just OPENED — which, when reached from a
        // profile, a stiq:space embed or a deep link, is a channel they have NOT joined and the
        // standing sub deliberately does not carry. It also pages in an opened channel's own history
        // instead of leaving it whatever slice of the standing sub's shared `limit` it happened to get.
        //
        // Incremental `since` off this channel's own cached high-water (minus a 300s overlap for relay
        // lag), PLUS an always-present newest-first bounded page, in one REQ — identical in shape and
        // rationale to subscribeGroup's chat filters. The bounded page is the 2026-07-28 field fix:
        // the standing `channels` sub's shared limit page (and the retention prune) cache newest-only
        // strays, so a since-only resub pinned itself above a hole it could never refetch and the
        // channel read "posts not loading" forever (see buildOpenChatFilters). Re-requested messages
        // dedupe on id in ingest() before the schnorr verify, so the overlap is bandwidth-only.
        subscribeChannelChat: !SCOPED_CHANNEL_SYNC
          ? undefined
          : channelId => {
              relay?.subscribeScoped(
                `channel:${channelId}`,
                buildOpenChatFilters(
                  [Kind.LiveChat],
                  '#a',
                  channelId,
                  channelChatSince(store, channelId, 300),
                  COLD_FEED_LIMIT,
                ),
              );
            },
        unsubscribeChannelChat: !SCOPED_CHANNEL_SYNC
          ? undefined
          : channelId => relay?.closeSub(`channel:${channelId}`),
        // Pull-to-refresh: re-run the relay's feed reconciliation. Resolves immediately when the
        // relay isn't connected yet so the spinner never hangs.
        resyncFeed: () => relay?.resyncFeed() ?? Promise.resolve(),
        // A durable stiq:mirrors adoption reaches the LIVE MirrorSet here (synthesis §1.9): a
        // newly-trusted honest mirror is connected without waiting for the next reconnect. No-op
        // before the relay is up (it's rebuilt from the new set on the next connect anyway).
        onMirrorsChanged: specs => relay?.updateSecondaryMirrors(specs),
        // A new AUTH-GATED mirror needs a Tor restart (ClientOnionAuthDir is read only at daemon
        // startup) to write its <host>.auth_private before it's reachable. The runtime asks for this
        // only when the required onion-auth set actually grew; reconnectActiveRelayRef restarts the
        // daemon when a secondary key isn't loaded yet, else just bounces the socket.
        requestRelayReconnect: () => reconnectActiveRelayRef.current?.(activeRelayUrl),
        // Negotiate what the relay actually enforces: fetch its NIP-11 information document OVER TOR
        // (never clearnet — the same onion host as the relay socket, ws(s):// → http(s)://), with
        // the NIP-11 Accept header. Returns the parsed JSON doc for AppRuntime to fold into its
        // RelayCapabilities; the runtime keeps its constant fallback if this throws (offline /
        // non-JSON / older relay). Reads the live `activeRelayUrl` so it follows a community switch.
        fetchRelayInfo: async () => {
          const infoUrl = activeRelayUrl.replace(/^ws/, 'http');
          const {text} = await torFetchText(manager, {
            url: infoUrl,
            headers: {Accept: 'application/nostr+json'},
          });
          return JSON.parse(text) as unknown;
        },
      });
      runtimeRef.current = runtime;
      // Membership CTA on every private-space embed card (ReferencedCard renders across five
      // surfaces — DM/group/channel/comments/feed — so the state is resolved through this one
      // registered seam instead of a prop threaded through all of them; see channels/spaceCta.ts).
      setJoinStateResolver(gid => runtime.joinRequestStateFor(gid));
      // Live event-card state (counts / status / viewer RSVP) for every stiq:event: embed — the
      // same one-seam pattern (events/eventCardState.ts): both render pipelines read it at paint.
      setEventLiveResolver(coordinate => runtime.eventLive(coordinate));

      // Which relay this device talks to: the active community's relay (set at enrollment),
      // falling back to the build-time default before the user has joined anything.
      // `let` (not const) so the community switcher can update it mid-session.
      // This runs BEFORE attemptInit()'s init()-vs-timeout race, so an exception here escapes setup()
      // entirely and the recovery path never arms — a rejected keystore read (e.g. a mis-signed build
      // whose SecItem calls fail with errSecMissingEntitlement) would otherwise pin the launch splash
      // forever with no way out. Fall back to the build-time default relay on any failure; init() below
      // still runs under its own INIT_TIMEOUT_MS guard, so a genuinely broken keystore lands on the
      // recovery screen instead of an unbreakable splash.
      let activeRelayUrl = RELAY_ONION_WS;
      try {
        activeRelayUrl = await runtime.activeRelayUrl(RELAY_ONION_WS);
      } catch (e) {
        log.error('setup:activeRelayUrl', e);
      }

      // Community switcher: update the URL and connect to the new relay. When the runtime tore the
      // old socket down for the switch (onRelayTeardown), there is no live socket, so connect now;
      // otherwise close the current one (→ onRelayDown → reconnect). Clearing suppressReconnect
      // re-enables the auto-retry path for the new relay. Reset the failure streak so an intentional
      // relay change doesn't escalate to a more-evasive transport.
      forceRelayReconnectRef.current = (newUrl: string): void => {
        activeRelayUrl = newUrl;
        relayFailureStreak = 0;
        suppressReconnect = false;
        if (activeSocket) {
          // Closing triggers onRelayDown → schedules startRelay() on the new URL.
          try { activeSocket.close(); } catch { /* ignore */ }
        } else {
          // No live socket (just switched/enrolled, or the un-enrolled app had no relay yet): connect
          // now so the feed relay comes up on the freshly-active community's URL without a restart.
          startRelay();
        }
      };

      // Reconnect to the now-active community after a community/identity switch or a community removal.
      // The active onion-auth may have CHANGED, so unlike forceRelayReconnectRef (a pure socket bounce)
      // this checks whether the running Tor daemon already carries the active community's onion
      // client-auth key. Tor reads ClientOnionAuthDir only at startup, so if the credential isn't
      // loaded a socket bounce would loop forever on an unreachable rendezvous — restart the daemon so
      // it loads the key, then the relay comes up on the new URL via the Tor-connected → startRelay
      // path (manager.onChange). When the credential IS already loaded (or the onion is public), a
      // bounce is enough, so defer to forceRelayReconnectRef.
      // True only when the running daemon already carries EVERY active reach credential — the primary
      // AND every secondary-mirror extra (synthesis §1.7/§1.9). A secondary key that isn't loaded
      // means Tor must RESTART to write it (it reads ClientOnionAuthDir only at startup), so a socket
      // bounce alone would loop forever on that unreachable mirror. Single-mirror/public-onion builds
      // have an empty extra set, so this is byte-identical to the primary-only check there.
      const allOnionAuthLoaded = (): boolean =>
        manager.isOnionAuthActive(getActiveOnionAuth()) &&
        getActiveOnionAuthExtra().every(a => manager.isOnionAuthActive(a));

      reconnectActiveRelayRef.current = (newUrl: string): void => {
        if (allOnionAuthLoaded()) {
          forceRelayReconnectRef.current?.(newUrl);
          return;
        }
        activeRelayUrl = newUrl;
        relayFailureStreak = 0;
        suppressReconnect = false;
        // If a cascade is mid-flight, ask it to re-loop rather than dropping a fresh runCascade().
        rerunRequested = cascadeRunning;
        void (async () => {
          await manager.disconnect();
          void runCascade();
        })();
      };

      // Resolve once Tor has a live circuit, or false on timeout. The onboarding "Connecting"
      // step calls the exchange the moment the member taps Connect — Tor is usually still
      // bootstrapping in the background — and createTorRelaySocket throws when Tor is offline.
      // Waiting here means the blinded round-trip doesn't fail just because the member got here
      // before the circuit finished; the connecting UI narrates the wait.
      const waitForTor = (timeoutMs: number): Promise<boolean> => {
        if (manager.isLive()) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>(resolve => {
          let settled = false;
          let unsub = (): void => {};
          const timer = setTimeout(() => {
            if (!settled) { settled = true; unsub(); resolve(false); }
          }, timeoutMs);
          unsub = manager.onChange(st => {
            if (st === 'connected' && !settled) { settled = true; clearTimeout(timer); unsub(); resolve(true); }
          });
        });
      };

      releaseOnboardingTorRef.current = (restoreActive: boolean): void => {
        onboardingOnionAuth = undefined;
        if (!restoreActive) {
          return;
        }
        const activeAuth = getActiveOnionAuth();
        if (manager.isOnionAuthActive(activeAuth)) {
          return;
        }
        // Cancelling "Join another community" must put the daemon back on the still-active
        // community's credential. Reuse the normal single-flight cascade and transport preference.
        rerunRequested = cascadeRunning;
        void (async () => {
          await manager.disconnect();
          void runCascade();
        })();
      };

      // Default-network change (Wi-Fi↔cellular): the native layer fires StiqTorNetworkChange when
      // the device's default network switches. The live Tor circuits + relay socket are then dead,
      // but a blocking read won't notice for up to the ~90s watchdog — so if we're connected, bounce
      // the relay now. startRelay reconnects on the new network, and the relay-down chain (NEWNYM +
      // escalation) rebuilds circuits if the first attempt fails. Ignored unless actually live (not
      // just getState() === 'connected', which can briefly stale-report true into a still-resolving
      // disconnect() — see TorManager.isLive()'s doc), so a spurious nudge is harmless.
      const netChangeSub = DeviceEventEmitter.addListener('StiqTorNetworkChange', () => {
        // DE-ESCALATE: bridgeStartTier is otherwise a one-way ratchet for the whole session — once a
        // transport is condemned, every later cascade skips it until the app is relaunched. But the
        // thing it recorded is "direct doesn't work ON THIS NETWORK", and the network just changed,
        // so that verdict no longer describes reality: a user who walked from a censored café onto
        // home WiFi stayed pinned to snowflake for the rest of the session. Clearing it only affects
        // the NEXT cascade (this handler bounces the relay, it doesn't rebuild the transport), so a
        // working connection is never disturbed — and if direct really is still blocked, the cascade
        // re-condemns it at the cost of one probe.
        bridgeStartTier = -1;
        deadRungs.clear();
        // T4: while dormant, DON'T wake the relay — stay idle and just remember that the network
        // changed, so the next exit() (foreground return) forces exactly one relay bounce onto the
        // new network. `dormant` is always false when TOR_DORMANCY is off, so this latch never fires
        // and the legacy live-bounce path below is byte-identical.
        if (dormant) {
          networkChangedWhileDormant = true;
          return;
        }
        if (manager.isLive()) {
          // TS-4: this fires from a native event and can land at any moment, including while a
          // WorkManager background sync is mid-flight on the shared daemon (e.g. it grabbed
          // ownership just before a foreground resume settled `dormant` back to false). Bouncing the
          // relay straight through forceRelayReconnectRef here would race that in-flight background
          // attempt on the one shared native Tor daemon — so run it through the same yield-and-wait
          // coordination as the dormancy resume path above instead of calling it unconditionally.
          // isStillValid re-checks isLive() too since it can go stale across the (bounded) wait.
          runYieldingToBackgroundSync(
            () => {
              if (manager.isLive()) {
                forceRelayReconnectRef.current?.(activeRelayUrl);
              }
            },
            {isStillValid: () => !dormant},
          );
        }
      });
      cleanups.push(() => netChangeSub.remove());

      // Apply a just-changed connection mode (or a manual Retry): a full Tor restart under the
      // freshly-saved prefs. Unlike forceRelayReconnectRef (which only bounces the relay socket),
      // this resets the sticky in-session escalation so the new mode starts fresh, then re-enters
      // the single-flight cascade. It deliberately KEEPS the last-working bridge cache + prefetched
      // bridges: warm-starting the set that just connected is the fastest, most reliable path —
      // exactly what we want when the user lands on Automatic after trying other modes.
      applyTorPrefsRef.current = (): void => {
        bridgeStartTier = -1;
        deadRungs.clear();
        activeTier = -1;
        relayFailureStreak = 0;
        desiredConnected = true;
        // If a cascade is mid-flight, ask it to re-loop under the new prefs (the single-flight
        // guard would drop a fresh runCascade()). Otherwise runCascade() below starts one.
        rerunRequested = cascadeRunning;
        void (async () => {
          await manager.disconnect();
          void runCascade();
        })();
      };

      // Keep one cryptographic enrollment prepared across transport/UI retries. This matters because
      // the invite is one-shot: if Tor drops after the organizer signs but before the phone receives
      // the reply, generating a new blinded token would make the already-issued response impossible
      // to recover. The same reply key lets a fresh subscription replay it from relay storage.
      type PendingEnrollment = {
        key: string;
        blindRsa: RealBlindRsa;
        prepared: Promise<PreparedCredentialExchange>;
      };
      let pendingEnrollment: PendingEnrollment | null = null;
      let exchangeFlight: {key: string; promise: Promise<ExchangeResult>} | null = null;
      let completedEnrollment: {key: string; result: Extract<ExchangeResult, {ok: true}>} | null = null;
      // Latches the key of the exchange whose transport circuit has opened. A second caller that
      // attaches to an already-in-flight exchange (below) replays onCircuitOpen synchronously from
      // this instead of missing the event, mirroring torSocket.ts's late-subscriber onOpen replay.
      let circuitOpenedForKey: string | null = null;

      // Open a dedicated socket to the community's OWN relay (from the join code, which may differ
      // from the active feed relay). Calls for the same invite are single-flight: a Tor state blip
      // can remount the exchange phase, but it must attach to the existing round-trip instead of
      // launching a second request while the first may already have consumed the invite.
      exchangeFnRef.current = (community, inviteCode, hooks): Promise<ExchangeResult> => {
        const key = `${community.relayUrl}\u0000${community.organizerPubkey ?? ''}\u0000${inviteCode}`;
        // The screen intentionally leaves the exchange phase when Tor reports a drop. A response can
        // still win that race just before the socket closes; retain it so the remounted phase consumes
        // the successful session instead of generating a doomed second request for the spent invite.
        if (completedEnrollment?.key === key) {
          return Promise.resolve(completedEnrollment.result);
        }
        if (exchangeFlight?.key === key) {
          if (circuitOpenedForKey === key) {
            hooks?.onCircuitOpen?.();
          }
          return exchangeFlight.promise;
        }

        const promise = (async (): Promise<ExchangeResult> => {
          const requestedAuth = deriveOnionAuth(community.relayUrl, community.onionAuthKey);
          onboardingOnionAuth = requestedAuth;
          if (!manager.isOnionAuthActive(requestedAuth)) {
            // Tor's network bootstrap can be complete while this onion is still unreachable: v3
            // client authorization is loaded only when the daemon starts. Restart once with the
            // pending join code's key before opening the credential mailbox socket.
            rerunRequested = cascadeRunning;
            await manager.disconnect();
            void runCascade();
            if (!(await waitForTor(150_000))) {
              return {
                ok: false,
                timedOut: true,
                error: 'Tor could not restart with this community credential',
              };
            }
          }

          // v2 deferred issuer key: a short join code carries `cid` (the pinned identity) but omits
          // the ~392-char enroll key itself (`issuerPublicKey === ''`). Now that Tor is confirmed
          // reachable to this relay, fetch its NIP-11 document (the same torFetchText transport as
          // fetchRelayInfo) and verify the advertised enroll key hashes to `cid` BEFORE it ever
          // touches blind-RSA. Fail closed on any mismatch, absence, or fetch error — never blind a
          // token against an unverified key. v1 codes (and any v2 code with `ik` inline) already
          // carry a non-empty issuerPublicKey and skip this entirely.
          //
          // RESILIENCE: this is the FIRST onion contact of the whole join and it runs immediately
          // after the onion-auth Tor restart above — the coldest possible circuit (onion descriptor
          // not yet fetched, no warm rendezvous). A single 30s shot failed often enough that members
          // had to tap "Try again" 2-3 times before a warmed circuit let it through (each manual
          // retry only worked because the prior attempt had warmed Tor's descriptor cache). The
          // credential exchange BELOW already retries its socket 3x with a NEWNYM between tries; the
          // enroll-key fetch that GATES it now does the same, so a cold-circuit blip self-heals
          // automatically instead of dead-ending at "Couldn't connect". A key MISMATCH/absence is a
          // definitive verdict (stale invite or hostile relay), never a transport blip — it still
          // fails closed on the first try and is never retried into acceptance.
          const ENROLL_KEY_FETCH_ATTEMPTS = 4;
          const ENROLL_KEY_FETCH_BACKOFF_MS = 2_000;
          let resolvedCommunity: Community = community;
          if (!community.issuerPublicKey) {
            if (!community.cid) {
              return {ok: false, error: 'this join code is missing identity information'};
            }
            const infoUrl = community.relayUrl.replace(/^ws/, 'http');
            let lastFetchError = 'could not reach this community to verify its issuer key';
            let resolved = false;
            for (let attempt = 0; attempt < ENROLL_KEY_FETCH_ATTEMPTS && !resolved; attempt++) {
              // Happy path (Tor already live) resolves instantly; only a mid-NEWNYM churn waits here.
              if (!(await waitForTor(60_000))) {
                lastFetchError = 'Tor is still connecting — could not verify this community’s issuer key';
              } else {
                try {
                  const {text} = await torFetchText(manager, {
                    url: infoUrl,
                    headers: {Accept: 'application/nostr+json'},
                  });
                  const caps = parseRelayCapabilities(JSON.parse(text) as unknown);
                  const enrollKey = caps.issuerKeys.enroll;
                  if (!enrollKey || !enrollKeyMatchesCid(enrollKey, community.cid)) {
                    // Definitive: retrying a mismatch would only launder a stale/hostile key.
                    return {
                      ok: false,
                      error: 'could not verify this community’s issuer key — the invite may be stale',
                    };
                  }
                  resolvedCommunity = {...community, issuerPublicKey: enrollKey};
                  resolved = true;
                } catch (e) {
                  // Network / timeout / partial cold-circuit read — transient; rotate + retry.
                  lastFetchError = `could not reach this community to verify its issuer key: ${
                    e instanceof Error ? e.message : String(e)
                  }`;
                }
              }
              if (!resolved && attempt < ENROLL_KEY_FETCH_ATTEMPTS - 1) {
                // Fresh rendezvous for the next try (the onion descriptor stays cached, so the retry
                // is warmer); the short backoff gives NEWNYM time to land, mirroring the exchange.
                requestNewTorCircuit();
                await new Promise<void>(r => setTimeout(r, ENROLL_KEY_FETCH_BACKOFF_MS));
              }
            }
            if (!resolved) {
              return {ok: false, error: lastFetchError};
            }
          }

          if (pendingEnrollment?.key !== key) {
            const blindRsa = new RealBlindRsa();
            const entry: PendingEnrollment = {
              key,
              blindRsa,
              prepared: prepareCredentialExchange({
                community: resolvedCommunity,
                inviteCode,
                blindRsa,
                powDifficulty: runtimeRef.current?.relayCapabilities().enrollPow ?? ENROLL_POW_DIFFICULTY,
              }),
            };
            pendingEnrollment = entry;
          }
          const entry = pendingEnrollment;
          if (!entry) {
            return {ok: false, error: 'could not prepare the credential exchange'};
          }

          let prepared: PreparedCredentialExchange;
          try {
            prepared = await entry.prepared;
          } catch (e) {
            if (pendingEnrollment === entry) {
              pendingEnrollment = null;
            }
            throw e;
          }

          const result = await runCredentialExchange({
            connect: async () => {
              // Tor may drop between attempts. Wait for the daemon's real 100% state before opening
              // each fresh onion stream; the onboarding screen can show its Tor phase meanwhile.
              if (!(await waitForTor(150_000))) {
                throw new Error('Tor is still connecting');
              }
              return createTorRelaySocket(manager, resolvedCommunity.relayUrl);
            },
            community: resolvedCommunity,
            inviteCode,
            blindRsa: entry.blindRsa,
            powDifficulty: runtimeRef.current?.relayCapabilities().enrollPow ?? ENROLL_POW_DIFFICULTY,
            prepared,
            // A new WebSocket can otherwise reuse the same failed onion rendezvous circuit.
            // Rotate before attempts 2/3; runCredentialExchange's backoff gives NEWNYM time to land.
            onRetry: () => requestNewTorCircuit(),
            onCircuitOpen: () => {
              circuitOpenedForKey = key;
              hooks?.onCircuitOpen?.();
            },
            onCircuitFailed: reason => hooks?.onCircuitFailed?.(reason),
          });
          if (result.ok && pendingEnrollment === entry) {
            pendingEnrollment = null;
            completedEnrollment = {key, result};
          }
          return result;
        })();

        const flight = {key, promise};
        exchangeFlight = flight;
        promise.then(
          () => {
            if (exchangeFlight === flight) {
              exchangeFlight = null;
            }
          },
          () => {
            if (exchangeFlight === flight) {
              exchangeFlight = null;
            }
          },
        );
        return promise;
      };

      // First-run community prefetch (onboarding/prefetchCommunity.ts) — the connecting step's
      // "Getting your community ready" rung. Wired here because everything it needs lives in this
      // closure: the Tor manager (for a dedicated socket to the community's OWN relay, exactly as
      // the credential exchange above opens one), and `makeStore` — the SAME per-(cid, account)
      // encrypted-store factory the runtime uses, which is what makes the database this warms
      // byte-for-byte the one `completeEnrollment` later opens.
      startCommunityPrefetchRef.current = (session: Session): CommunityPrefetch =>
        startCommunityPrefetch(session, {
          connect: async () => {
            // Tor is up by definition here (the exchange just completed over it), but a circuit can
            // drop in the seconds between — wait rather than throwing the member into a failed rung.
            if (!(await waitForTor(150_000))) {
              throw new Error('Tor is still connecting');
            }
            return createTorRelaySocket(manager, session.relayUrl);
          },
          createStore: (cid, slotId) => makeStore(cid, slotId),
          // Same ingest verifier the production feed client uses (native BIP-340 when linked) —
          // prefetched events are verified exactly as streamed ones are, never trusted for being early.
          verify: createEventVerifier(),
        });

      // Blind-posting token top-up: when this community uses relay-blind posts (a community key is
      // loaded), keep the wallet generously stocked over a DEDICATED Tor socket (same pattern as the
      // enrollment exchange, so it never clobbers the feed client's handler). Every post, comment AND
      // reaction/vote spends one token, so the watermark/batch are large — the whole point is that a
      // well-meaning member never notices the wallet. No-op for v1/v2 communities (no community key).
      const WALLET_LOW_WATERMARK = 40;
      // One in-flight draw shared by every trigger (relay-connect, and the runtime's on-demand top-up)
      // so concurrent requests coalesce into a SINGLE Tor round-trip instead of racing.
      let drawInFlight: Promise<boolean> | null = null;
      // Draw a batch; `force` skips the watermark (the on-demand path, when the wallet is truly empty).
      // Resolves true when ≥1 token landed. Best-effort — never throws.
      const drawTokens = (force: boolean): Promise<boolean> => {
        if (drawInFlight) return drawInFlight;
        drawInFlight = (async (): Promise<boolean> => {
          try {
            // Snapshot the target relay up front: a community switch mid-draw must NOT redirect this
            // draw's retries to the new relay (the connect factory below would otherwise read the
            // mutated activeRelayUrl and send this community's request to the wrong onion).
            const relayUrl = activeRelayUrl;
            if (getActiveCommunityKey() == null || !relayUrl) return false;
            if (!force && (await runtime.walletBalance()) >= WALLET_LOW_WATERMARK) return false;
            if (!(await waitForTor(60_000))) return false;
            // runTokenDraw owns the socket lifecycle now: it opens a FRESH dedicated Tor socket per
            // attempt and retries (reusing one signed request + reply key), so a response lost over a
            // flaky circuit is recovered from the relay's stored copy instead of re-drawing — which
            // would waste epoch quota. Force (the on-demand path, a post waiting on an empty wallet)
            // uses a tighter per-attempt budget so the post fails fast to a neutral message instead of
            // hanging; the proactive background path stays patient (longer attempts) to stock quietly.
            const connect = (): ReturnType<typeof createTorRelaySocket> =>
              createTorRelaySocket(manager, relayUrl);
            const res = await runtime.drawTokens(
              connect,
              undefined,
              force ? {attempts: 2, timeoutMs: 22_000} : undefined,
            );
            return !!res?.ok && (res.drawn ?? 0) > 0;
          } catch {
            return false; // best-effort — a later trigger retries
          } finally {
            drawInFlight = null;
          }
        })();
        return drawInFlight;
      };
      // Proactive top-up: draw when below the watermark, and — since a well-meaning member should
      // never see an empty wallet — keep quietly re-trying in the background if a draw can't complete
      // over a bad Tor circuit, until the wallet is stocked or a small attempt budget is spent. The
      // budget resets on each fresh relay connect (see startRelay) and is torn down on disconnect.
      const PROACTIVE_RETRY_MS = 30_000;
      const MAX_PROACTIVE_RETRIES = 5;
      let proactiveRetries = 0;
      let proactiveTimer: ReturnType<typeof setTimeout> | null = null;
      const clearProactiveTimer = (): void => {
        if (proactiveTimer) { clearTimeout(proactiveTimer); proactiveTimer = null; }
      };
      // Audit finding #1: the very first post-enrollment top-up lands right as the user taps "Enter
      // the community" and the feed mounts its first-paint animation. Deferring only THIS kickoff
      // behind InteractionManager keeps it off that contended moment; every later trigger (the
      // proactive retry's own setTimeout, or a later relay reconnect) already runs well clear of the
      // mount animation, so it fires immediately as before. Draw correctness (watermark check,
      // retry/backoff, in-flight coalescing) is unchanged — only the first call's timing moves.
      let firstTokenTopUpDeferred = false;
      const maybeDrawTokens = (): void => {
        const kickoff = (): void => {
          void (async () => {
            await drawTokens(false);
            // No community key / no relay: nothing to stock. Otherwise reschedule while still low.
            if (getActiveCommunityKey() == null || !activeRelayUrl) { proactiveRetries = 0; return; }
            if ((await runtime.walletBalance()) >= WALLET_LOW_WATERMARK) { proactiveRetries = 0; return; }
            if (proactiveRetries >= MAX_PROACTIVE_RETRIES) return; // give up until next connect/foreground
            proactiveRetries += 1;
            clearProactiveTimer();
            proactiveTimer = setTimeout(() => { proactiveTimer = null; maybeDrawTokens(); }, PROACTIVE_RETRY_MS);
          })();
        };
        if (!firstTokenTopUpDeferred) {
          firstTokenTopUpDeferred = true;
          InteractionManager.runAfterInteractions(kickoff);
        } else {
          kickoff();
        }
      };
      // The runtime forces a draw through this when a write finds the wallet empty (invisible retry).
      doDrawTokens = () => drawTokens(true);
      // Enrollment's own kick (see onEnroll): start the first posting-token draw the instant the
      // member enters, instead of waiting for startRelay's proactive top-up — which cannot fire until
      // the feed relay's onion rendezvous completes, seconds to minutes later on a cold circuit.
      // Fire-and-forget: `drawTokens` is single-flight and never throws, so a later trigger simply
      // attaches to this one rather than racing it.
      kickTokenDrawRef.current = () => { void drawTokens(true); };
      // Late-bind the auxiliary-wallet draw socket now that the Tor manager + active relay URL are
      // live (tokens-everywhere). Reads activeRelayUrl fresh at call time so a community switch draws
      // against the current relay. Inert until the relay advertises space/media token requirements.
      connectForDrawFn = () => createTorRelaySocket(manager, activeRelayUrl);

      // Invisible auto-unlock bridge (members-only content): a sealed card's silent mount kick
      // routes here with its epoch. The runtime owns the whole flow — per-epoch dedup, backoff, the
      // read-token draw+unlock over its own dedicated Tor socket (deps.connectForDraw), and the
      // refusal state that alone ever surfaces to the user. This bridge just hands it the epoch;
      // there is deliberately NO direct unlock call here anymore, so every trigger (feed build,
      // card mount) shares one state machine and can never double-spend a read token.
      unlockContentRef.current = (epoch: number): Promise<boolean> => {
        runtime.noteLockedEpochs([epoch]);
        return Promise.resolve(true);
      };

      // ── T1 UnifiedPush registration (ship-dark behind PUSH_UNIFIEDPUSH) ─────────────────────────
      // Real "content-free wake over Tor": when the flag is on AND the relay advertises a push
      // watcher (pushEnabled) AND a distributor + native connector are present, register the app and
      // POST a coarse-key registration (p:/h:/e: — already-public tag values, no npub-to-name and no
      // content) to the watcher over the SAME torHttp chokepoint. ANY absence or failure silently
      // falls through to the unchanged WorkManager polling in the AppState handler above. Every step
      // is gated on PUSH_UNIFIEDPUSH so flag-off adds no behavior whatsoever. The helpers below are
      // defined unconditionally (startRelay's onSynced references pushHeartbeat) but only INVOKED
      // under the flag; each also guards internally on pushEnabled.
      let lastPushRegisterAt = 0;
      const pushRegister = async (endpoint: string): Promise<void> => {
        const caps = runtime.relayCapabilities();
        const watcher = caps.push?.watcher;
        const ntfy = caps.push?.ntfy;
        if (!pushEnabled(caps) || !watcher || !ntfy) return;
        const reg = buildRegistration(endpoint, {
          myPubkey: runtime.getPubkey() ?? '',
          groupIds: pushGroupIds,
          allowedNtfyHost: ntfy,
          ttlSeconds: 7 * 24 * 60 * 60,
        });
        if (reg) {
          lastPushRegisterAt = Date.now();
          void registerWithWatcher(watcher, reg, manager);
        }
      };
      // TTL heartbeat: re-register on relay sync (debounced ~hourly) so the watcher entry never
      // expires and picks up newly-joined groups. Reads the persisted endpoint; no-op without one.
      const pushHeartbeat = (): void => {
        if (Date.now() - lastPushRegisterAt < 60 * 60_000) return;
        void (async () => {
          if (!pushEnabled(runtime.relayCapabilities())) return;
          const endpoint = await getEndpoint();
          if (endpoint) await pushRegister(endpoint);
        })();
      };
      if (PUSH_UNIFIEDPUSH) {
        // One-shot registration at startup, only when the relay advertises a watcher, a distributor
        // is installed, and the native connector is compiled in. The endpoint arrives asynchronously
        // via the StiqPushEvent 'endpoint' event below (and getEndpoint on the heartbeat).
        void (async () => {
          if (!pushEnabled(runtime.relayCapabilities())) return;
          if (!hasUnifiedPushModule()) return;
          if (!(await getDistributor())) return;
          await registerApp();
        })();
        const pushSub = DeviceEventEmitter.addListener(
          'StiqPushEvent',
          (e: {type?: string; endpoint?: string}) => {
            if (e?.type === 'endpoint' && typeof e.endpoint === 'string') {
              void pushRegister(e.endpoint);
            }
          },
        );
        cleanups.push(() => pushSub.remove());
      }

      // Open the relay WebSocket through Tor and auto-retry if the socket closes.
      // The relay WS can fail during bootstrap (TorService broadcasts STATUS_ON when SOCKS
      // is ready, before 100% consensus is loaded) — the retry fires after Tor is fully up.
      // Consecutive relay connections that died WITHOUT ever delivering data. A streak while
      // Tor claims "connected" means the transport reaches Tor but not the onion (circuits
      // throttled, or a half-broken circuit whose WS opens but never carries frames) — so we
      // escalate DOWN the transport ladder to a more-evasive transport that can get usable
      // onion circuits where the current one can't on this network.
      let relayFailureStreak = 0;
      // Wall-clock floor for the next relay dial, and the single pending deferred retry.
      //
      // The backoff at the bottom of onRelayDown only governs the retry IT schedules. Every other
      // caller of startRelay() dialled immediately, so anything that re-runs the resume path —
      // pulling the notification shade, a dialog stealing focus, an app switch — injected an
      // un-backed-off onion dial straight into an active failure streak, no matter how many times
      // in a row. That both hammers the onion and accelerates transport escalation, since each
      // wasted dial increments the streak toward the escalation threshold.
      //
      // The floor is stored as a DEADLINE rather than recomputed per check because relayBackoffMs()
      // is jittered: recomputing would compare against a different value each time and could defer a
      // dial repeatedly. Late/duplicate callers now coalesce onto one pending retry.
      let nextRelayAttemptAt = 0;
      let relayRetryTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleRelay = (delayMs: number): void => {
        if (relayRetryTimer !== undefined) {
          return; // a retry is already pending — never stack them
        }
        relayRetryTimer = setTimeout(() => {
          relayRetryTimer = undefined;
          startRelay();
        }, delayMs);
      };
      cleanups.push(() => {
        if (relayRetryTimer !== undefined) {
          clearTimeout(relayRetryTimer);
          relayRetryTimer = undefined;
        }
      });
      // How long a relay WS may stay open without delivering a single frame before we treat it as
      // a dead onion circuit. Generous (90s): an onion rendezvous over a throttled bridge can take
      // well over a minute to carry its first frame, and giving up too early just churns circuits
      // and never lets a slow-but-working rendezvous complete.
      const RELAY_DATA_TIMEOUT_MS = 90_000;
      // How long a background/suspension window must exceed before exit() stops trusting the cached
      // relay socket and forces one reconnect. iOS suspends the process (freezing the dormancy grace
      // timer AND NWPathMonitor) so a long suspension can silently kill the relay WS on the SAME
      // network with no StiqTorNetworkChange event to bounce it. 60s is comfortably above the OS
      // picker windows (<60s — see LOCK_ON_BACKGROUND note) so a photo pick never trips it, and well
      // under the 90s RELAY_DATA_TIMEOUT_MS watchdog we're trying to pre-empt.
      const RESUME_STALE_SOCKET_MS = 60_000;
      const startRelay = (): void => {
        if (relay !== null || !manager.isLive()) {
          return;
        }
        // A DORMANT daemon is still isLive(): enter() deliberately never disconnect()s it (that is the
        // whole point — see foregroundLock.ts's dormant-daemon doc, "its TorManager keeps reporting
        // connected/isLive() and a live SOCKS proxy"), so the guard above cannot tell "Tor is up" from
        // "Tor is idled". Dialling here would open a relay socket over a daemon that is not building
        // circuits: it can never carry a frame, yet it sets `relay` non-null — and resumeFromDormant()
        // treats a non-null relay as "already connected, nothing to do". The foreground would then come
        // back to a socket that is dead by construction, with NOTHING scheduled to replace it until the
        // 90s RELAY_DATA_TIMEOUT_MS watchdog finally condemns it and starts the 5-60s backoff on top.
        // exit() clears `dormant` BEFORE calling resumeFromDormant(), so the resume path is unaffected;
        // the only caller this turns away is a stale backoff retry (see doEnter, which also clears it).
        // Always false when TOR_DORMANCY is off, so this is inert there.
        if (dormant) {
          return;
        }
        // Honour the backoff floor, but ONLY while a failure streak is live. Every path that resets
        // the streak to 0 (a successful sync via markRelayAlive, a community switch, a transport
        // escalation) therefore keeps its immediate first dial with no extra bookkeeping — the floor
        // exists to stop repeat dialling into a failing onion, not to slow down a fresh start.
        // Defer rather than drop: the caller wanted a connection and must still get one.
        if (relayFailureStreak > 0) {
          const waitMs = nextRelayAttemptAt - Date.now();
          if (waitMs > 0) {
            scheduleRelay(waitMs);
            return;
          }
        }
        // No community joined yet (un-enrolled app): there is no relay to talk to. The onboarding
        // credential exchange uses its own socket against the join code's relay, so the feed relay
        // simply stays closed until enrollment makes a community active.
        if (!activeRelayUrl) {
          return;
        }
        // EARLY-START GUARD: Tor may now be live before runtime.init() has hydrated (the early
        // cascade — see the kick above attemptInit()). The relay layer must not dial before the
        // active community's stores and credential exist; the init completion handler re-enters.
        if (!initComplete) {
          return;
        }
        // REACH HANDOFF: an early-started daemon bootstrapped credential-less. Install the active
        // community's reach credential into the LIVE daemon — Arti reads its keystore at
        // descriptor-fetch time, so unlike C-tor this needs no restart — then dial. Runs ONCE per
        // setup, keyed on reachEnsured ALONE: adding `|| !allOnionAuthLoaded()` here would re-enter
        // the install at native-call speed forever if a successful install ever failed to satisfy
        // that predicate (e.g. an extras/active-set mismatch during a switch). A later community
        // switch that changes the needed credential is owned by reconnectActiveRelayRef, which
        // already restarts the cascade when auth isn't loaded.
        if (!reachEnsured) {
          if (reachInstallInFlight) {
            return; // the settle handler below re-enters startRelay
          }
          reachInstallInFlight = true;
          void manager.installReach().then(
            ok => {
              reachInstallInFlight = false;
              reachEnsured = true;
              if (ok || allOnionAuthLoaded()) {
                startRelay();
                return;
              }
              // No live install path (backend predates installReach, or the native write failed):
              // fall back to the restart the pre-early-start flow always used — the new start
              // config carries the credential, and the cascade re-dials the relay when done.
              rerunRequested = cascadeRunning;
              void (async () => {
                await manager.disconnect();
                void runCascade();
              })();
            },
            () => {
              reachInstallInFlight = false;
            },
          );
          return;
        }
        try {
          let receivedData = false;
          let settled = false;
          let dataWatchdog: ReturnType<typeof setTimeout> | undefined;
          const socket = createTorRelaySocket(manager, activeRelayUrl);
          activeSocket = socket;

          // Handle a dead relay connection exactly once, from either a close/failure OR the
          // watchdog (a WS that opened but never delivered — a half-broken onion circuit).
          const onRelayDown = (): void => {
            if (settled) {
              return;
            }
            settled = true;
            if (dataWatchdog !== undefined) {
              clearTimeout(dataWatchdog);
              dataWatchdog = undefined;
            }
            // Tear down secondary mirror children too (their Tor circuits + reconcile/reconnect timers
            // outlive a primary-only `relay = null`, leaking circuits on every reconnect bounce and, on
            // a switch, ingesting into the swapped-in store). close() on the already-closing primary
            // socket is harmless.
            try { relay?.close(); } catch { /* ignore */ }
            relay = null;
            relayRef.current = null;
            activeSocket = null;
            // Stop any pending background token top-up: it would open a socket to a dead/old relay.
            clearProactiveTimer();
            // Intentional teardown for a community switch: the runtime will drive the reconnect to
            // the NEW relay (forceRelayReconnectRef), so don't auto-retry or escalate here — that
            // would race a connection to the OLD relay.
            if (suppressReconnect) {
              return;
            }
            relayFailureStreak = receivedData ? 0 : relayFailureStreak + 1;
            // The onion was unreachable over this circuit — rotate to a fresh one before the next
            // attempt so we don't keep riding the same dead rendezvous circuit. Only every Nth
            // failure, though: Arti's arti_new_identity() has no rate limit (unlike C-tor's NEWNYM,
            // which Tor itself throttles to ~once/10s) — every call immediately retires ALL onion
            // circuits, so rotating on every fast failure would fully execute each time and churn
            // half-built circuits rather than being harmlessly ignored.
            if (!receivedData && shouldRotateCircuit(relayFailureStreak)) {
              requestNewTorCircuit();
            }
            // Escalation: if rotating circuits still can't reach the onion after several tries,
            // this transport's circuits are throttled/blocked for onion rendezvous — climb DOWN
            // the ladder to the next, more-evasive transport (direct → webtunnel → obfs4 →
            // snowflake) and reconnect there. At the bottom (snowflake) we stop escalating and
            // keep rotating circuits, since there is nothing slower-but-more-reachable to try.
            //
            // The "is this transport to blame" verdict is isTransportCondemned() — a pure policy in
            // reconnectBackoff.ts, where the failure-count and elapsed-window thresholds live and are
            // unit-tested (a bare count fuse is what tore down a healthy transport in 16s). What stays
            // here is the ladder question it can't answer: whether there's anywhere worse-but-more-
            // evasive left to go, and whether we've already been there this session.
            const nextTier = Math.max(0, activeTier + 1);
            if (
              isTransportCondemned({
                streak: relayFailureStreak,
                transportSettledMs:
                  transportConnectedAt === 0 ? 0 : Date.now() - transportConnectedAt,
                torConnected: manager.getState() === 'connected',
              }) &&
              nextTier < BRIDGE_LADDER.length &&
              nextTier > bridgeStartTier
            ) {
              bridgeStartTier = nextTier;
              relayFailureStreak = 0;
              if (secureStorage) {
                void clearCachedBridges(secureStorage);
              }
              void (async () => {
                await manager.disconnect();
                void runCascade();
              })();
              return;
            }
            // Capped exponential backoff (5s→60s) keyed on the failure streak, so a persistent
            // outage stops hammering the relay/circuits and settles into an infrequent poll. A
            // successful connect resets the streak (markRelayAlive), restoring a fast first retry.
            // Publish the deadline before scheduling so an unrelated caller (a resume, a focus
            // bounce) that races this retry defers to the same instant instead of dialling early.
            const backoffMs = relayBackoffMs(relayFailureStreak);
            nextRelayAttemptAt = Date.now() + backoffMs;
            scheduleRelay(backoffMs);
          };

          // A WS that opens but never carries a single frame must count as a failure, or we'd
          // sit "Connected" forever with an empty feed and unsendable posts.
          dataWatchdog = setTimeout(() => {
            if (!receivedData) {
              try { socket.close(); } catch { /* ignore */ }
              onRelayDown();
            }
          }, RELAY_DATA_TIMEOUT_MS);

          socket.onClose(onRelayDown);
          // The feed subscription is a STANDING live REQ (bugs #3+#4): `since` the cache
          // high-water mark when warm, or a bounded `limit` (newest-first, COLD_FEED_LIMIT) on a
          // cold cache — either way the REQ stays open after its initial page and streams every
          // new matching event as it's published, which is the ONLY way posts/comments/channel
          // messages reach other members promptly. DMs are scoped to this user with rotating
          // decoy recipients (cover traffic) so the relay can't isolate which npub is checking its
          // inbox.
          //
          // NIP-77 (feature-flagged, warm cache only): ADDITIONALLY reconcile the feed against the
          // relay and fetch just the missing-id delta, as a gap-repair pass layered on top of the
          // live REQ above — never in its place. Runs on its own subId ('feed-neg', distinct from
          // the live REQ's 'feed') so the two sessions' bookkeeping never collides. Never opened on
          // a cold cache (the live REQ's bounded first page already covers it, and reconciling
          // against a relay's full history from an empty local set is pointless). Any reconciliation
          // error falls back to a legacy incremental feed REQ on the same 'feed-neg' subId — so flag
          // OFF (or a cold cache) is byte-identical to running the live REQ alone.
          //
          // These are the PRIMARY child's options, extracted to a named const because MirrorSet
          // (federation P2 §1.1/§1.4) reuses this shape for its reconcile-only secondary children,
          // swapping only `plan`.
          const feedIsWarm = highWaterSince(store, FIREHOSE_FEED_KINDS, 0) !== undefined;
          // T10/T16 sync-tuning inputs, all derived once per (re)connect. `cid` is the active
          // community's stable onion-host id (the watermark + snapshot keys). Every branch below is
          // flag-gated so with SYNC_TOR_TUNING/SYNC_LOW_BANDWIDTH/COMPACTION_V2 all OFF the negentropy
          // options are byte-identical to master (buckets/frameSizeLimit undefined → engine 16/0,
          // filter → buildFeedFilter, getItems over FEED_KINDS, no onReconciled).
          const cid = communityId(activeRelayUrl);
          // T10-S4: hydrate the per-community reconcile-watermark runtime mirror on (re)connect. The
          // reconcile filter reads getWatermarkRuntime(cid) SYNCHRONOUSLY, so this best-effort async
          // seed simply lets the mirror return undefined (today's window) until it lands.
          if (SYNC_TOR_TUNING && secureStorage) {
            void loadWatermark(secureStorage, cid).then(w => {
              if (w != null) setWatermarkRuntime(cid, w);
            });
          }
          // T16-S3: seed the durable feed-snapshot high-water floor on cold boot so a compaction that
          // age-expired a low-volume kind can't re-stream a huge window over Tor. Best-effort/async;
          // the reconcile filter reads snapshotFloor() live and simply sees undefined until it lands.
          if (COMPACTION_V2 && secureStorage) {
            // Per-(cid, slot) snapshot (finding #4): the observer above writes under the active
            // account's slot, so read under it too — account A's floor must not seed account B.
            void loadFeedSnapshot(secureStorage, cid, runtime.getActiveSlotId()).then(s => {
              if (s) snapshotHighWaterByCid.set(cid, s.highWater);
            });
          }
          // T10-S6: the kind universe the reconcile fingerprints. Low-bandwidth mode drops the
          // media-heavy kinds so text lands first over a metered circuit; BOTH the wire filter and
          // getItems MUST use this identical set or the two sides fingerprint different universes.
          // FIREHOSE_FEED_KINDS (not the raw FEED_KINDS) is the non-low-bandwidth arm: it already
          // resolves to FEED_KINDS with SCOPED_CHANNEL_SYNC off, and to the channel-free set with it
          // on. TEXT_ONLY_FEED_KINDS derives from the same base, so both arms stay channel-consistent
          // and the reconcile can never re-pull unscoped channel history behind the scoping's back.
          const reconcileKinds = SYNC_LOW_BANDWIDTH ? TEXT_ONLY_FEED_KINDS : FIREHOSE_FEED_KINDS;
          const snapshotFloor = (): Record<number, number> | undefined =>
            COMPACTION_V2 ? snapshotHighWaterByCid.get(cid) : undefined;
          const primaryOptions: RelayClientOptions = {
            // Native WebSocket events arrive on the old-architecture JS thread. Drain a few frames
            // per macrotask so taps/navigation can run while a first-sync backlog is being verified.
            inboundBatchSize: 4,
            inboundTimeSliceMs: 8,
            // Ingest signature verify: native BIP-340 (StiqSchnorr) when NATIVE_SCHNORR_VERIFY is
            // on, else the pure-JS verifyEvent RelayClient defaults to anyway — flag-off identical.
            verify: createEventVerifier(),
            // C6 allow-list lockstep: warn (never reject) on drift from the relay's advertised kinds.
            // A live getter — caps are negotiated per (re)connect, after this client is built.
            getAllowedKinds: () => runtime.relayCapabilities().allowedKinds,
            // Warm the blind-attribution resolver cache inside the SAME paced ingest drain, so the
            // feed build's synchronous resolveAuthor calls hit a warm cache instead of doing hundreds
            // of NIP-44 decrypts + schnorr verifies in one macrotask right after enrollment.
            onIngestEvent: warmAuthorResolution,
            plan: createFeedAndDmPlan({
              store,
              getMyPubkey: () => runtime.getPubkey(),
              getOrganizerPubkey: () => runtime.getOrganizerPubkey(),
              getAllowedKinds: () => runtime.relayCapabilities().allowedKinds,
              // Bug 8 (SCOPED_CHANNEL_SYNC): the real channel coordinates the standing `channels`
              // sub hides in its decoy cover set, and the candidate universe those decoys are drawn
              // from. Live getters — membership changes while the app runs, and the plan re-reads
              // them on every (re)connect. Both are inert with the flag off (the plan never calls
              // them), so wiring them unconditionally keeps this call site flag-free.
              getJoinedChannelIds: () => runtime.channelSyncSet(),
              getKnownChannelIds: () => runtime.knownChannelIds(),
              // T16-S3: seed the plan's since-derived subs from the durable feed snapshot floor
              // (undefined flag-off → byte-identical). The standing live feed REQ stays limit-only.
              snapshotHighWater: snapshotFloor(),
            }),
            negentropy: NEGENTROPY_SYNC && feedIsWarm
              ? {
                  subId: 'feed-neg',
                  // T10-S4: larger initiator branching + bounded outbound frames cut reconcile
                  // round-trips over Tor. Flag OFF → both undefined → engine defaults (16 buckets,
                  // 0 = unlimited frame), byte-identical to master.
                  buckets: SYNC_TOR_TUNING ? SYNC_TOR_BUCKETS : undefined,
                  frameSizeLimit: SYNC_TOR_TUNING ? SYNC_TOR_FRAME_BYTES : undefined,
                  // Reconcile window. Flag OFF (both SYNC_TOR_TUNING and SYNC_LOW_BANDWIDTH) →
                  // buildFeedFilter(store) exactly as master (the extra undefined args are defaults,
                  // and snapshotFloor() is undefined unless COMPACTION_V2). ON → a watermark-windowed
                  // (T10-S4) and/or text-only (T10-S6) reconcile filter over the SAME kind set as
                  // getItems below. fallbackFilter stays the legacy buildFeedFilter (regression firewall).
                  filter: () =>
                    SYNC_TOR_TUNING || SYNC_LOW_BANDWIDTH
                      ? buildReconcileFilter(store, {
                          watermarkSince: SYNC_TOR_TUNING ? getWatermarkRuntime(cid) : undefined,
                          windowSeconds: SYNC_ROUTINE_WINDOW_SECONDS,
                          kinds: reconcileKinds,
                          snapshotHighWater: snapshotFloor(),
                        })
                      : buildFeedFilter(store, undefined, undefined, snapshotFloor()),
                  // getItems only extracts {id, created_at} from the feed buckets. This once
                  // JSON.parsed every raw feed row on every connect/pull-to-refresh, but the store
                  // is now memory-first (sqliteStore.ts, 455fe0b): query() serves warm buckets from
                  // RAM with no SELECT/parse. The residual is a RAM gather + one sort per call —
                  // trivial at community scale and confined to spinner-covered (re)connect/refresh
                  // moments — so a dedicated id/created_at accessor isn't worth the extra store API.
                  // Uses `reconcileKinds` so the snapshot mirrors the wire filter's kind set exactly
                  // (FEED_KINDS flag-off; TEXT_ONLY_FEED_KINDS under SYNC_LOW_BANDWIDTH).
                  getItems: filter => {
                    let events = store.query({kinds: reconcileKinds});
                    if (filter.since !== undefined) {
                      events = events.filter(e => e.created_at >= filter.since!);
                    }
                    if (filter.until !== undefined) {
                      events = events.filter(e => e.created_at <= filter.until!);
                    }
                    if (filter.limit !== undefined) {
                      events = events.slice(0, Math.max(0, Math.trunc(filter.limit)));
                    }
                    return events.map(e => ({id: e.id, timestamp: e.created_at}));
                  },
                  fallbackFilter: () => buildFeedFilter(store),
                  // T10-S4: record the round for the local sync-diagnostics ring, and (only on a
                  // completed round — never a fallback) advance the per-community watermark so the
                  // next routine refresh reconciles just the recent window. Gated on SYNC_TOR_TUNING
                  // so flag-off attaches NO observer (byte-identical to master's no-onReconciled).
                  onReconciled: SYNC_TOR_TUNING
                    ? stats => {
                        recordSyncStat(stats);
                        if (!stats.fellBack && secureStorage) {
                          const through = Math.floor(Date.now() / 1000);
                          setWatermarkRuntime(cid, through);
                          void saveWatermark(secureStorage, cid, through);
                        }
                      }
                    : undefined,
                }
              : undefined,
          };
          relay = new MirrorSet(socket, store, {
            primaryOptions,
            // Best-effort label for the PRIMARY child's own URL: the constructor only gets an
            // already-open socket (no URL on it), so without this hint MirrorSet can't compare the
            // primary against `pinnedPrimaryUrl` or name it in onWithholding. Wiring it enables both.
            primaryUrl: activeRelayUrl,
            // TODO(pin-ui): wire from a user "preferred relay" setting once one exists; there is no
            // such Settings surface yet, so leave it undefined (the primary is then never treated as
            // pinned — still eligible for withholding-triggered promotion).
            pinnedPrimaryUrl: undefined,
            createSocket: url => createTorRelaySocket(manager, url),
            // Additive-only mirror set (communityStore effectiveMirrors, §1.2), primary excluded —
            // [] before any community resolves, so a single-mirror build stays byte-identical to
            // today (MirrorSet with zero secondaries).
            secondaryMirrors: runtime.activeSecondaryMirrors(activeRelayUrl),
            // Secondaries run reconcile-only (§1.4/§1.7): no live feed/DM REQ, just the tiny
            // organizer-config sub so a fresher roster/policy/mirror-list reaches the store even
            // from a mirror the primary never streams it from.
            secondaryPlan: () => {
              const op = runtime.getOrganizerPubkey();
              return op
                ? [{subId: 'org-config', filter: {kinds: [KIND_TAG_POLICY], authors: [op], limit: 30}}]
                : [];
            },
            // A secondary is only attempted once its onion-auth (if any) is loadable: public onions
            // always are; an auth-gated mirror needs the Tor daemon actually started with its key
            // (native writer + resolveOnionAuthExtra above) before a connect attempt can succeed.
            mirrorAuthLoadable: spec => {
              const a = deriveOnionAuth(spec.url, spec.onionAuthKey ?? undefined);
              return a === null ? true : manager.isOnionAuthActive(a);
            },
            // Known-good capture (MF-1): a mirror this device has SEEN serve honest community content
            // (promoted, or delivered a confirmed recent withholding-delta) is upserted into the
            // active community's un-evictable `mirrorsKnownGood` tier, so a later org `stiq:mirrors`
            // de-list can never retract a mirror that already defeated a withholding primary.
            onMirrorObservedGood: spec => runtime.recordKnownGoodMirror(spec),
          });
          relayRef.current = relay;
          // Initial-sync window opens now: widen the runtime's deferred-emit throttle until the
          // backlog EOSEs (onSynced below clears it; a 60s cap inside the runtime backstops any
          // missed clear), so burst ingest + 4 Hz full feed rebuilds don't stack on the JS thread.
          runtime.setRelaySyncing(true);
          // T10-S6 (ship-dark behind SYNC_LOW_BANDWIDTH): pull the organizer's most recent
          // announcements AHEAD of the general reconcile so the highest-value content lands first over
          // a metered circuit. Pure orchestration over the relay's existing chunked fetchByFilter —
          // no-ops for absent targets and never throws. (App.tsx holds no active-space handle here, so
          // the pinned-message target is supplied by the per-space open path, not this connect hook.)
          // Flag OFF → never called, so this is inert.
          if (SYNC_LOW_BANDWIDTH) {
            prefetchPriorityContent(relay, {organizerPubkey: runtime.getOrganizerPubkey()});
          }
          // A live onion circuit is proven by EITHER a delivered EVENT or an EOSE. EOSE means the
          // relay accepted our subscription and finished its (possibly EMPTY) backlog — which is a
          // perfectly healthy connection. Without counting EOSE, a relay that simply has no NEW
          // events since our cache high-water mark delivers only EOSE, leaves receivedData false,
          // and the watchdog kills a working connection — churning the cascade forever on a
          // network where the onion is actually reachable. (The watchdog still fires for a WS that
          // opens but carries NO frame at all — a genuinely half-broken rendezvous circuit.)
          const markRelayAlive = (): void => {
            receivedData = true;
            relayFailureStreak = 0;
            if (dataWatchdog !== undefined) {
              clearTimeout(dataWatchdog);
              dataWatchdog = undefined;
            }
          };
          relay.onSynced(() => {
            markRelayAlive();
            setRelayEverSynced(true); // gates the reliability nudge; no-op re-render after the first
            runtime.setRelaySyncing(false); // backlog drained — restore the normal emit throttle
            // T4-S4: emit cold/resume-to-usable timing on the FIRST onSynced after each (re)connect.
            // Gated on the T4_METRIC config flag (committed default OFF) rather than __DEV__ — the
            // bundleInDebug=true debug APK bundles with --dev false, so __DEV__ is false on device.
            if (T4_METRIC && t4MetricRef.current.pending) {
              t4MetricRef.current.pending = false;
              // eslint-disable-next-line no-console
              console.log(
                `[T4-METRIC] usable dt=${Date.now() - t4MetricRef.current.start} path=${t4MetricRef.current.path} flag=${TOR_DORMANCY}`,
              );
            }
            // Proactive blind-token draws open another Tor socket and do crypto work. Keep that
            // useful background task out of the initial relay history burst; on-demand draws still
            // run immediately if the user posts before sync finishes.
            maybeDrawTokens();
            // Content sealing (censorable reads, #4 — ships dark): provision the current content
            // epoch's key so new posts seal on write. Inert unless the relay advertises content
            // encryption AND the organizer announced an epoch; guarded + idempotent inside. Uses its
            // own fresh Tor socket bound to the active relay, same isolation as the token draw.
            if (activeRelayUrl) {
              const relayUrl = activeRelayUrl;
              void runtime
                .ensureWriteEpoch(() => createTorRelaySocket(manager, relayUrl))
                .catch(() => {});
              // Tokens-everywhere: stock the AUXILIARY token wallets (space-write, media-write) in
              // one background sweep, so channel/group/DM writes and media attaches never block on a
              // draw. A no-op for any domain the relay doesn't require — inert with today's caps.
              void runtime
                .stockAuxiliaryWallets(() => createTorRelaySocket(manager, relayUrl))
                .catch(() => {});
            }
            // T1: TTL push-registration heartbeat (debounced ~hourly inside). Flag-gated → inert off.
            if (PUSH_UNIFIEDPUSH) {
              pushHeartbeat();
            }
          });
          // EVERY received event (incl. a duplicate echo of our own optimistic write) proves the
          // circuit is alive AND confirms delivery. Keyed off onSeen, NOT onEvent: our own post is
          // already in the store, so the relay's echo dedupes and never reaches onEvent — which is
          // exactly why the send indicator used to hang at "accepted" forever.
          relay.onSeen(ev => {
            markRelayAlive();
            runtime.markEchoed(ev.id);
          });
          relay.onEvent(ev => {
            runtime.handleIncomingEvent(ev);
            // Fan out to the media-blob service's arrival listeners (see setMediaBlobService above).
            // onEvent — not onSeen — is the right hook: it fires for NEWLY STORED events, which is
            // exactly when a fetched blob has become readable via getById. A listener exists only
            // while a chip actually has a fetch in flight, so on the ingest hot path this is an
            // empty-Set iteration.
            for (const listener of blobEventListeners) {
              listener(ev);
            }
          });
          // C2/C3 consumers: surface a relay CLOSED reason (auth-required/restricted → the user may
          // need to re-auth/re-join) and route every NOTICE into diagnostics. Registered on this
          // RelayClient instance; both are released when the relay is closed + nulled below (offline/
          // disconnected handler and the effect cleanup), exactly like onSynced/onSeen/onEvent.
          relay.onSubError(err => runtime.handleSubError(err));
          relay.onNotice(msg => runtime.handleNotice(msg));
          // Phase 5 stale-first: a scoped sub's EOSE means that channel/group's stored history has
          // fully replayed — from then on an empty local list is GENUINELY empty, and the space's
          // "No broadcasts/messages yet." empty state may show (see AppRuntime.markScopedSubSynced).
          relay.onScopedEose(subId => runtime.markScopedSubSynced(subId));
          // Scoped group/channel subs must be (re)opened AFTER the socket opens and the plan's
          // sendSubscribe() has reset the sub registry — never from onRelayConnected below, which
          // runs right now, pre-open, and whose scoped subs the reset would silently wipe.
          relay.onSubscribed(() => runtime.onRelaySubscribed());
          // Retry the enrollment bind AND any posts that failed to send while offline, so a
          // post made before the relay was up still gets published once it connects.
          void runtime.onRelayConnected();
          // Top up the blind-posting token wallet if this community is blind and it's low. Runs on
          // the first connect after enrollment (empty wallet) and whenever the wallet runs down.
          // Fresh connect ⇒ fresh background-retry budget for the top-up.
          proactiveRetries = 0;
          clearProactiveTimer();
        } catch {
          // Native socket module not linked (non-Android build) — stays offline.
        }
      };

      // ── Dormancy enter/exit (T4, TOR_DORMANCY on by default) ────────────────────────────────────
      // enter(): idle the daemon DORMANT and close the relay so nothing churns over it — but keep the
      // daemon ALIVE (no manager.disconnect(), no stopService). suppressReconnect blocks the relay
      // socket's own onRelayDown auto-retry the way a community switch does, so the close() below
      // can't schedule a reconnect while we mean to stay dormant. It publishes the live daemon via
      // setDormantDaemon() so a WorkManager sync can ADOPT it instead of cold-starting a second one.
      // FALLBACK: when there's no live daemon to idle, or no native module to signal through, it
      // routes to teardownTor() instead. A live daemon whose best-effort DORMANT signal may not have
      // landed is deliberately KEPT WARM (not torn down) — a genuine death is caught by the
      // control-socket monitor / the isLive() check on resume, not by pre-emptively killing it.
      // The actual dormancy-enter transition — split out so the ownership guard below can defer it
      // (via runYieldingToBackgroundSync) without duplicating the body.
      const doEnter = (): void => {
        // No live daemon to keep dormant → force-kill teardown (the WorkManager wake reconnects).
        if (!manager.isLive()) {
          teardownTor();
          return;
        }
        // torDormant() returns false only when the native module/method is absent (non-Android / an
        // older build) — i.e. there's no way to idle this daemon, so teardown. It reports dispatch,
        // not delivery: a present-but-unlanded signal still returns true and we keep the warm daemon.
        if (!torDormant()) {
          teardownTor();
          return;
        }
        dormant = true;
        setDormantDaemon(manager); // let a background sync adopt this live-but-dormant daemon
        runtime.setRelaySyncing(false); // relay is closing — never park on the widened throttle
        suppressReconnect = true;
        try { relay?.close(); } catch { /* ignore */ }
        relay = null;
        relayRef.current = null;
        activeSocket = null;
        clearProactiveTimer();
        // A backoff retry scheduled BEFORE we went dormant must not fire while we ARE dormant. This is
        // reachable, not theoretical: the backoff reaches 32-60s at a streak of 4+, which comfortably
        // outlives the 30s background grace period that precedes this call, so the pending timer really
        // does straddle the transition. Unlike the legacy teardown path (which disconnect()s, so
        // startRelay()'s isLive() guard stops the dial by itself), dormancy keeps the daemon live and
        // the dial would go straight through. Nothing is lost by dropping it: exit() →
        // resumeFromDormant() calls startRelay() again, which re-consults the same (deliberately
        // untouched) nextRelayAttemptAt floor and re-schedules whatever wait is left.
        if (relayRetryTimer !== undefined) {
          clearTimeout(relayRetryTimer);
          relayRetryTimer = undefined;
        }
      };

      // TS-3: enter() fires ~30s after backgrounding (the grace timer above), by which point a
      // WorkManager background sync can already be mid-flight on the SAME shared daemon (it woke
      // during that grace window). Signalling DORMANT + closing the relay out from under it would
      // stomp a live background sync exactly like a foreground resume racing it would — so run
      // through the same yield-and-wait coordination as resumeFromDormant()/exit() below instead of
      // calling doEnter() unconditionally. `isStillValid` re-checks AppState after the (bounded) wait
      // because the app may have resumed to the foreground — running exit() — while this was
      // pending; doEnter() must not re-enter dormancy on top of that.
      const enter = (): void => {
        runYieldingToBackgroundSync(doEnter, {
          isStillValid: () => AppState.currentState === 'background',
        });
      };

      // Bring the foreground relay/circuit back after dormancy, coordinating with any in-flight
      // background sync exactly as the legacy resume path does so the two never write the shared
      // cache file at once (the sync adopts the SAME daemon, but a second relay socket on the same
      // per-account DB is still the contention the abort/wait handshake prevents). `bounce` forces
      // one relay reconnect for a network change we ignored while dormant.
      const resumeFromDormant = (bounce: boolean): void => {
        const doResume = (): void => {
          if (manager.isLive()) {
            // Daemon rode through dormancy alive: bring the relay back (enter() closed it). A network
            // change forces the reconnect path (fresh circuit); an already-open relay is only bounced.
            if (relay === null) {
              if (bounce) forceRelayReconnectRef.current?.(activeRelayUrl);
              else startRelay();
            } else if (bounce) {
              forceRelayReconnectRef.current?.(activeRelayUrl);
            } else {
              // Nothing on this branch reconnects, so nothing re-issues the standing feed REQ — and a
              // relay can silently drop a REQ without closing the socket, which then sits invisible
              // until the next reconnect (dead feed, "Connected" chip, the reader pulls to refresh).
              // The legacy resume does the lightweight resync backstop for exactly this case — but it
              // lives in the AppState 'active' handler's `if (TOR_DORMANCY) … else` arm, and
              // TOR_DORMANCY ships ON, so in every shipped build that call is unreachable and the
              // still-live resume had no content-freshness step at all. Restore parity here.
              // resyncFeed coalesces onto an in-flight round and is watchdogged, so a burst of focus
              // returns can neither pile up rounds nor hang.
              void runtime.refreshFeed();
              // G4/foreground hook: dormancy never actually entered (a quick background→foreground
              // inside the grace window) — the relay stayed live and NOTHING here reconnects, so
              // startRelay()'s post-connect token top-up (maybeDrawTokens/stockAuxiliaryWallets) never
              // reruns. foregroundLowWaterRefill is the runtime-side equivalent (deps.drawTokensNow +
              // deps.connectForDraw are already wired), internally gated/single-flighted at the host —
              // a free no-op on an already-warm wallet, never a foreground wait.
              void runtime.foregroundLowWaterRefill();
            }
          } else {
            // Daemon died while backgrounded (OEM kill): full cold reconnect cascade.
            void runCascade();
          }
        };
        // A WorkManager sync currently owning the shared daemon gets asked to abort at its next
        // checkpoint and we wait (bounded) for it to release before driving the relay ourselves.
        // isStillValid guards the case where dormancy was re-entered while we were waiting — abandon
        // this resume rather than fight the fresh enter().
        runYieldingToBackgroundSync(doResume, {isStillValid: () => !dormant});
      };

      // exit(): wake the daemon ACTIVE (BEFORE any liveness check), drop the adoptable handle so the
      // background sync stops trying to adopt it, then resume the relay via resumeFromDormant().
      const exit = (): void => {
        // Only signal ACTIVE if we actually signalled DORMANT. AppState fires 'active' for every
        // focus return — a dialog, the notification shade, an app switch — and most of those never
        // entered dormancy (enter() runs after the background grace period). Signalling a daemon
        // that was never dormant is a pointless control-port round trip that muddies the logs at the
        // exact moment we are trying to read them. The rest of the resume still runs unconditionally:
        // it is also what recovers an OS-killed daemon, which can happen in ANY background window,
        // dormant or not.
        const wasDormant = dormant;
        dormant = false;
        setDormantDaemon(null); // foreground is reclaiming Tor — no longer adoptable by a sync
        if (wasDormant) {
          torActive(); // native SIGNAL ACTIVE
        }
        suppressReconnect = false;
        // Decide whether to force a relay bounce. Two independent reasons:
        //  (1) networkChangedWhileDormant — a Wi-Fi↔cellular switch we deliberately ignored while
        //      dormant; the socket is on the wrong network. (unchanged)
        //  (2) !wasDormant AND a long suspension — the iOS belt-and-braces. iOS suspends the process
        //      seconds into backgrounding, freezing the 30s grace timer so enter() NEVER RAN (hence
        //      !wasDormant). A >60s suspension can silently kill the relay WS, and because
        //      NWPathMonitor was frozen too there is no StiqTorNetworkChange to bounce it — doResume
        //      would then see the stale-cached isLive()===true + a non-null relay and do nothing,
        //      leaving a dead feed until the 90s RELAY_DATA_TIMEOUT_MS watchdog fires. One forced
        //      bounce beats waiting that out. The OS image/document/camera picker also backgrounds the
        //      app, but those windows are <60s (see the LOCK_ON_BACKGROUND note above) so this never
        //      fires for a photo pick. (doResume already applies `bounce` to both the relay===null and
        //      relay!==null cases, so nothing downstream needs to change.)
        const backgroundedAt = backgroundedAtRef.current;
        const suspendedMs = backgroundedAt === null ? 0 : Date.now() - backgroundedAt;
        const bounce =
          networkChangedWhileDormant ||
          (!wasDormant && suspendedMs > RESUME_STALE_SOCKET_MS);
        networkChangedWhileDormant = false;
        resumeFromDormant(bounce);
      };
      torDormancyRef.current = {enter, exit};

      // Live bootstrap percentage from the daemon (real PROGRESS=/SUMMARY= lines). Drives the
      // onboarding connect step's truthful progress bar. Long-lived: one subscription for the
      // app's life, independent of individual connect attempts. The raw stream is a burst of lines;
      // coalesce it (trailing-edge, force-flush on first line + 100%) so it doesn't re-render the
      // whole App→AppShell tree on every tick during the connect window (#6 transient jank).
      const bootstrapCoalescer = createBootstrapCoalescer<BootstrapProgress>(p => {
        setTorBootstrap(p);
        // T2: fold the live percent into the guided plain-language phase when a rung is in flight.
        // Guarded on the flag so torPhase is never touched (stays null) when GUIDED_AUTO_LADDER off.
        if (GUIDED_AUTO_LADDER && currentRung) {
          setTorPhase(describePhase(currentRung, 'bootstrapping', p.percent));
        }
      });
      const unsubscribeBootstrap = manager.onBootstrap(p => bootstrapCoalescer.push(p));
      cleanups.push(unsubscribeBootstrap);
      cleanups.push(() => bootstrapCoalescer.dispose());

      const unsubscribeTor = manager.onChange(state => {
        // T-G1c: every Tor transport state transition, permanent + cheap — `adb logcat | grep perf`
        // reconstructs the circuit's health alongside the write-timeline/draw/unlock lines above.
        log.info('perf:tor', `manager state=${state} relayLive=${relay !== null}`);
        setConnection(state);

        // Step 5: when Tor finishes bootstrapping, open the relay WebSocket through it.
        if (state === 'connected' && relay === null) {
          // Reset the relay backoff FIRST. This was the only one of the four startRelay() callers
          // that did not (cf. the resets at the mirror-switch, community-switch and unlock sites),
          // and the omission silently re-staled the app after every Tor recovery: startRelay()'s
          // own floor check is `if (relayFailureStreak > 0) { …wait nextRelayAttemptAt… }`, so a
          // fresh Tor connect inherited a backoff earned by relay dials that failed during the
          // outage which just ended — up to RELAY_BACKOFF_MAX_MS (60s).
          //
          // MEASURED on device 2026-07-27: Tor reconnected and reported `connected`, and the relay
          // was then not dialled for ~90s. Tor is up, the feed is stale, and nothing is retrying —
          // exactly the "I have to pull to refresh" symptom.
          //
          // A successful Tor (re)connect is newer, independent proof the transport is healthy than
          // anything the last relay failure saw, so the old streak is stale evidence. Zeroing the
          // streak alone is sufficient — the stale `nextRelayAttemptAt` is unreachable once the
          // `streak > 0` guard is false. See reconnectBackoff.ts's relayBackoffMs RESET CONTRACT.
          relayFailureStreak = 0;
          startRelay();
        }
        // Stamp when THIS transport became usable, so the escalation gate can require a real
        // window of failure rather than a burst of fast ones (see transportSettledMs below).
        if (state === 'connected') {
          if (transportConnectedAt === 0) {
            transportConnectedAt = Date.now();
          }
        } else {
          transportConnectedAt = 0;
        }

        // Clear the bootstrap bar when there's no live attempt to report on, so the connect
        // screen resets to zero rather than freezing on the last percent of a dead attempt.
        if (state === 'disconnected' || state === 'offline') {
          bootstrapCoalescer.reset(); // drop any pending flush so a stale % can't flash back post-clear
          setTorBootstrap(null);
          // T2: mirror the reset for the guided phase. Guarded so flag-off never touches torPhase.
          if (GUIDED_AUTO_LADDER) {
            currentRung = null;
            setTorPhase(null);
          }
        }

        if (state === 'offline' || state === 'disconnected') {
          relay?.close();
          relay = null;
          relayRef.current = null;
          // Iron-clad foreground: the moment Tor drops, reconnect. A tiny delay (not 0)
          // avoids a hot loop if a connect fails instantly, and lets the single-flight
          // runCascade collapse duplicate triggers. WebTunnel bridges rotate, so drop the
          // in-memory set first so the next cascade re-fetches fresh ones. Covers 'disconnected'
          // too: disconnect() only flips state after backend.stop() resolves (near-instant under
          // Arti, but not synchronous), so a background-teardown stop can finally resolve to
          // 'disconnected' slightly after the fact, and nothing else reschedules a connect from
          // that state. Safe against a DELIBERATE background teardown because that
          // path sets desiredConnected = false before ever calling manager.disconnect().
          // T4: `!dormant` pauses the auto-reconnect while we deliberately idle Tor in the
          // background. Always true (no-op) when TOR_DORMANCY is off — dormant never flips there.
          if ((state === 'offline' || state === 'disconnected') && desiredConnected && !dormant) {
            freshBridgesRef.current = [];
            scheduleRetry(1_500);
          }
        }
      });

      // Deferred reachability verdict (native background probe — the blocking 6-16s pre-connected
      // probe this replaced). ok=true confirms the connected rung really carries streams: commit
      // the deferred warm-cache write. ok=false means bootstrap lied off a cached consensus: the
      // manager is already stopping the daemon and about to flip 'offline' (which schedules the
      // next walk via the onChange handler above); all this handler owns is the ladder memory —
      // condemn the rung for the session and drop poisoned warm entries so neither this walk nor
      // the next LAUNCH re-picks it off storage. A rare wrong condemnation (e.g. a PoW-stalled
      // probe timing out while the relay WS was actually fine) costs one re-walk; the exhaustion
      // reset in connectGuided guarantees it can never strand the app with zero rungs.
      const unsubscribeReach = manager.onReach((ok, transport, message) => {
        if (ok) {
          const save = pendingWarmSave;
          pendingWarmSave = null;
          if (save) {
            void save();
          }
          return;
        }
        pendingWarmSave = null;
        log.info('perf:tor', `transport-dead ${transport ?? '?'}: ${message ?? ''}`);
        if (transport) {
          deadRungs.add(transport);
          if (transport === 'direct') {
            // Mirror the relay-condemnation ratchet: direct proved unusable here this session.
            bridgeStartTier = Math.max(bridgeStartTier, 0);
          }
        }
        if (secureStorage) {
          const storage = secureStorage;
          void (async () => {
            const netClass = await getNetworkClass();
            await clearCachedBridgesForClass(storage, netClass);
            const cached = await loadCachedBridges(storage);
            if (cached && transport && cached.transport === transport) {
              await clearCachedBridges(storage);
            }
          })();
        }
      });
      cleanups.push(unsubscribeReach);

      // Non-urgent (throttled relay-churn) snapshots are coalesced to the LATEST value and applied
      // via InteractionManager.runAfterInteractions rather than setSnapshot()'d inline: setSnapshot
      // here forces a full re-render of the entire tree (this is still App's single full-snapshot
      // subscriber — see useRuntimeSlice.ts's adoption note), and `startTransition` cannot make that
      // render lower-priority in THIS app: useSyncExternalStore's own change-detection re-render
      // hardcodes SyncLane regardless of transition context, and separately this app has no
      // concurrent React root at all (renderApplication.js only turns concurrent rendering on for
      // Fabric; android/gradle.properties has newArchEnabled=false) — see useRuntimeSlice.ts's module
      // doc for the full verification. InteractionManager.runAfterInteractions is this codebase's
      // existing, load-bearing way of moving JS-thread-heavy work off an in-flight gesture/animation
      // (maybeDrawTokens/startColdCascade above, MainScreen's threadNodes/notifItems passes), reused
      // here rather than inventing a second mechanism. Urgent snapshots (the user's own post/vote/
      // lock/nav) bypass all of this and apply synchronously, exactly as before.
      // The coalescing slot itself lives at component scope (nonUrgentFlush, near the `snapshot`
      // state) so direct setSnapshot() callers outside this effect can supersede a queued flush —
      // see deferredSnapshotSlot.ts for the stale-overwrite bug that forced it out of this closure.
      const unsubscribeRuntime = runtime.subscribe((s, urgent) => {
        if (urgent) {
          // A fresher urgent snapshot always supersedes whatever a still-pending background flush
          // queued — letting the stale one apply afterwards would visibly regress state the user
          // just saw back to an older snapshot. cancel() retires the handle too (not just the
          // value), so a burst of urgent emits can't strand a phantom "already queued" flush.
          cancelPendingSnapshotFlush();
          setSnapshot(s);
        } else {
          nonUrgentFlush.defer(s);
        }
        // T1: mirror the member's joined-group ids for the (dark) push registration payload. Gated
        // on the flag so the flag-off callback is byte-identical to passing `setSnapshot` alone. Runs
        // off every emit regardless of urgency — it only refreshes a plain captured variable (never
        // triggers a render on its own), so it carries none of the render cost the deferral above
        // exists to avoid.
        if (PUSH_UNIFIEDPUSH) {
          pushGroupIds = s.groups.map(g => g.id);
        }
      });

      cleanups.push(() => {
        clearProactiveTimer();
        relay?.close();
        relay = null;
        relayRef.current = null;
        unsubscribeTor();
        unsubscribeRuntime();
        // Cancel any queued non-urgent flush rather than relying on `disposed` to make it a no-op —
        // the slot now outlives this effect (it's a component-scope ref), so leaving a live handle
        // behind would strand a callback holding a disposed runtime's snapshot. Same unsubscribe-
        // time guard useRuntimeSlice.ts's subscribe wrapper applies.
        cancelPendingSnapshotFlush();
        runtime.dispose();
        runtimeRef.current = null;
      });

      // Fire the notification-permission request WITHOUT awaiting it. On Android 13+ the OS
      // POST_NOTIFICATIONS dialog would otherwise block here until the user answers, stalling
      // runtime.init() (and the whole first paint) behind a modal on first launch. Nothing below has a
      // true dependency on the grant — notifee.createChannel works regardless, and the Tor
      // foreground-service notification simply appears once/if it's granted — so kick it off in
      // parallel and press on. (The disposed check still catches an unmount during the awaits above.)
      void requestNotificationPermission();

      if (disposed) {
        return;
      }

      // Register local notification delivery backend (@notifee/react-native) when available.
      if (notifee) {
        void notifee.createChannel({id: 'dm', name: 'Direct Messages'});
        void notifee.createChannel({id: 'channel', name: 'Channel Broadcasts'});
        void notifee.createChannel({id: 'comment', name: 'Comment Replies'});
        // Event reminders (events/reminders.ts lazily ensures this too — created here so the
        // channel exists in system settings before the first reminder is ever scheduled).
        void notifee.createChannel({id: 'event-reminder', name: 'Event Reminders'});
        // Titles are title-only (product lock — never body/npub/event content). The tap target
        // is embedded as a flat string-map data payload (encodeNavTarget) so a later tap can
        // route back to the right screen without the payload ever carrying message content.
        setNotificationProvider(async (title, channelId, target) => {
          await notifee.displayNotification({
            title,
            android: {channelId, pressAction: {id: 'default'}},
            data: encodeNavTarget(target),
          });
        });

        // Foreground/background taps: notifee delivers the press event with the same data
        // payload we embedded above. Decode it back into a NavTarget and hand it to MainScreen via
        // the pendingNav prop; navigateToNotification there reuses the existing DM/channel/post
        // open primitives.
        const handleNotifeePress = ({type, detail}: {type: number; detail?: {notification?: {data?: unknown}}}): void => {
          if (NotifeeEventType && type === NotifeeEventType.PRESS) {
            const t = decodeNavTarget(detail?.notification?.data);
            if (t) setPendingNav(t);
          }
        };
        cleanups.push(notifee.onForegroundEvent(handleNotifeePress));
        notifee.onBackgroundEvent(async (event: {type: number; detail?: {notification?: {data?: unknown}}}) => {
          handleNotifeePress(event);
        });

        // Cold start: the app was killed and relaunched by tapping a notification. Queue the
        // decoded target the same way as a cold-start deep link — it is replayed once runtime
        // hydration genuinely completes (see attemptInit()'s finally handler below), never before.
        void notifee.getInitialNotification?.().then((init: {notification?: {data?: unknown}} | null) => {
          const t = decodeNavTarget(init?.notification?.data);
          if (t) pendingColdNav = t;
        });
      }

      // Tor's cold start is deliberately GATED ON HYDRATION — see startColdCascade below. It used to
      // fire here, before runtime.init(), and that was the single biggest cold-start bug in the app.
      // init() sets the real enrolled state (keystore read) and emits before it resolves; flip
      // `hydrated` once it settles so the splash hands off straight to the correct screen. A failed
      // init still flips `hydrated` (so the UI leaves the splash), and the failure is recorded in the
      // local in-memory ring buffer (never the network) so it's visible in on-device diagnostics.
      //
      // Races init() against INIT_TIMEOUT_MS: none of init()'s internal awaits (SQLCipher open,
      // keystore reads, per-community DB migrate) carry their own timeout, so a corrupt/locked
      // per-community DB can hang forever and pin the splash with no way out. Past the deadline we
      // hand off to the dedicated recovery screen instead — never the normal feed/lock. The
      // `attempt` counter guards against cross-talk between an old hung call and a newer Retry
      // attempt: isCurrentInitAttempt() (pure, unit-tested in initAttempt.test.ts) gates EVERY side
      // effect of both the timeout and the init().finally() below, so a stale/late settlement of an
      // abandoned attempt (e.g. the ORIGINAL hung init() finally resolving after a Retry already
      // started a new one) is a no-op instead of double-applying (double deep-link replay, double
      // hydrate/timeout flips) on top of the current attempt — the reentrancy hazard this guards
      // against. `retryInitRef` lets the recovery screen re-run this same race; if the original
      // init() later finishes on its own (just slow, not stuck), this same completion handler
      // self-heals back to the normal UI.
      //
      // Note: AppRuntime.init() itself is ALSO reentrancy-safe (in-flight calls dedupe onto the same
      // promise) — so if this Retry's runtime.init() call lands while the original is still pending,
      // both attempts settle off the SAME underlying run, and only the current one's handler below
      // acts on it.
      // Start the cold Tor cascade exactly once, and NOT before runtime.init() has hydrated.
      //
      // THE BUG THIS FIXES (device-proven 2026-07-15 under the since-deleted C-tor engine, logcat +
      // torrc): Tor read client auth only at startup, from the ClientOnionAuthDir named in its
      // torrc. That line was written only when manager.connect() could resolve a credential — and
      // resolveOnionAuth() reads getActiveOnionAuth(), an IN-MEMORY value that only exists after
      // init() hydrates the active community (AppRuntime → setActiveOnionAuth). Starting the cascade
      // before init() therefore wrote a torrc with NO ClientOnionAuthDir at all, so the daemon had no
      // key for the members-only onion and every dial failed `0xF4 MISSING client authorization` — a
      // fatal error no retry could fix.
      //
      // The app only ever recovered by ACCIDENT: four failures tripped the transport escalation, which
      // restarts Tor — and by then the credential had hydrated, so the new torrc carried it. The ladder
      // walk to obfs4/snowflake was never about censorship; it was an expensive way to restart the
      // daemon. That is the whole "4m16s to usable when direct Tor was up in 4.3s".
      //
      // STILL TRUE UNDER ARTI, different mechanism: onion_auth::install_into_keymgr
      // (arti-ffi/src/onion_auth.rs) installs the credential into Arti's persistent KeyMgr keystore
      // fresh on every arti_start() — i.e. every manager.connect() call builds a new TorClient and
      // re-installs whatever resolveOnionAuth() resolves to AT THAT MOMENT. A connect attempted
      // before init() hydrates still installs no credential (or a stale one) into the keystore for
      // that attempt, and the auth-gated descriptor fetch still fails the same way. The sequencing
      // fix below is therefore still required — only the "torrc line" in the paragraph above is
      // history; the ordering hazard it describes is not.
      //
      // Waiting costs the init() duration (a keystore read + SQLCipher open, ~sub-second) and buys a
      // first dial that can actually succeed. The timeout path still starts Tor, so a hung init()
      // degrades to today's behaviour instead of never connecting. Un-enrolled first launch is
      // unaffected: no community means no credential to wait for, and onboarding drives its own
      // restart once a join code supplies one (see isOnionAuthActive above).
      let coldCascadeStarted = false;
      const startColdCascade = (): void => {
        if (coldCascadeStarted || disposed) {
          return;
        }
        // coldCascadeStarted flips synchronously so a second caller (the timeout path racing the
        // init().finally() path, or vice versa) can never double-schedule — only the deferred call
        // below is new here.
        coldCascadeStarted = true;
        // Audit finding #4: on a fresh install the native Tor daemon's first-ever consensus
        // fetch/parse otherwise runs concurrently with Hermes bundle load + the app's very first
        // frames. Deferring past first paint/interactions is a small additive delay (Tor's own
        // bootstrap dwarfs it) that removes that CPU contention window. `disposed` is rechecked
        // inside the callback since unmount can race the deferral.
        InteractionManager.runAfterInteractions(() => {
          if (disposed) return;
          void runCascade();
        });
      };

      const attemptInit = (): void => {
        const attempt = ++initAttempt;
        // Captured locally (not just the shared `currentInitTimer`) so THIS attempt's finally handler
        // below clears only ITS OWN timer — never a newer attempt's still-pending one. `currentInitTimer`
        // is still updated for the effect's unmount cleanup, which always wants the latest attempt's timer.
        const myTimer = setTimeout(() => {
          if (!isCurrentInitAttempt(attempt, initAttempt, disposed)) return;
          setInitTimedOut(true);
          setHydrated(true);
          // init() is stuck, so the onion-auth credential may never arrive. Start Tor anyway rather
          // than wait forever: without a credential this is exactly today's behaviour, and the
          // recovery screen still needs a network path for a Retry to get anywhere.
          startColdCascade();
        }, INIT_TIMEOUT_MS);
        currentInitTimer = myTimer;

        void runtime
          .init()
          .catch(e => log.error('init', e))
          .finally(() => {
            clearTimeout(myTimer);
            if (!isCurrentInitAttempt(attempt, initAttempt, disposed)) return;
            // The runtime is genuinely ready now — replay any deep link that arrived while it
            // wasn't (bug 2; see deliverDeepLink above).
            initComplete = true;
            // Hydration done ⇒ getActiveOnionAuth() now returns the active community's reach
            // credential, so the daemon's very first arti_start() installs it into Arti's KeyMgr
            // keystore (onion_auth::install_into_keymgr) before ever dialing. This is the call that
            // must not happen any earlier (see startColdCascade).
            startColdCascade();
            // Early-start handoff: when the early kick already connected Tor, the 'connected'
            // transition happened before hydration and nothing else will call startRelay() now.
            // Its own guards (initComplete, reach handoff) make this idempotent and ordered.
            if (manager.isLive() && relay === null) {
              relayFailureStreak = 0;
              startRelay();
            }
            if (pendingDeepLink) {
              const url = pendingDeepLink;
              pendingDeepLink = null;
              handleDeepLink(url);
            }
            if (pendingColdNav) {
              const t = pendingColdNav;
              pendingColdNav = null;
              setPendingNav(t);
            }
            setInitTimedOut(false);
            setHydrated(true);
            // The reliability nudge (contract C3) used to fire here, gated on
            // runtime.getSnapshot().enrolled. It now lives in an effect on the enrolled transition
            // (see reliabilityNudgedRef above) so that enrolling during THIS session nudges too,
            // instead of only on a later launch.
          });
      };
      // ── EARLY TOR START ─────────────────────────────────────────────────────────────────────────
      // MEASURED 2026-07-28 (S23, vc12): "Running stiq" → arti_start was a flat 5.4-5.5s on every
      // launch — runtime.init() (SQLCipher open, keystore reads, migrations) serialized ahead of a
      // bootstrap that needs NONE of it. Bootstrap requires no reach credential (Arti consults its
      // keystore at descriptor-fetch time), so the cascade now starts as soon as the user's
      // connection prefs are readable; the credential lands on the LIVE daemon via startRelay()'s
      // reach handoff once init() hydrates. The ordering disaster startColdCascade's comment
      // documents (the 4m16s "connect before hydration = no credential" bug) was about the
      // CREDENTIAL, not the bootstrap — and the relay dial still waits for hydration
      // (startRelay's initComplete guard), so that hazard stays closed.
      //
      // The prefs load is the one thing that must precede the walk: getTorConnectionPrefs() is a
      // sync mirror hydrated during init(), and defaulting it early would dial DIRECT for a user
      // who explicitly chose bridges — a network-visible choice they made for a reason. One
      // storage read closes that hole; init()'s own later load of the same key is idempotent.
      // runAfterInteractions keeps audit finding #4's spirit: clear of the very first frames.
      InteractionManager.runAfterInteractions(() => {
        if (disposed) {
          return;
        }
        void (async () => {
          try {
            await new TorSettingsStore(secureStorage).load();
          } catch {
            // Defaults apply — the auto ladder is the safe fallback.
          }
          if (!disposed) {
            startColdCascade();
          }
        })();
      });
      retryInitRef.current = attemptInit;
      attemptInit();
    };
    void setup();

    return () => {
      disposed = true;
      // Stop any pending auto-retry and signal the cascade to bail before we tear down.
      desiredConnected = false;
      // The foreground no longer owns Tor — let the background sync take over if it wakes.
      setForegroundOwnsTor(false);
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (currentInitTimer !== undefined) {
        clearTimeout(currentInitTimer);
        currentInitTimer = undefined;
      }
      for (const cleanup of cleanups) {
        cleanup();
      }
      releaseOnboardingTorRef.current = null;
      void manager.disconnect();
    };
  // Mount-once bootstrap: owns the in-process Tor daemon and every app-lifetime subscription.
  // handleDeepLink is a stable useCallback([]) read at subscribe time; deliberately not a dep so
  // this effect can never re-run (a re-run would tear down and restart Tor mid-session).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve the ACTIVE community's signed-update repo into render-reachable state (T9, ship-dark
  // behind APK_UPDATES). getCommunities() is async, so we can't read `active.updateRepo` inline in a
  // render prop; instead re-resolve it whenever the active identity changes (currentUserPubkey flips
  // on every community/identity switch) plus once on first hydration. Flag OFF: the effect returns on
  // its first line — no getCommunities() call, `updateCfg` stays null, the Settings section stays
  // hidden — so a flag-off build is byte-identical (its gate short-circuits before reading updateCfg).
  useEffect(() => {
    if (!APK_UPDATES) return;
    let cancelled = false;
    void (async () => {
      const {list, activeId} =
        (await runtimeRef.current?.getCommunities()) ?? {list: [], activeId: null};
      const active = activeId ? list.find(c => c.id === activeId) : undefined;
      if (!cancelled) {
        setUpdateCfg(active?.updateRepo ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot.currentUserPubkey, hydrated]);

  const handleLoadCommunities = useCallback(async () => {
    return runtimeRef.current?.getCommunities() ?? {list: [], activeId: null};
  }, []);

  // Switch the active community: the runtime does the full silo swap (identity/store/name/gradient/
  // DMs/caches) then we reconnect the relay to the new community's onion. Honouring the user's
  // "new Tor circuit on each switch" choice, request a fresh circuit (NEWNYM) so the two
  // communities' relays aren't reached back-to-back on the same circuit.
  const handleSwitchCommunity = useCallback(async (id: string): Promise<void> => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    await runtime.switchCommunity(id);
    requestNewTorCircuit();
    const newUrl = await runtime.activeRelayUrl(RELAY_ONION_WS);
    reconnectActiveRelayRef.current?.(newUrl);
  }, []);

  const handleLoadKeySlots = useCallback(async () => {
    return runtimeRef.current?.listKeySlots() ?? {slots: [], activeId: null};
  }, []);

  // Switch the active identity (key-ring slot): the runtime activates that slot's workspace; then a
  // fresh Tor circuit + reconnect to its community's relay (same path as the community switcher).
  const handleSwitchIdentity = useCallback(async (slotId: string): Promise<void> => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    await runtime.switchIdentity(slotId);
    requestNewTorCircuit();
    const newUrl = await runtime.activeRelayUrl(RELAY_ONION_WS);
    reconnectActiveRelayRef.current?.(newUrl);
  }, []);

  // Leave a community: the runtime switches away (if it was active) and WIPES its on-device data
  // (identity key + credential + its encrypted event DB). Then reconnect to whatever community is
  // now active (or nothing, if that was the last one).
  const handleRemoveCommunity = useCallback(async (id: string): Promise<void> => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    await runtime.removeCommunity(id);
    requestNewTorCircuit();
    const newUrl = await runtime.activeRelayUrl('');
    if (newUrl) reconnectActiveRelayRef.current?.(newUrl);
  }, []);

  // Leave a single IDENTITY (key-ring slot): wipes just that identity; the runtime switches to
  // another identity first (if it was active) and only drops the community when it was the last
  // identity in it. Then reconnect to whatever's now active.
  const handleRemoveIdentity = useCallback(async (slotId: string): Promise<void> => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    await runtime.removeIdentity(slotId);
    requestNewTorCircuit();
    const newUrl = await runtime.activeRelayUrl('');
    if (newUrl) forceRelayReconnectRef.current?.(newUrl);
  }, []);

  // "Join another community" — run onboarding again in ADD mode, over the live app. It mints a new
  // identity slot + community (additive; the current ones stay saved) and switches to it on finish.
  const handleAddIdentity = useCallback((): void => {
    setIncomingJoinCode(null);
    setAddCommunityMode(true);
  }, []);

  // Post-failure feedback for the onSubmit prop below: runtime.post() is now called fire-and-forget
  // (never awaited there), so this is the ONLY place a post failure — a background blind-draw
  // exhaustion, offline, or (in principle) a pre-render validation throw — surfaces to the user, via
  // a `.catch`. Never mentions the token — a failed background refill reads as a transient
  // connectivity hiccup, never "draw more tokens".
  const postFailureAlert = useCallback((e: unknown): void => {
    // exhaustionReason keeps the calm no-token-jargon contract but is HONEST about cause: when the
    // wallet is empty because the community's issuer keys changed (stale-key draws), it says the app
    // is re-syncing keys and the post will send itself — not "check your connection", which sent the
    // 2026-07-21 member off to debug a network that was fine.
    Alert.alert(
      'Couldn’t post right now',
      e instanceof Error
        ? runtimeRef.current?.exhaustionReason(e) ?? e.message
        : 'Something went wrong — please try again.',
    );
  }, []);

  // Give feedback when a fire-and-forget write actually fails, instead of a dead tap. Master makes
  // vote/reaction/pinned/DM writes swallow silently; we surface them so nothing vanishes without a
  // trace. Mirrors the composer/comment wording: the blind-posting token is an invisible detail, so
  // a failure after the runtime's transparent top-up reads as a transient connectivity hiccup —
  // NEVER a "draw more tokens" prompt. No-op when the runtime isn't ready (undefined promise).
  //
  // Returns a Promise<boolean> (true = landed, false = failed) that NEVER rejects — the failure is
  // fully handled here (alerted) before the caller ever sees it. This lets call sites that need the
  // outcome (the group/channel send paths, which restore a failed draft) await it, while the many
  // existing fire-and-forget `runWrite(...)` call sites keep working unchanged (their return value
  // is simply discarded, and — critically — discarding it can never produce an unhandled rejection,
  // since this promise never rejects).
  const runWrite = useCallback((p: Promise<unknown> | null | undefined): Promise<boolean> => {
    if (!p) return Promise.resolve(false);
    return p.then(
      () => true,
      (e: unknown) => {
        const spaceKeyMissing = e instanceof Error && e.message === 'SPACE_KEY_UNAVAILABLE';
        Alert.alert(
          spaceKeyMissing ? 'Couldn’t send' : 'Couldn’t do that',
          spaceKeyMissing
            ? 'This space is still unlocking on your device — that usually resolves in a moment. Try again shortly.'
            : e instanceof Error
              // exhaustionReason: a token drought keeps its calm message, but a stale-key drought
              // says the keys are re-syncing (honest cause) — see postFailureAlert above.
              ? runtimeRef.current?.exhaustionReason(e) ?? e.message
              : 'Something went wrong — please try again.',
        );
        return false;
      },
    );
  }, []);

  // The Events surface's ONE runtime seam (events/api.ts) — a stable facade whose closures
  // dereference runtimeRef.current at call time, so it survives runtime swaps (community switch)
  // without re-plumbing. MainScreen hands it to EventDetailHost / EventsOrganizerHost.
  const eventsApi = useMemo<EventsApi>(() => ({
    live: c => runtimeRef.current?.eventLive(c) ?? null,
    doc: c => runtimeRef.current?.getEventDocView(c) ?? null,
    myRsvp: c => runtimeRef.current?.myEventRsvpFor(c) ?? null,
    token: c => runtimeRef.current?.eventEmbedTokenFor(c) ?? null,
    myPubkey: () => runtimeRef.current?.getPubkey() ?? null,
    viewerIdentity: () => {
      const r = runtimeRef.current;
      const pk = r?.getPubkey();
      if (!r || !pk) return {name: '', npub: '', grad: ''};
      const id = r.getIdentity(pk);
      const name = id.name || `${id.npub.slice(0, 12)}…${id.npub.slice(-4)}`;
      return {name, npub: id.npub, grad: id.gradient ?? ''};
    },
    channelsIRun: () => {
      const r = runtimeRef.current;
      const pk = r?.getPubkey();
      if (!r || !pk) return [];
      return r
        .getSnapshot()
        .channels.filter(ch => ch.owner === pk)
        .map(ch => ({id: ch.id, label: ch.name?.startsWith('#') ? ch.name : `#${ch.name || 'channel'}`}));
    },
    forwardTargets: () => {
      const r = runtimeRef.current;
      if (!r) return {channels: [], groups: [], peers: []};
      const snap = r.getSnapshot();
      const pk = r.getPubkey();
      return {
        // Channels are owner-broadcast surfaces — only ones the viewer runs are sendable.
        channels: snap.channels
          .filter(ch => !!pk && ch.owner === pk)
          .map(ch => ({id: ch.id, label: ch.name?.startsWith('#') ? ch.name : `#${ch.name || 'channel'}`})),
        groups: snap.groups.map(g => ({id: g.id, label: g.name})),
        peers: snap.inbox.map(conv => {
          const id = r.getIdentity(conv.peer);
          return {
            pubkey: conv.peer,
            name: id.name || `${id.npub.slice(0, 12)}…${id.npub.slice(-4)}`,
            grad: id.gradient,
          };
        }),
      };
    },
    toggleInterested: c => runtimeRef.current?.toggleEventInterested(c) ?? Promise.resolve(),
    apply: (c, note) => runtimeRef.current?.applyToEvent(c, note) ?? Promise.resolve(),
    withdraw: c => runtimeRef.current?.withdrawEventApplication(c) ?? Promise.resolve(),
    joinWaitlist: c => runtimeRef.current?.joinEventWaitlist(c) ?? Promise.resolve(),
    leaveWaitlist: c => runtimeRef.current?.leaveEventWaitlist(c) ?? Promise.resolve(),
    forwardTo: async (target, text) => {
      const r = runtimeRef.current;
      if (!r) return;
      if (target.kind === 'channel') await runWrite(r.postToChannel(target.id, text));
      else if (target.kind === 'group') await runWrite(r.postToGroup(target.id, text));
      else await r.sendDM(target.pubkey, text);
    },
    applications: c => runtimeRef.current?.eventApplicationsFor(c) ?? [],
    guests: c => runtimeRef.current?.eventGuestsFor(c) ?? [],
    waitlist: c => runtimeRef.current?.eventWaitlistFor(c) ?? [],
    stats: c => runtimeRef.current?.eventStatsFor(c) ?? {interested: 0, pending: 0, going: 0, waitlist: 0},
    approve: (c, pk) => runtimeRef.current?.approveEventApplicant(c, pk) ?? Promise.resolve(),
    decline: (c, pk) => runtimeRef.current?.declineEventApplicant(c, pk) ?? Promise.resolve(),
    undoDecision: (c, pk) => runtimeRef.current?.undoEventDecision(c, pk) ?? Promise.resolve(),
    offerSpot: (c, npub) => runtimeRef.current?.offerEventSpot(c, npub) ?? Promise.resolve(),
    messageAll: (c, message) => runtimeRef.current?.messageEventGuests(c, message) ?? Promise.resolve(0),
    cancel: c => runtimeRef.current?.cancelEvent(c) ?? Promise.resolve(),
    publish: (draft, opts) => runtimeRef.current?.publishEvent(draft, opts) ?? Promise.resolve(null),
    republishMine: () => void runtimeRef.current?.republishMyEventDocs(),
    tokenForDraft: draft => runtimeRef.current?.eventEmbedTokenForDraft(draft) ?? null,
    listEntries: () => runtimeRef.current?.eventDrafts.list() ?? Promise.resolve([]),
    getEntry: id => runtimeRef.current?.eventDrafts.get(id) ?? Promise.resolve(null),
    saveEntry: entry => runtimeRef.current?.eventDrafts.save(entry) ?? Promise.resolve(),
    removeEntry: id => runtimeRef.current?.eventDrafts.remove(id) ?? Promise.resolve(),
  }), [runWrite]);

  // Retry from the init-timeout recovery screen: drop back to the splash and re-run the
  // init()-vs-timeout race (attemptInit, set on retryInitRef during setup()).
  const handleRetryInit = useCallback((): void => {
    setInitTimedOut(false);
    setHydrated(false);
    retryInitRef.current();
  }, []);

  /**
   * Establishes/advances the "N new posts" pill's baseline (AppRuntime.markFeedSeen's doc).
   * markFeedSeen() deliberately does NOT emit on its own — AppRuntime.feedSeen.test.ts pins "flows
   * through the normal throttled deferred emit... no special-cased bypass" for relay-driven consumers
   * of newFeedItemCount — so without the getSnapshot()+setSnapshot below, the pill would keep showing
   * the pre-mark count until the next UNRELATED emit happened to carry the fresh one. Every caller of
   * this prop (a deliberate pill tap, or MainScreen's edge-triggered "reader settled back at the
   * top") is infrequent by construction, so reading the runtime directly here is cheap — and, like
   * any other user-driven change in this app, correct to reflect right away rather than wait.
   *
   * TWO deliberate loop guards, both earned the hard way (release APK vc9 shipped with neither and
   * pegged mqt_js at 100% CPU forever — see MainScreen.newPostsPill.test.tsx's regression describe):
   *
   *  1. useCallback([]), NOT the inline arrow every sibling prop on this element uses. This handler
   *     re-renders App, so an identity that changes on every App render is a self-feeding cycle for
   *     any consumer that keys off it. MainScreen no longer does (it holds this in a ref, matching
   *     onOpenGroup/onOpenChannel), but the coupling is sharp enough that both ends should hold.
   *     Stability is free here anyway: runtimeRef is a ref and setSnapshot is a stable setState.
   *  2. Re-render only when the mark ACTUALLY moved. markFeedSeen() returns that, and getSnapshot()
   *     builds a brand-new object every call — so an unconditional setSnapshot can never bail out on
   *     Object.is and re-renders the whole tree even when nothing changed. Because the common case by
   *     far is a repeat mark against an unchanged feed, this also removes the wasted full-tree render
   *     that the pre-existing (correct) callers were paying on every scroll-to-top and tab return.
   *
   * The cancelPendingSnapshotFlush() below is separate from both: this setSnapshot bypasses the
   * subscribe path entirely (it reads the runtime directly), so without it a non-urgent flush queued
   * a moment earlier would fire afterwards and apply its OLDER, pre-mark snapshot — visibly bringing
   * back the "N new posts" count the user just cleared by tapping the pill. See nonUrgentFlush's doc.
   */
  const handleMarkFeedSeen = useCallback((): void => {
    const r = runtimeRef.current;
    if (!r) return;
    if (!r.markFeedSeen()) return;
    cancelPendingSnapshotFlush();
    setSnapshot(r.getSnapshot());
  }, [cancelPendingSnapshotFlush]);

  /**
   * Client-side pre-check for a moderator QUICK action (the post/comment ⋯ menu: Hide, Hide user,
   * Lock, Re-tag, Pin) — returns true when it may proceed, otherwise explains why and returns false.
   *
   * The relay hard-enforces both the organizer's permission scopes and the daily/weekly caps
   * (internal/policy/organizer.go checkModAction), so this was never an authority bypass. But it
   * enforces them by REJECTING the event, and these dispatchers fired and forgot: a scope-limited
   * moderator tapped "Lock", saw the action appear to succeed, and it silently did nothing —
   * indistinguishable from a slow relay. The moderator console has pre-checked scope + limit since
   * it shipped (`can(scope)` + `checkLimit(action)`); the quick actions never did.
   *
   * `action` is the stiq-action value the event will carry, so the cap counted here is the same one
   * the organizer configured and the relay will charge. `scopes` MIRRORS the relay's
   * `modActionPermitted` mapping and must never be stricter than it — blocking something the relay
   * would accept trades a silent failure for a wrong one. That is why a plain hide passes with
   * EITHER hide scope: this dispatcher serves both the post and the comment ⋯ menus and can't tell
   * which, exactly as the relay hook can't resolve the target's type.
   */
  const modQuickActionAllowed = (scopes: ModScope | readonly ModScope[], action: string): boolean => {
    if (!snapshot.isModerator) return false;
    const needed = typeof scopes === 'string' ? [scopes] : scopes;
    if (!needed.some(s => snapshot.modScopes.includes(s))) {
      Alert.alert(
        'Not permitted',
        'The organizer has not granted you this moderation permission. The relay would reject the action.',
      );
      return false;
    }
    const notice = runtimeRef.current?.checkModLimit(action);
    if (notice) {
      Alert.alert('Limit reached', notice);
      return false;
    }
    return true;
  };

  // Hold the splash until the runtime knows the real enrolled state, so onboarding never flashes
  // for an already-enrolled user on cold start. By the time init() settles it has already emitted
  // the real snapshot, so the splash hands off directly to the lock screen (or onboarding).
  if (!hydrated) {
    return <SplashScreen />;
  }

  // init() blew past its timeout (see attemptInit) — the runtime may be only half set up, so this
  // dedicated recovery screen replaces the normal feed/lock rather than risking rendering over it.
  if (initTimedOut) {
    return <InitRecoveryScreen onRetry={handleRetryInit} />;
  }

  return (
    <>
    <AppShell
      enrolled={snapshot.enrolled}
      lock={snapshot.lock}
      pinEnabled={snapshot.pinEnabled}
      connection={connection}
      torBootstrap={torBootstrap}
      torPhase={torPhase}
      onRetryTor={() => applyTorPrefsRef.current?.()}
      feed={snapshot.feed}
      storeVersions={snapshot.storeVersions}
      inbox={snapshot.inbox}
      channels={snapshot.channels}
      currentUserPubkey={snapshot.currentUserPubkey}
      isModerator={snapshot.isModerator}
      modScopes={snapshot.modScopes}
      onGetPendingReports={() => runtimeRef.current?.getPendingReports() ?? []}
      onGetBannedMembers={() => runtimeRef.current?.getBannedMembers() ?? []}
      onGetLoggedAuthors={() => runtimeRef.current?.getLoggedAuthors() ?? []}
      onModeratorUnban={pubkey => { void runtimeRef.current?.moderatorUnban(pubkey); }}
      onModeratorLogAuthor={(pubkey, includePast) => {
        void (async () => {
          const r = runtimeRef.current;
          if (!r) return;
          await r.moderatorLogUser(pubkey);
          if (includePast) {
            const ids = r.getAuthorEventIds(pubkey);
            if (ids.length) await r.moderatorLogBatch(ids, pubkey);
          }
        })();
      }}
      onModeratorRestoreAuthor={pubkey => { void runtimeRef.current?.moderatorUnlogUser(pubkey); }}
      onModeratorLogPost={(eventId, authorPubkey) => {
        void runtimeRef.current?.moderatorLogEvent(eventId, authorPubkey);
      }}
      onCheckModLimit={action => runtimeRef.current?.checkModLimit(action) ?? null}
      sendStatus={snapshot.sendStatus}
      sendReasons={snapshot.sendReasons}
      sendQueuedOffline={snapshot.sendQueuedOffline}
      syncing={snapshot.syncing}
      incomingJoinCode={incomingJoinCode}
      onJoinCodeConsumed={() => setIncomingJoinCode(null)}
      pendingNav={pendingNav}
      onPendingNavHandled={() => setPendingNav(null)}
      notifUnreadCount={snapshot.notifUnreadCount}
      onGetNotifications={() => runtimeRef.current?.deriveNotifications() ?? []}
      onGetNotificationPrefs={() => runtimeRef.current?.getNotificationPrefs() ?? DEFAULT_PREFS}
      onSetNotificationPrefs={(p: NotificationPrefs) => { void runtimeRef.current?.setNotificationPrefs(p); }}
      onMarkNotificationRead={(id: string) => { void runtimeRef.current?.markNotificationRead(id); }}
      onMarkAllNotificationsRead={() => { void runtimeRef.current?.markAllNotificationsRead(); }}
      onAutoExchange={(community, inviteCode, hooks) =>
        exchangeFnRef.current?.(community, inviteCode, hooks) ??
        Promise.resolve({ok: false, error: 'Tor is not ready yet — try again in a moment'})
      }
      onPrefetchCommunity={async session => {
        const start = startCommunityPrefetchRef.current;
        if (!start) return false; // no Tor manager on this build — the rung is simply skipped
        // Idempotent per community: the connecting step calls this once per successful exchange, but
        // a Tor blip can remount that step and replay the (cached) exchange result. Reuse the live
        // handle rather than opening a second socket + a second native handle on the same DB file.
        // A handle for a DIFFERENT community (the member went back and used another code) is closed
        // first — its store and socket belong to a join that is no longer happening.
        const existing = communityPrefetchRef.current;
        if (existing && existing.cid !== communityId(session.relayUrl)) {
          await existing.finish();
          communityPrefetchRef.current = null;
        }
        const prefetch = communityPrefetchRef.current ?? start(session);
        communityPrefetchRef.current = prefetch;
        // BLOCKING wave: bounded inside the prefetch (cap + never-rejects), so the ladder can wait
        // on it unguarded and still be guaranteed to advance.
        const ok = await prefetch.waitForEssentials();
        // NON-BLOCKING wave: the member is about to spend real seconds choosing a handle and a
        // gradient. Spend them downloading the picked spaces' messages instead of idling.
        prefetch.startBulk();
        return ok;
      }}
      onEnroll={async (session, pin, duressPin, gradient, handle) => {
        // Hand the prefetch over to enrollment: close its socket + native store handle FIRST (the
        // same per-(cid, slot) SQLCipher file is about to be reopened), then let enrollment ADOPT its
        // pre-minted account slot — that adoption is the whole point, since the slot id is the store
        // namespace and a freshly-minted one would open an empty DB and discard the download.
        const prefetch = communityPrefetchRef.current;
        communityPrefetchRef.current = null;
        await prefetch?.finish();
        await runtimeRef.current?.completeEnrollment(
          session,
          pin,
          duressPin,
          gradient,
          prefetch ? {slotId: prefetch.slotId} : undefined,
        );
        // The just-enrolled community is active now, so its normal resolver owns the same onion
        // credential. Drop the temporary onboarding override before any later community switch.
        releaseOnboardingTorRef.current?.(false);
        // Connect the feed relay to the just-joined community's relay (now the active community).
        // Nothing community-specific is baked in, so before enrollment there was no feed relay —
        // this is what brings it up and publishes the pending kind-9011 binding event.
        const newUrl = await runtimeRef.current?.activeRelayUrl('');
        if (newUrl) {
          forceRelayReconnectRef.current?.(newUrl);
        }
        // `activeRelayUrl` now points at the just-joined community, so a draw opened here targets the
        // right relay. Start it immediately rather than waiting for startRelay's proactive top-up,
        // which cannot fire until the feed relay's onion rendezvous completes. The prefetch already
        // put the organizer's `stiq:token-keys` doc in the store, so this is one round-trip instead
        // of the two the 2026-07-21 fresh-enroll gap cost — the member's first post finds a stocked
        // wallet instead of paying for a draw on its own critical path.
        kickTokenDrawRef.current?.();
        // The handle chosen during onboarding becomes the (local, relay-blind) display name.
        const trimmed = handle?.trim();
        if (trimmed) {
          await runtimeRef.current?.setMyDisplayName(trimmed);
        }
      }}
      onSetPinEnabled={enabled => { void runtimeRef.current?.setPinEnabled(enabled); }}
      onVerifyPin={async pin => (await runtimeRef.current?.verifyPin(pin)) ?? false}
      onWipe={() => { void runtimeRef.current?.wipeAllData(); }}
      onUserActivity={() => runtimeRef.current?.touch()}
      onSetScrolling={scrolling => runtimeRef.current?.setScrolling(scrolling)}
      onSubmitPin={async pin =>
        (await runtimeRef.current?.submitPin(pin)) ?? 'rejected'
      }
      onSubmit={(content: string, tags: string[], title?: string, label?: PostLabel, contentWarning?: string) => {
        // Long-form articles (title set) are not rate-limited; plain notes are.
        const notice = title ? null : runtimeRef.current?.checkLimit('posts');
        // A rate-limit hit is known SYNCHRONOUSLY, before anything is rendered — reject so the
        // composer dismisses its overlay (never a false "Posted") rather than closing on a write that
        // never happened.
        if (notice) { Alert.alert('Limit reached', notice); return Promise.reject(new Error(notice)); }
        // Fire-and-forget from here — do NOT await/return runtime.post()'s promise. post() renders the
        // durable optimistic placeholder SYNCHRONOUSLY (before its own first `await`), then draws+signs
        // a blind posting token, which can take many seconds over Tor (PoW mining + round-trips).
        // Awaiting that whole promise here — as this used to — is exactly the "publish tap hangs for
        // seconds" bug: ComposerScreen.doPublish holds a blocking "Posting…" overlay on whatever this
        // handler returns, so the user stared at a spinner for the entire draw even though their post
        // was ALREADY durable in the feed behind it. The placeholder is durable by the time this call
        // returns (see above), so the composer can stop waiting right here (this handler returns
        // `undefined`, resolved immediately). The outcome is then reported by the surfaces that
        // outlive the composer and actually know it: the feed's durable sendStatus ('sending' ring →
        // 'failed'+Retry, see AppRuntime.ts signPendingWrite), and the root <Toast/> below once the
        // relay confirms the post (snapshot.postsDelivered). A background failure (final token
        // exhaustion / offline) can no longer reject anyone's `await`, so postFailureAlert surfaces
        // the SAME one-shot Alert here instead — the user still gets told, just not by blocking the
        // compose flow on it.
        runtimeRef.current?.post(content, tags, title, label, contentWarning)?.catch(postFailureAlert);
      }}
      onPromoteChannelPost={(message, content, tags, title, label, contentWarning) => {
        runWrite(runtimeRef.current?.promoteChannelPost(message, content, tags, title, label, contentWarning));
      }}
      onSendDm={(peer, text, replyTo) => {
        runWrite(runtimeRef.current?.sendDM(peer, text, replyTo));
      }}
      onReactDm={(peer, targetRumorId, emoji) => {
        runWrite(runtimeRef.current?.reactToDM(peer, targetRumorId, emoji));
      }}
      onRetryDm={(peer, echoId) => {
        // Fire-and-forget like onCancelSend: retryDm never rejects (sendDM's contract), so there is
        // nothing for runWrite to surface — the DmBubble already shows the ✕/reason/Retry inline.
        void runtimeRef.current?.retryDm(peer, echoId);
      }}
      onVote={(postId, authorPubkey, direction) => {
        // Blind writes refill tokens transparently; if a ✦ tap still fails (offline / mint down),
        // runWrite surfaces the neutral connectivity message so it is never a silent no-op.
        runWrite(runtimeRef.current?.vote(postId, authorPubkey, direction));
      }}
      onCreateChannel={meta => runtimeRef.current?.createChannel(meta) ?? Promise.resolve(null)}
      onEditChannel={(id, meta) => { void runtimeRef.current?.editChannel(id, meta); }}
      onDeleteChannel={id => { void runtimeRef.current?.deleteChannel(id); }}
      onSetChannelPinned={(id, mid) => { void runtimeRef.current?.setChannelPinned(id, mid); }}
      onSetChannelInteractions={(mid, perm) => { void runtimeRef.current?.setChannelInteractions(mid, perm); }}
      onReactToChannelMessage={(mid, pk, emoji) => { runWrite(runtimeRef.current?.reactToChannelMessage(mid, pk, emoji)); }}
      onGetReactionsByTarget={() => runtimeRef.current?.getReactionsByTarget() ?? new Map()}
      getChannelMessageInteractions={(cid, mid) =>
        runtimeRef.current?.getChannelMessageInteractions(cid, mid) ?? {comments: false, reactions: false}
      }
      onPostToChannel={(channelId, content) => {
        const notice = runtimeRef.current?.checkLimit('channel');
        // A limit-reached refusal is a real send failure too — resolve false (not a bare `return`)
        // so the composer's draft-restore logic (which awaits this) doesn't destroy the message.
        if (notice) { Alert.alert('Limit reached', notice); return Promise.resolve(false); }
        return runWrite(runtimeRef.current?.postToChannel(channelId, content));
      }}
      onEditChannelMessage={(channelId, originalId, content) => {
        return runWrite(runtimeRef.current?.editChannelMessage(channelId, originalId, content));
      }}
      subscribedChannelIds={snapshot.subscribedChannelIds}
      onSubscribeChannel={channelId => {
        void runtimeRef.current?.subscribeChannel(channelId);
      }}
      onUnsubscribeChannel={channelId => {
        void runtimeRef.current?.unsubscribeChannel(channelId);
      }}
      onGetThread={postId => runtimeRef.current?.getThread(postId) ?? []}
      listKeyFor={id => runtimeRef.current?.stableListKey(id) ?? id}
      onIsSpaceSynced={subKey => runtimeRef.current?.isScopedSubSynced(subKey) ?? false}
      onGetChannelMessages={channelId =>
        runtimeRef.current?.getChannelMessages(channelId) ?? []
      }
      groups={snapshot.groups}
      relaySupportsNip29={runtimeRef.current?.relayCapabilities().supportedNips.includes(29) ?? RELAY_SUPPORTS_NIP29}
      onCreateGroup={(meta, closed, isPrivate, broadcast) =>
        runtimeRef.current?.createGroup({name: meta.name, about: meta.about, gradient: meta.gradient, reactions: meta.reactions, closed, private: isPrivate, broadcast}) ?? Promise.resolve(null)}
      onJoinGroup={groupId => { void runtimeRef.current?.joinGroup(groupId); }}
      onAcceptInviteLink={url => { void runtimeRef.current?.acceptInviteLink(url); }}
      onLeaveGroup={groupId => { void runtimeRef.current?.leaveGroup(groupId); }}
      onKickGroupMember={(groupId, pubkey) => { void runtimeRef.current?.kickGroupMember(groupId, pubkey); }}
      onAddGroupMember={(groupId, pubkey, asAdmin) => { void runtimeRef.current?.addGroupMember(groupId, pubkey, asAdmin); }}
      onEditGroup={(groupId, meta) => { void runtimeRef.current?.editGroup(groupId, meta); }}
      onGetSpaceSettings={(spaceId, kind) => runtimeRef.current?.getSpaceSettings(spaceId, kind) ?? null}
      onSetSpaceSettings={(spaceId, settings) => { void runtimeRef.current?.setSpaceSettings(spaceId, settings); }}
      onGetLogOffer={groupId => runtimeRef.current?.getLogOffer(groupId) ?? null}
      onSetLogOffer={groupId => { void runtimeRef.current?.setLogOffer(groupId); }}
      onRevokeLogOffer={groupId => { void runtimeRef.current?.revokeLogOffer(groupId); }}
      onApproveJoin={(groupId, pubkey) => { void runtimeRef.current?.approveJoin(groupId, pubkey); }}
      onDenyJoin={(groupId, pubkey) => { void runtimeRef.current?.denyJoin(groupId, pubkey); }}
      onRequestToJoin={(groupId, note) => { runWrite(runtimeRef.current?.requestToJoin(groupId, note)); }}
      onWithdrawJoinRequest={groupId => { void runtimeRef.current?.withdrawJoinRequest(groupId); }}
      onGetJoinState={groupId => runtimeRef.current?.joinRequestStateFor(groupId) ?? 'none'}
      onPreviewSpace={groupId => { runtimeRef.current?.previewSpace(groupId); }}
      onGetSpacePreview={groupId => runtimeRef.current?.getSpacePreview(groupId) ?? null}
      onGetJoinRequestQueue={groupId => runtimeRef.current?.getJoinRequestQueue(groupId) ?? []}
      onGetRosterActionStatus={(groupId, pubkey) => runtimeRef.current?.getRosterActionStatus(groupId, pubkey)}
      onInvitePeople={(groupId, pubkeys) => { runWrite(runtimeRef.current?.inviteToSpace(groupId, pubkeys)); }}
      onRevokeInvite={(groupId, pubkey) => { void runtimeRef.current?.revokeSpaceInvite(groupId, pubkey); }}
      onGetInvited={groupId => runtimeRef.current?.getSpaceInvited(groupId) ?? []}
      spaceInvites={snapshot.spaceInvites}
      joiningSpaces={snapshot.joiningSpaces}
      onAcceptSpaceInvite={groupId => { runWrite(runtimeRef.current?.acceptSpaceInvite(groupId)); }}
      onDismissSpaceInvite={groupId => { void runtimeRef.current?.dismissSpaceInvite(groupId); }}
      onDeleteGroup={groupId => { void runtimeRef.current?.deleteGroup(groupId); }}
      onTransferGroupOwner={(groupId, pubkey) => { void runtimeRef.current?.transferGroupOwner(groupId, pubkey); }}
      onSetGroupInteractions={(gid, mid, perm) => { void runtimeRef.current?.setGroupInteractions(gid, mid, perm); }}
      onReactToGroupMessage={(gid, mid, pk, emoji) => { runWrite(runtimeRef.current?.reactToGroupMessage(gid, mid, pk, emoji)); }}
      getGroupPostInteractions={(gid, mid) =>
        runtimeRef.current?.getGroupPostInteractions(gid, mid) ?? {comments: false, reactions: false}
      }
      onPostToGroup={(groupId, content, replyTo) => runWrite(runtimeRef.current?.postToGroup(groupId, content, replyTo))}
      onEditGroupMessage={(gid, mid, content) => runWrite(runtimeRef.current?.editGroupMessage(gid, mid, content))}
      onReplyToGroup={(groupId, parentId, content) => { runWrite(runtimeRef.current?.replyToGroupMessage(groupId, parentId, content)); }}
      onIsSpaceKeyMissing={groupId => runtimeRef.current?.isSpaceKeyMissing(groupId) ?? false}
      onGetGroupState={groupId => runtimeRef.current?.getGroupState(groupId) ?? null}
      onGetGroupMembers={groupId => runtimeRef.current?.getGroupMembers(groupId) ?? []}
      onGetGroupAdmins={groupId => runtimeRef.current?.getGroupAdmins(groupId) ?? []}
      onGetGroupPending={groupId => runtimeRef.current?.getGroupPending(groupId) ?? []}
      onGetGroupMessages={groupId => runtimeRef.current?.getGroupMessages(groupId) ?? []}
      onGetGroupReplies={groupId => runtimeRef.current?.getGroupReplies(groupId) ?? new Map()}
      onOpenGroup={groupId => runtimeRef.current?.openGroup(groupId)}
      onCloseGroup={groupId => runtimeRef.current?.closeGroup(groupId)}
      onOpenChannel={channelId => runtimeRef.current?.openChannel(channelId)}
      onCloseChannel={channelId => runtimeRef.current?.closeChannel(channelId)}
      onRetry={eventId => {
        void runtimeRef.current?.retry(eventId);
      }}
      onCancelSend={eventId => {
        void runtimeRef.current?.cancelSend(eventId);
      }}
      onComment={(content, rootId, rootPubkey, rootKind, parentId, parentPubkey, parentKind) => {
        const notice = runtimeRef.current?.checkLimit('comments');
        if (notice) { Alert.alert('Limit reached', notice); return; }
        void runtimeRef.current?.comment(
          content,
          {id: rootId, pubkey: rootPubkey, kind: rootKind},
          {id: parentId, pubkey: parentPubkey, kind: parentKind},
        )?.catch(e => {
          // A comment is typed content, so give feedback like the composer does — but NEVER mention
          // tokens. exhaustionReason keeps that contract while being honest about a stale-key
          // drought (keys re-syncing) vs a genuine connectivity hiccup — see postFailureAlert.
          Alert.alert(
            'Couldn’t post your comment',
            e instanceof Error
              ? runtimeRef.current?.exhaustionReason(e) ?? e.message
              : 'Something went wrong — please try again.',
          );
        });
      }}
      onSetPinnedComment={(postId, postAuthorPubkey, postKind, content) => {
        runWrite(runtimeRef.current?.setPinnedComment(postId, postAuthorPubkey, postKind, content));
      }}
      onGetProfile={pubkey => runtimeRef.current?.getProfile(pubkey) ?? {
        pubkey, npub: '', channels: [], posts: [], ideaCount: 0, ideas: [],
      }}
      events={eventsApi}
      onGetEvent={id => runtimeRef.current?.getEvent(id) ?? null}
      onGetEventScore={id => runtimeRef.current?.getEventScore(id) ?? {score: 0, myVote: null}}
      onGetChannelThread={messageId => runtimeRef.current?.getChannelThread(messageId) ?? []}
      onPostChannelComment={(messageId, messagePubkey, messageKind, content) => {
        const notice = runtimeRef.current?.checkLimit('comments');
        if (notice) { Alert.alert('Limit reached', notice); return; }
        void runtimeRef.current?.postChannelComment(messageId, messagePubkey, messageKind, content);
      }}
      onGetPinnedHistory={(postId, postAuthor) =>
        runtimeRef.current?.getPinnedHistory(postId, postAuthor) ?? {latest: null, history: []}
      }
      onGetLogPage={() => runtimeRef.current?.getLogPage() ?? null}
      onGetModLog={() => runtimeRef.current?.getModLog() ?? []}
      onGetLogPost={targetId => runtimeRef.current?.getLogPost(targetId) ?? {item: null, thread: []}}
      onGetPostItem={id => runtimeRef.current?.feedItemFor(id) ?? null}
      onResolveIdentity={id => runtimeRef.current?.resolveIdentityById(id) ?? null}
      onModeratePost={(postId, authorPubkey, action) => {
        // Gate BEFORE opening the sheet: a moderator who can't do this shouldn't compose a reason
        // bucket and a note only to have the relay drop the result on the floor.
        if (action === 'hideUser') {
          if (!modQuickActionAllowed('ban', 'ban')) return;
          setPendingBan({pubkey: authorPubkey});
        } else {
          // Either hide scope: this fires from the post ⋯ menu AND the comment ⋯ menu.
          if (!modQuickActionAllowed(['hide-post', 'hide-comment'], 'hide')) return;
          setPendingRemoval({kind: 'post', targetId: postId, authorPubkey});
        }
      }}
      onChannelOwnerHide={(targetId, authorPubkey) => {
        setPendingRemoval({kind: 'channel', targetId, authorPubkey});
      }}
      onModerationRestore={(targetId, targetType, authorPubkey) => {
        // Un-hiding a USER republishes a kind-10000 mute list, not a kind-1984 stiq-action, so the
        // relay's checkModAction never sees it and gating it here would be stricter than the relay.
        if (targetType === 'user') {
          void runtimeRef.current?.moderatorUnhideUser(targetId);
          return;
        }
        if (!modQuickActionAllowed('restore', 'restore')) return;
        void runtimeRef.current?.moderatorRestore(targetId, authorPubkey);
      }}
      onModeratorLock={(postId, authorPubkey, lock) => {
        // The stiq-action differs by direction, and so does the organizer's cap for it.
        if (!modQuickActionAllowed('lock', lock ? 'lock' : 'unlock')) return;
        void runtimeRef.current?.moderatorLockThread(postId, lock, authorPubkey);
      }}
      onModeratorRetag={(postId, authorPubkey, label) => {
        if (!modQuickActionAllowed('retag', 'retag')) return;
        void runtimeRef.current?.moderatorRetag(postId, label, authorPubkey);
      }}
      onModeratorPin={(postId, authorPubkey, pin) => {
        if (!modQuickActionAllowed('pin', pin ? 'pin' : 'unpin')) return;
        void runtimeRef.current?.moderatorPin(postId, pin, authorPubkey);
      }}
      onMuteAuthor={pk => { void runtimeRef.current?.muteAuthor(pk); }}
      onUnlockContent={epoch => { void unlockContentRef.current?.(epoch); }}
      onBlockUser={pubkey => { void runtimeRef.current?.blockDmPeer(pubkey); }}
      onUnblockUser={pubkey => { void runtimeRef.current?.unblockDmPeer(pubkey); }}
      isUserBlocked={pubkey => runtimeRef.current?.isUserBlocked(pubkey) ?? false}
      draftStore={draftStoreRef.current}
      // Draft access control (Phase 5§D) — mirrors onRequestToJoin/onGetJoinRequestQueue's shape
      // exactly (optional-chain the runtime, fall back to the "nothing yet" value when it's not
      // up). These were previously left unwired here even though AppShell/MainScreen/EmbedReader
      // already forwarded them end-to-end — because every prop is optional, that gap built and
      // tested green while the feature was inert at runtime. See draftAccess.ts's module doc.
      onGetDraftAccessState={draftId => runtimeRef.current?.getDraftAccessState(draftId) ?? Promise.resolve('none')}
      onGetMyDraftDelivery={(draftId, ownerPubkey) =>
        runtimeRef.current?.getMyDraftDelivery(draftId, ownerPubkey) ?? Promise.resolve(null)
      }
      onRequestDraftAccess={(draftId, ownerPubkey) =>
        runtimeRef.current?.requestDraftAccess(draftId, ownerPubkey) ?? Promise.resolve()
      }
      onGetDraftThread={shareId => runtimeRef.current?.getDraftThread(shareId) ?? []}
      onGetDraftCommentCount={shareId => runtimeRef.current?.getDraftCommentCount(shareId) ?? 0}
      // Owner-side "Manage access" (Phase 5§F) — same optional-chain + fallback shape as the five above.
      onGetDraftAccessQueue={draftId => runtimeRef.current?.getDraftAccessQueue(draftId) ?? []}
      onGetDraftAccessGranted={draftId => runtimeRef.current?.getDraftAccessGranted(draftId) ?? []}
      onApproveDraftAccess={(draftId, requesterPubkey) =>
        runtimeRef.current?.approveDraftAccess(draftId, requesterPubkey) ?? Promise.resolve()
      }
      onDenyDraftAccess={(draftId, requesterPubkey) =>
        runtimeRef.current?.denyDraftAccess(draftId, requesterPubkey) ?? Promise.resolve()
      }
      onRevokeDraftAccess={(draftId, requesterPubkey) =>
        runtimeRef.current?.revokeDraftAccess(draftId, requesterPubkey) ?? Promise.resolve()
      }
      onSetDisplayName={name => { void runtimeRef.current?.setMyDisplayName(name); }}
      onSetGradient={spec => { void runtimeRef.current?.setMyGradient(spec); }}
      myCraftedGradient={
        // Authoritative own-gradient for the header/compose avatars: setMyGradient bumps
        // identityVersion + emits, so this re-reads fresh on the very next snapshot — the
        // feed-derived fallback inside MainScreen goes stale for zero-post viewers.
        snapshot.currentUserPubkey
          ? runtimeRef.current?.gradientFor(snapshot.currentUserPubkey)
          : undefined
      }
      tagPolicy={snapshot.tagPolicy}
      labels={snapshot.labels}
      postRules={snapshot.postRules}
      postingGuidelines={snapshot.postingGuidelines}
      communityName={snapshot.communityName}
      communityCid={snapshot.communityCid}
      ranking={snapshot.ranking}
      allowVoice={snapshot.allowVoice}
      pictureRules={snapshot.pictureRules}
      picturesSpentBytes={snapshot.picturesSpentBytes}
      bookmarkedPostIds={snapshot.bookmarkedPostIds}
      lockedPostIds={snapshot.lockedPostIds}
      pinnedPostIds={snapshot.pinnedPostIds}
      newFeedItemCount={snapshot.newFeedItemCount ?? 0}
      onToggleBookmark={(postId: string) => { void runtimeRef.current?.toggleBookmark(postId); }}
      onReportPost={(postId: string, authorPubkey: string) => {
        // Use the organizer's reason buckets (not a hardcoded list) so member reports aggregate
        // by the same categories the moderator queue + mod log understand.
        setPendingReport({postId, authorPubkey});
      }}
      onRefreshFeed={() => runtimeRef.current?.refreshFeed() ?? Promise.resolve()}
      onMarkFeedSeen={handleMarkFeedSeen}
      onLoadOlderFeed={requestOlderFeed}
      onLoadOlderChannelPage={requestOlderChannelPage}
      onLoadOlderGroupPage={requestOlderGroupPage}
      onLoadCommunities={handleLoadCommunities}
      onSwitchCommunity={id => { void handleSwitchCommunity(id); }}
      onRemoveCommunity={id => { void handleRemoveCommunity(id); }}
      onLoadKeySlots={handleLoadKeySlots}
      onSwitchIdentity={id => { void handleSwitchIdentity(id); }}
      onRemoveIdentity={id => { void handleRemoveIdentity(id); }}
      onAddIdentity={handleAddIdentity}
      onJoinAnotherCommunity={handleAddIdentity}
      addCommunityMode={addCommunityMode}
      onExitAddCommunity={() => {
        releaseOnboardingTorRef.current?.(true);
        // An additive join abandoned after the exchange leaves a live prefetch (socket + open
        // SQLCipher handle) for a community this device is not joining. Release it — nothing else
        // ever will, since enrollment is the only other consumer.
        const prefetch = communityPrefetchRef.current;
        communityPrefetchRef.current = null;
        void prefetch?.finish();
        setAddCommunityMode(false);
      }}
      onGetBlossomEndpoint={() => runtimeRef.current?.getBlossomEndpoint() ?? ''}
      onSetBlossomEndpoint={url => { void runtimeRef.current?.setBlossomEndpoint(url); }}
      onGetPreferredBrowser={() => runtimeRef.current?.getPreferredBrowser() ?? ''}
      onSetPreferredBrowser={id => { void runtimeRef.current?.setPreferredBrowser(id); }}
      onListBrowsers={() => listInstalledBrowsers()}
      onClearMediaCache={() => { runtimeRef.current?.clearRenderedMedia(); }}
      onClearEventCache={() => {
        // STORAGE quick action ("Clear old cache"): drop received feed events older than 30 days.
        const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
        runtimeRef.current?.clearCachedEvents({olderThanSeconds: cutoff});
      }}
      onCountCachedEvents={olderThanSeconds =>
        runtimeRef.current?.cachedEventCount({olderThanSeconds}) ?? 0
      }
      onDeleteCachedData={({media, events, olderThanSeconds}) => {
        // Manage-data sheet: the UI computes olderThanSeconds from the chosen preset (undefined =
        // everything cached). Each type is deleted independently and only the event path is dated —
        // rendered media is a small in-memory cache, so it is always cleared whole when selected.
        // Both clear* calls return the count actually removed, so the sheet can confirm the delete.
        return {
          media: media ? (runtimeRef.current?.clearRenderedMedia() ?? 0) : 0,
          events: events ? (runtimeRef.current?.clearCachedEvents({olderThanSeconds}) ?? 0) : 0,
        };
      }}
      onGetConnectionPrefs={() => runtimeRef.current?.getTorConnectionPrefs() ?? DEFAULT_TOR_PREFS}
      onApplyConnectionPrefs={prefs => {
        void runtimeRef.current?.setTorConnectionPrefs(prefs);
        applyTorPrefsRef.current?.();
      }}
      // Relays management (Settings → Relays): the sheet reads a snapshot + drives the mirrorsUser /
      // mirrorsBlocked producers. Each mutation adopts the change on the live MirrorSet (onMirrorsChanged)
      // and persists it; the sheet re-reads the snapshot after each action.
      onGetRelaySnapshot={() => runtimeRef.current?.relaySnapshot() ?? null}
      onAddRelay={(url, onionAuthKey) =>
        runtimeRef.current?.addUserMirror({url, onionAuthKey}) ?? Promise.resolve()
      }
      onRemoveRelay={host => runtimeRef.current?.removeUserMirror(host) ?? Promise.resolve()}
      onMuteRelay={spec => runtimeRef.current?.muteMirror(spec) ?? Promise.resolve()}
      onUnmuteRelay={host => runtimeRef.current?.unmuteMirror(host) ?? Promise.resolve()}
      // Signed in-app updates (T9). Double gate: the APK_UPDATES flag AND a repo-carrying active
      // community (updateCfg). Flag off ⇒ apkUpdatesEnabled is false (short-circuit) and both
      // callbacks are undefined, so SettingsScreen hides the section and no updater code runs.
      apkUpdatesEnabled={APK_UPDATES && !!updateCfg}
      onCheckForUpdate={
        APK_UPDATES && updateCfg
          ? () =>
              managerRef.current
                ? checkForUpdate(managerRef.current, updateCfg)
                : Promise.resolve(null)
          : undefined
      }
      onInstallUpdate={
        APK_UPDATES && updateCfg
          ? info =>
              managerRef.current
                ? downloadAndInstall(managerRef.current, info, updateCfg)
                : Promise.resolve()
          : undefined
      }
      // T5.1/F18: __DEV__-gated wallet/economy diagnostics (Settings → Diagnostics → Token status).
      // tokenStatus is a plain snapshot field (always cheap to read); the refresh callback triggers
      // the one async piece (per-purpose wallet counts) on the screen's open/manual-refresh.
      tokenStatus={snapshot.tokenStatus}
      onRefreshTokenStatus={() => { void runtimeRef.current?.refreshTokenWalletCounts(); }}
    />
    <RemovalSheet
      visible={!!pendingRemoval}
      reasons={snapshot.reasons}
      title={pendingRemoval?.kind === 'channel' ? 'Remove message' : 'Remove post'}
      onCancel={() => setPendingRemoval(null)}
      onConfirm={(reasonId, note) => {
        const p = pendingRemoval;
        setPendingRemoval(null);
        if (!p) return;
        if (p.kind === 'channel') {
          void runtimeRef.current?.channelOwnerHide(p.targetId, p.authorPubkey, reasonId, note);
        } else {
          void runtimeRef.current?.moderatorHide(p.targetId, p.authorPubkey, reasonId, note);
        }
      }}
    />
    <RemovalSheet
      visible={!!pendingReport}
      reasons={snapshot.reasons}
      title="Report post"
      hint="Pick a reason — organizers review reported posts."
      confirmLabel="Report"
      onCancel={() => setPendingReport(null)}
      onConfirm={(reasonId, note) => {
        const r = pendingReport;
        setPendingReport(null);
        if (r) void runtimeRef.current?.reportPost(r.postId, r.authorPubkey, reasonId, note);
      }}
    />
    <BanSheet
      visible={!!pendingBan}
      onCancel={() => setPendingBan(null)}
      onConfirm={(message, untilSec) => {
        const b = pendingBan;
        setPendingBan(null);
        if (b) void runtimeRef.current?.moderatorBan(b.pubkey, message, untilSec);
      }}
    />
    {/* The single link-dialog host: a sibling of AppShell so it is never nested inside a screen's
        Modal (which is why "Open link" once did nothing from channels/sheets). Any component asks
        via openLinkDialog(); this renders the one dialog that decides where a link opens. */}
    <LinkDialogHost />
    {/* The one "your post landed" confirmation, and the counterpart to postFailureAlert above: a
        failure interrupts with an Alert, a success just says so and gets out of the way.

        It lives HERE, at the root, and not in the composer — which is the whole reason it can be
        honest. The composer closes on the publish tap and never waits for the write (waiting through
        the Tor blind draw was the "publish tap hangs for seconds" bug), so it has no outcome to
        report and says nothing. The outcome arrives seconds later, by which time the composer is
        gone and the user may have scrolled past their own card or walked into a channel — so the
        confirmation has to float above whatever they are looking at now.

        `postsDelivered` only moves when the relay has actually taken a post (AppRuntime.
        confirmDelivery), so this cannot fire for a post that failed, was rejected, or is still in
        flight — the failure mode that got the ORIGINAL "✓ Posted" overlay deleted. */}
    <Toast text="✓ Posted" nonce={snapshot.postsDelivered} />
    {/* The single themed alert surface: every Alert.alert(...) routes here (installStiqAlert),
        rendered last so a dialog floats above every screen, sheet and the private browser. */}
    <StiqAlertHost />
    </>
  );
}

function AppWithBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      {/* Make the system status bar read as an extension of the dark Stiq page (like
          Telegram/WhatsApp) rather than an opaque black strip. Mounted once at the root so it
          covers every screen — splash, onboarding, lock, and the feed shell — and every platform:
          • Android: backgroundColor paints the status-bar strip colors.bg (#111111). This mirrors
            the android:statusBarColor set on AppTheme (values/styles.xml), which additionally paints
            it correctly on the very first native frame before React mounts (no black flash).
          • iOS: backgroundColor is a no-op (the bar is a transparent overlay and the #111111 root
            SafeAreaView already shows through), but barStyle="light-content" forces the
            clock/battery/wifi icons light so they're legible on the dark page regardless of the
            device's light/dark setting — the app is dark-only. UIViewControllerBasedStatusBarAppearance
            is NO in Info.plist, so this sets the style app-wide. */}
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} translucent={false} />
      <App />
    </ErrorBoundary>
  );
}

export default AppWithBoundary;
