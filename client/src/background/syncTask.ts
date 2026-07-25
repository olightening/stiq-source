/**
 * Headless background-sync task (PLAN.md Obj. 4).
 *
 * Registered as `StiqBackgroundSync` in index.js. React Native runs this in a JS context
 * with no UI when the WorkManager periodic alarm fires. It:
 *   1. Loads the encrypted SQLite cache (falling back to RAM if the native module is absent).
 *   2. Tries the cached-bridge warm path, falls back to the cold cascade if needed.
 *   3. Opens the relay WebSocket and subscribes with the incremental since + hybrid DM plan.
 *   4. Waits for EOSE (all subscriptions drained) then closes and disconnects.
 *   5. Enforces a hard 85-second wall — slightly under the 90-second HeadlessJsTaskConfig
 *      timeout so we clean up before the OS kills the task.
 *
 * Security invariants preserved:
 *   - Tor-only: relay socket is only opened through the SOCKS proxy.
 *   - No FCM/push: this task is triggered locally by WorkManager, never by a push notification.
 *   - Duress: encrypted cache key is still in Keystore; a wipe between schedule and fire means
 *     createEncryptedEventStore returns null and we fall back to a no-op RAM store.
 */
import {NativeModules} from 'react-native';
import {createTorManager} from '../tor';
import {InMemoryEventStore} from '../nostr/store';
import type {SqliteEventStore} from '../nostr/sqliteStore';
import {createEncryptedEventStore} from '../nostr/sqliteFactory';
import {
  loadCachedBridges,
  saveCachedBridges,
  clearCachedBridges,
} from '../tor/bridgeCache';
import {fetchFreshBridges} from '../tor/bridgeFetch';
import {TorSettingsStore, getTorConnectionPrefs, inferCustomTransport} from '../tor/torSettings';
import {createTorRelaySocket} from '../nostr/torSocket';
import {RelayClient} from '../nostr/RelayClient';
import {createFeedAndDmPlan} from '../nostr/subscriptionPlan';
import {createSecureStorage} from '../keys';
import {KeyRing} from '../keys/keyRing';
import {Identity} from '../keys/identity';
import {CommunityStore} from '../communities/communityStore';
import {RELAY_ONION_WS, TIMING_JITTER} from '../config';
import {
  foregroundOwnsTorNow,
  setBackgroundSyncOwnsTor,
  clearBackgroundSyncAbort,
  shouldBackgroundSyncAbort,
  adoptableDormantDaemon,
} from '../tor/foregroundLock';
import {torActive, torDormant} from '../tor/dormancy';
import type {Event} from 'nostr-tools/pure';
import {syncStartupJitterMs} from './syncSchedule';
import {loadJoinedGroups} from '../channels/groupMembership';
import {
  setNotificationProvider,
  setSessionFloor,
  ensureNotifLoaded,
  encodeNavTarget,
  PUSH_NOTIFY_LOOKBACK_SECONDS,
} from '../notifications/notifications';
import {deriveHeadlessNotifications} from '../notifications/headlessNotify';

// @notifee/react-native is only present on device builds where it was compiled into the APK. Guard
// the require exactly like App.tsx so this task still runs (headless notifications a silent no-op)
// when the native module is absent — jest, or an APK built before notifee was added to the native
// build. This is the T1 headless push-notify backend: a content-free wake syncs over Tor, then the
// events it stored are derived into title-only notifications through the shared composers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let notifee: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  notifee = require('@notifee/react-native').default;
} catch { /* native module not linked — headless notifications are a no-op */ }

const HARD_TIMEOUT_MS = 85_000;
const WARM_TIMEOUT_MS = 45_000;
// TS-1 fix: poll interval for checking a mid-drain foreground abort request
// (requestBackgroundSyncAbort()) during the EOSE wait below. Without this, the drain resolves only on
// onSynced / socket-close / the wall-clock timeout (up to `remaining() - 2_000`, i.e. up to ~83s), so
// once the drain's own `await new Promise` begins there is no checkpoint left at all — a resume
// landing mid-drain silently drops whatever events hadn't arrived yet (the incremental `since` derives
// from what actually landed) and leaves the relay dead for up to 10s (waitForBackgroundSyncRelease)
// while `finally` is still mid-drain. 0 disables the poll entirely, reverting the drain to the pre-fix
// behavior byte-for-byte — see the `if (ABORT_POLL_MS > 0)` guard at the drain below.
const ABORT_POLL_MS = 500;

function trySecureStorage() {
  try {
    return createSecureStorage();
  } catch {
    return null;
  }
}

export async function runBackgroundSync(): Promise<void> {
  // Guard against racing the foreground driver on the single in-process Tor daemon (see
  // foregroundLock.ts for the full contract): this is true only while the app is genuinely
  // foregrounded and active — never merely "process still alive but backgrounded", which is
  // exactly when this task is meant to run. Delivery here is best-effort regardless: Android's
  // Doze/App-Standby/WorkManager throttling can delay or skip this task outright, guard or not.
  if (foregroundOwnsTorNow()) {
    return;
  }
  // A request left over from a PRIOR run this task aborted for (the app resumed mid-sync last
  // time) must not block this fresh run.
  clearBackgroundSyncAbort();
  // Re-checked immediately before every native Tor start below (the entry check above is sampled
  // only once, but the app can resume — or ask us to abort — at any point during this task's many
  // awaits).
  const ownershipOk = (): boolean => !foregroundOwnsTorNow() && !shouldBackgroundSyncAbort();

  const deadline = Date.now() + HARD_TIMEOUT_MS;
  const remaining = () => Math.max(0, deadline - Date.now());

  // Timing-correlation defense (T15): randomize when this task actually touches the network relative
  // to the WorkManager alarm, clamped so it never eats the connect/drain budget. The `remaining() -
  // 15_000` floor guarantees at least ~15s stays reserved for the warm/cold connect + EOSE drain
  // under the 85s wall; inert when TIMING_JITTER is off (byte-identical legacy timing).
  if (TIMING_JITTER) {
    const jitter = Math.min(syncStartupJitterMs(), Math.max(0, remaining() - 15_000));
    if (jitter > 0) {
      await new Promise<void>(r => setTimeout(r, jitter));
    }
  }

  const secureStorage = trySecureStorage();

  // Resolve the active community + relay (set at enrollment). Nothing community-specific is baked
  // in, so an un-enrolled device has no relay — bail rather than bring Tor up for nothing.
  const communities = secureStorage ? new CommunityStore(secureStorage) : null;
  const activeCid = (await communities?.activeId()) ?? undefined;
  const relayUrl = communities
    ? await communities.activeRelayUrl(RELAY_ONION_WS)
    : RELAY_ONION_WS;
  if (!relayUrl) {
    return;
  }

  // Resolve the ACTIVE identity slot BEFORE opening the store: the event cache is now per-(cid,
  // ACCOUNT) (finding #4), so background sync must write the ACTIVE account's OWN file — the exact
  // file the foreground reads on that account. Best-effort: a locked/absent ring yields no slot
  // (→ the legacy per-cid file, matching a pre-per-account install). Reused by the headless notify
  // pass below (it binds Identity to the same slot exactly as the foreground's rebuildIdentity does).
  let activeSlotId: string | undefined;
  if (secureStorage) {
    try {
      activeSlotId = (await new KeyRing(secureStorage).getActiveSlotId()) ?? undefined;
    } catch {
      activeSlotId = undefined;
    }
  }

  // Open the ACTIVE account's own encrypted cache file (`stiq-cache-<cid>__<slot>.db`) — the exact
  // file the foreground reads on that account (App.tsx makeStore). Passing no cid/slot would open a
  // file the enrolled app never reads, so the warm-feed backlog would be downloaded to a file nothing
  // consumes. Un-enrolled (no cid) falls back to a throwaway RAM store below.
  const encrypted =
    secureStorage && activeCid
      ? await createEncryptedEventStore(secureStorage, activeCid, activeSlotId)
      : null;
  const store = encrypted ?? new InMemoryEventStore();

  // Active identity's pubkey, so the plan can subscribe to the user's NIP-17 gift wraps (kind 1059)
  // — the highest-value background payload. Bound to the active KeyRing slot (resolved above) exactly
  // as the foreground binds Identity (rebuildIdentity). Best-effort: a locked/absent key just yields
  // no pubkey and the DM sub is skipped.
  let myPubkey: string | undefined;
  // The active identity's secret key, held ONLY for this task's headless notify pass so it can
  // decrypt the DM gift wraps this sync stored. Copied out of the key guard (useSecretKey scrubs its
  // own buffer after fn returns) and scrubbed in the finally below, so the raw key never outlives the
  // task and is never persisted.
  let mySk: Uint8Array | null = null;
  if (secureStorage) {
    try {
      const identity = new Identity(secureStorage, activeSlotId);
      if (await identity.isEnrolled()) {
        myPubkey = (await identity.info()).pubkey;
        mySk = await identity.useSecretKey(sk => Uint8Array.from(sk));
      }
    } catch {
      myPubkey = undefined;
      mySk = null;
    }
  }

  // NIP-29 groups the user follows — only these raise a headless channel notification (DMs always
  // notify). loadJoinedGroups is AsyncStorage-backed and never throws; empty set when un-hydrated.
  const followedGroupIds = new Set(await loadJoinedGroups(activeSlotId));

  // T4: if the foreground left the single in-process daemon signalled DORMANT but ALIVE (same JS
  // process still up — see foregroundLock.ts), ADOPT it: run this sync over the existing daemon and
  // re-idle it at the end, instead of cold-starting a SECOND daemon and racing tor's in-process
  // re-init. Null when the app was OS-killed (fresh headless context) or dormancy is off, in which
  // case we cold-start our own daemon exactly as before.
  const adopted = adoptableDormantDaemon();
  const manager =
    adopted ?? createTorManager({transport: 'webtunnel', bootstrapTimeoutMs: 5 * 60_000});

  // Boxed so the finally block can close the relay even though it's assigned inside a closure.
  const relayRef: {current: RelayClient | null} = {current: null};

  // Newly-STORED events this sync ingests (RelayClient.onEvent fires only for events that changed the
  // store, not dupes) — the T1 headless notify pass derives title-only notifications from these after
  // the drain, over already-in-memory data so it never adds network work under the 85s wall.
  const collected: Event[] = [];

  // Whether THIS task actually cold-started its OWN daemon. The finally must only stop a daemon this
  // task started — never one the foreground (or anything else) owns — or it would tear down a live
  // connection and crash tor's in-process restart. Always false on the adopt path (we never start a
  // daemon there). (Belt-and-suspenders with the foregroundOwnsTor guard above.)
  let connected = false;

  // TS-2 fix: claim ownership here — immediately before the try/finally that releases it below — so
  // EVERY exit past this line (including a throw) is guaranteed to release it in the finally. Marks
  // that we're now driving Tor, so App.tsx's foreground-resume handler can see it and wait for us to
  // release instead of racing a second concurrent startTor(). Nothing above this line touches Tor or
  // needs the cross-driver guard (community/identity/store resolution are all local reads/awaits —
  // see foregroundLock.ts for the contract this maintains). Claiming any earlier (as this task used to,
  // at function entry) leaked ownership forever on either of the two exits above it — the early
  // `return` when there's no relay to sync, or `createEncryptedEventStore` throwing — leaving
  // `backgroundSyncActive` stuck true for the process lifetime, so every later foreground resume ate
  // the full `waitForBackgroundSyncRelease(10_000)` stall.
  setBackgroundSyncOwnsTor(true);

  // Adopting the foreground's dormant daemon (T4): wake it (SIGNAL ACTIVE) so its idle circuits come
  // back before we open the relay socket over it. It is re-idled (or left ACTIVE for a resumed
  // foreground) in the finally — never disconnected, since the daemon belongs to the foreground.
  if (adopted) {
    torActive();
  }

  try {
    // ── Connect Tor ───────────────────────────────────────────────────────────────
    if (adopted) {
      // Adopt path: the daemon is already `connected` with a live SOCKS proxy (enter() signalled it
      // DORMANT but never disconnected it), so requireTorTransport succeeds and we drain straight
      // over it below — no cold cascade. Re-check ownership/liveness first: the foreground may have
      // resumed (and asked us to abort) during the awaits above, and an OEM-killed daemon would no
      // longer be live even though its adopted TorManager still references it.
      if (!ownershipOk() || !manager.isLive() || remaining() < 5_000) {
        return;
      }
    } else {
      const cached = secureStorage ? await loadCachedBridges(secureStorage) : null;

      if (cached && remaining() > WARM_TIMEOUT_MS && ownershipOk()) {
        const state = await manager.connect({
          transport: cached.transport,
          bridgeLines: cached.bridgeLines,
          bootstrapTimeoutMs: Math.min(WARM_TIMEOUT_MS, remaining()),
        });
        if (state === 'connected') {
          connected = true;
        } else {
          if (secureStorage) { await clearCachedBridges(secureStorage); }
          await manager.disconnect();
        }
      }

      if (!connected && remaining() > 10_000) {
        // Cold cascade (abbreviated — skip GitHub fallback to stay under the wall). On a censored/
        // bridged preset, fetch the bridge list through the domain-fronted hop only so this task never
        // reveals Tor-bootstrap intent from the real IP to a non-fronted destination (audit #50). The
        // headless JS context starts with default prefs, so load the persisted choice first.
        if (secureStorage) {
          await new TorSettingsStore(secureStorage).load();
        }
        const prefs = getTorConnectionPrefs();
        const frontedOnly =
          prefs.mode === 'bridges' ||
          prefs.mode === 'reach' ||
          (prefs.mode === 'custom' &&
            (prefs.preferredTransport ?? inferCustomTransport(prefs)) !== 'direct');
        const webtunnel = await fetchFreshBridges('webtunnel', {frontedOnly});
        if (webtunnel.length > 0 && ownershipOk()) {
          const state = await manager.connect({
            transport: 'webtunnel',
            bridgeLines: webtunnel,
            bootstrapTimeoutMs: remaining() - 5_000,
          });
          if (state === 'connected') {
            connected = true;
            if (secureStorage) { await saveCachedBridges(secureStorage, 'webtunnel', webtunnel); }
          } else {
            await manager.disconnect();
          }
        }
      }

      if (!connected || remaining() < 5_000) {
        return;
      }
    }

    // ── Headless notify backend (T1) ──────────────────────────────────────────────
    // Register the SAME notifee-backed provider App.tsx uses, then REWIND the session floor: the
    // provider stamps the floor to `now`, but the event that triggered this push wake is seconds
    // older, so without the rewind belowSessionFloor() would suppress the very event we woke for.
    // ensureNotifLoaded pulls the shared persisted HWM so the derive pass dedupes against whatever
    // the foreground already surfaced. No-op when notifee isn't compiled in (jest / older APK) — the
    // sync still persists exactly as before, it just fires no notifications.
    if (notifee) {
      void notifee.createChannel({id: 'dm', name: 'Direct Messages'});
      void notifee.createChannel({id: 'channel', name: 'Channel Broadcasts'});
      void notifee.createChannel({id: 'comment', name: 'Comment Replies'});
      setNotificationProvider(async (title, channelId, target) => {
        await notifee.displayNotification({
          title,
          android: {channelId, pressAction: {id: 'default'}},
          data: encodeNavTarget(target),
        });
      });
      setSessionFloor(Math.floor(Date.now() / 1000) - PUSH_NOTIFY_LOOKBACK_SECONDS);
      await ensureNotifLoaded();
    }

    // ── Open relay and drain to EOSE ──────────────────────────────────────────────
    // TS-1 fix: every exit funnels through the single idempotent `done()` below, which now includes a
    // periodic abort checkpoint (ABORT_POLL_MS) alongside the pre-existing onSynced / socket-close /
    // wall-clock exits — previously there was no checkpoint at all once this Promise started, so a
    // resume landing mid-drain silently dropped whatever hadn't arrived yet and left the relay dead for
    // up to 10s. Not gated on TOR_DORMANCY: this race predates dormancy (it exists on the cold-start
    // path too), so gating it here would leave the flag-off path unfixed.
    await new Promise<void>(resolve => {
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      const done = (): void => {
        if (settled) { return; }
        settled = true;
        if (deadlineTimer) { clearTimeout(deadlineTimer); }
        if (pollTimer) { clearInterval(pollTimer); }
        resolve();
      };

      deadlineTimer = setTimeout(done, remaining() - 2_000);

      // ABORT_POLL_MS === 0 skips this block entirely, so the drain reverts to byte-identical pre-fix
      // behavior (only onSynced / socket-close / the wall-clock timeout above can resolve it).
      if (ABORT_POLL_MS > 0) {
        pollTimer = setInterval(() => {
          if (shouldBackgroundSyncAbort()) {
            done();
          }
        }, ABORT_POLL_MS);
      }

      try {
        const socket = createTorRelaySocket(manager, relayUrl);
        // No channel getters (getJoinedChannelIds/getKnownChannelIds) and no subscribeGroup — so
        // under config's SCOPED_CHANNEL_SYNC this plan emits no `channels` sub and a wake syncs the
        // feed + the DM inbox only. That is deliberate, and it matches what background sync has
        // always done for NIP-29 groups: scoped spaces are a foreground concern, warmed on the next
        // connect. Nothing is lost that a wake could act on — deriveHeadlessNotifications explicitly
        // does NOT derive from kind 1311 (see headlessNotify's GROUP_CHANNEL_KINDS: it has no channel
        // roster to resolve an `a`-coordinate against), so the channel traffic this task used to pull
        // over Tor as part of FEED_KINDS could never raise a notification anyway — it only warmed the
        // cache, at full unscoped cost, for every channel in the community.
        relayRef.current = new RelayClient(socket, store, {
          plan: createFeedAndDmPlan({store, getMyPubkey: () => myPubkey}),
        });
        relayRef.current.onEvent(e => collected.push(e));
        relayRef.current.onSynced(done);
        socket.onClose(done);
      } catch {
        done();
      }
    });

    // ── Derive title-only notifications from what this sync just stored (T1) ───────
    // Runs over the already-collected in-memory events (no extra network) so it stays under the 85s
    // wall. Best-effort: any failure is swallowed so the finally's cleanup/persist path always runs.
    // The composers own all suppression (HWM dedupe, the rewound session floor, isNotifAllowed, mute).
    try {
      await deriveHeadlessNotifications({events: collected, mySk, myPubkey, followedGroupIds});
    } catch {
      /* headless notify is best-effort — never fail the sync over it */
    }
  } finally {
    relayRef.current?.close();
    // Scrub the transient secret-key copy the headless notify pass held (it was copied out of the key
    // guard, so nothing else zeroes it) — the raw key must never outlive this task.
    mySk?.fill(0);
    // Release the native SQLite handle so the task leaves no open DB file behind.
    (store as Partial<SqliteEventStore>).close?.();
    if (adopted) {
      // Adopt path (T4): re-idle the daemon we woke (SIGNAL DORMANT) — UNLESS the foreground asked us
      // to abort (TS-1 hardening): exit()'s resumeFromDormant() ALWAYS calls
      // requestBackgroundSyncAbort() when it reclaims Tor from a background sync that still owns it
      // (App.tsx), so that abort flag is the unambiguous "foreground is taking this daemon back"
      // signal. Deliberately NOT foregroundOwnsTorNow() here: that flips off App.tsx's live AppState
      // listener, which can fire before exit() itself runs — an undocumented ordering this guard must
      // not depend on. When aborted, leave the daemon ACTIVE for the foreground, which is bringing its
      // own relay back up. NEVER disconnect either way — the daemon is the foreground's, so tearing it
      // down here would crash tor's in-process restart under it.
      if (!shouldBackgroundSyncAbort()) {
        torDormant();
      }
    } else if (connected) {
      // Only stop Tor if this task cold-started it — otherwise we'd stopTor() on a daemon owned
      // elsewhere.
      await manager.disconnect();
    }
    // Release ownership LAST (after the daemon this task started is actually torn down, or the adopted
    // daemon re-idled), so a foreground resume that was waiting on waitForBackgroundSyncRelease()
    // doesn't start its own cascade while our disconnect()/re-dormant is still mid-flight.
    setBackgroundSyncOwnsTor(false);
  }
}

// Native WorkManager module — only present on Android device builds.
const {StiqWorkManager} = NativeModules as {
  StiqWorkManager?: {
    scheduleSync(intervalMinutes: number, flexMinutes: number): void;
    cancelSync(): void;
  };
};

export const workManager = StiqWorkManager ?? {
  scheduleSync: (_i: number, _f: number) => undefined,
  cancelSync: () => undefined,
};
