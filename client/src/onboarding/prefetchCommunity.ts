/**
 * First-run community prefetch — the onboarding ladder's "Getting your community ready" rung.
 *
 * THE PROBLEM. Until this existed, a brand-new member's community relay did not exist until
 * `AppRuntime.completeEnrollment` ran — which happens when they tap "Enter the community", the LAST
 * thing in onboarding. `completeEnrollment` → `swapActiveStore()` opens a fresh, EMPTY per-(cid,
 * slot) SQLCipher DB, and only then does App.tsx point the feed relay at the community. So the very
 * first screen a member ever sees (the Updates tab — MainScreen lands there on a first entry, see
 * communityEntry.ts) rendered against an empty cache and filled in over Tor while they watched. The
 * whole join had already spent 30–90s connecting; the app then felt broken for another 30.
 *
 * THE FIX. The moment the blinded credential exchange returns a Session we already know everything
 * needed to open that community's real store and talk to its real relay:
 *   • `cid`    = communityId(session.relayUrl)      — the store namespace,
 *   • `slotId` = a PRE-MINTED account slot          — handed to completeEnrollment later so it
 *                                                     adopts this exact DB instead of opening
 *                                                     another one,
 *   • the organizer pubkey                          — the org-config subscription's author scope.
 * So we open that store now and run the REAL {@link RelayClient} with the REAL
 * {@link createFeedAndDmPlan} into it over a dedicated Tor socket. Nothing is re-implemented: the
 * subscription shapes, the ingest gate, the signature verify, the dedupe and the paced inbound drain
 * are all the production ones. (This repo has a recorded history of the same element being
 * re-implemented divergently across parallel worktrees — a second, hand-written "what to REQ" list
 * is exactly the shape that goes stale silently.)
 *
 * WHAT THE PLAN DEGRADES TO, AND WHY THAT IS CORRECT. `getMyPubkey` returns undefined here — the
 * member has no enrolled npub yet — so createFeedAndDmPlan emits ONLY the `feed` and `org-config`
 * subscriptions and omits the DM inbox, self-lists, space-key deliveries, draft deliveries and the
 * self identity-enc profile. That is not a limitation, it is the right answer: a member who has
 * never existed in this community has no DMs, no lists, no key deliveries and no prior profile to
 * converge with. What IS there — the organizer's kind-30078 docs (log page, guide, featured, rules,
 * labels, limits, moderators, `stiq:token-keys`), the kind-30311 channel definitions, and the feed's
 * bounded first page — is precisely what the Updates tab renders and what the first post needs.
 *
 * NOTHING IDENTITY-BEARING IS WRITTEN. No secret key, no credential, no KeyRing slot, no community
 * record. If the app is killed between here and "Enter the community", all that is left behind is an
 * orphan DB file under a slot id nothing references — not a half-enrolled account. Enrollment stays
 * the single moment identity is committed.
 *
 * KNOWN LIMIT, stated rather than papered over. "Essentials in" is defined as the relay EOSEing the
 * plan, and RelayClient also settles a subscription the relay CLOSEs outright (`handleClosed` →
 * markSynced). So if a relay ever enforced `read_auth_required` — false in production today, and
 * this connection carries no NIP-42 AUTH because it has no identity to authenticate with — the
 * subscriptions would be refused, the rung would check off against an empty store, and the member
 * would land on the cold Updates tab they land on today. That is the correct failure: this feature
 * makes a good case faster, and is never load-bearing for correctness. Distinguishing "EOSE'd
 * empty" from "refused" would only let us show a sadder spinner for the same outcome.
 *
 * The two waves this exposes are deliberately different in kind:
 *   • {@link CommunityPrefetch.waitForEssentials} — BLOCKS the connecting screen, but only until the
 *     relay EOSEs its plan (or the cap fires). Bounded, and never fatal: a failure resolves `false`
 *     and onboarding proceeds exactly as it did before this module existed.
 *   • {@link CommunityPrefetch.startBulk} — does NOT block. It runs while the member picks a handle
 *     and a gradient, turning that human time into download time.
 */
import type {Event} from 'nostr-tools/pure';
import {RelayClient} from '../nostr/RelayClient';
import {createFeedAndDmPlan} from '../nostr/subscriptionPlan';
import type {EventStore} from '../nostr/store';
import type {RelaySocket} from '../nostr/socket';
import {communityId} from '../communities/communityStore';
import {newSlotId} from '../keys/keyRing';
import {parseChannel} from '../channels/channels';
import {CHANNEL_CHAT_KINDS, Kind} from '../contracts';
import {log} from '../util/log';
import type {Session} from './enrollment';

/**
 * How long the BLOCKING wave may hold the connecting screen before it gives up and lets the member
 * through. Generous enough for a healthy onion round-trip plus a first page, short enough that a
 * silently-stalled circuit costs a fifth of a minute rather than the whole join. Whatever has landed
 * by then is kept; the bulk wave (and, after enrollment, the normal feed relay) covers the rest.
 */
const DEFAULT_ESSENTIALS_CAP_MS = 20_000;

/** How many channels the bulk wave pulls recent messages for (newest definitions first). */
const DEFAULT_SPACE_COUNT = 8;

/** Max channel messages the bulk wave asks for across those channels in one REQ. */
const DEFAULT_SPACE_MESSAGE_LIMIT = 120;

export interface CommunityPrefetchDeps {
  /**
   * Opens a fresh Tor-routed socket to the community's OWN relay (`session.relayUrl`) — the same
   * factory the credential exchange uses, so this rides a circuit Tor has already proven.
   */
  connect: () => RelaySocket | Promise<RelaySocket>;
  /**
   * The host's per-(community, account) encrypted store factory — the SAME one wired into
   * `AppRuntimeDeps.createStore`. Passing the host's factory (rather than constructing a store here)
   * is what guarantees the file this warms is byte-for-byte the file enrollment later opens.
   */
  createStore: (cid: string, slotId: string) => Promise<EventStore>;
  /** Ingest signature verifier (native BIP-340 when available). Defaults to RelayClient's own. */
  verify?: (event: Event) => boolean;
}

export interface CommunityPrefetchOptions {
  essentialsCapMs?: number;
  spaceCount?: number;
  spaceMessageLimit?: number;
}

export interface CommunityPrefetch {
  /**
   * The pre-minted account slot. `completeEnrollment` MUST be given this id, or it mints its own and
   * opens a different (empty) DB — silently discarding everything downloaded here.
   */
  readonly slotId: string;
  readonly cid: string;
  /**
   * Resolves `true` once the relay has EOSE'd the plan (organizer config + channel definitions +
   * the feed's first page are in the store), `false` if the cap fired, the socket died, or the
   * prefetch never got off the ground. NEVER rejects — the caller's job is to proceed either way.
   * Idempotent: repeated calls return the same settled promise.
   */
  waitForEssentials(): Promise<boolean>;
  /**
   * Start the non-blocking second wave (recent messages for the community's channels). Safe to call
   * before the essentials land — it waits for them internally — and a no-op if the prefetch failed
   * or has already been finished. Never throws.
   */
  startBulk(): void;
  /**
   * Close the socket and release the store handle, then resolve. MUST be awaited before enrollment
   * opens the same DB file. Idempotent and never rejects.
   */
  finish(): Promise<void>;
}

/**
 * Open the community's real store + relay and start filling it. Returns synchronously with a handle;
 * all the actual work is behind {@link CommunityPrefetch.waitForEssentials}.
 *
 * Every failure mode collapses to "the caller proceeds as if this module did not exist": a store
 * that won't open, a socket that won't connect, a relay that never EOSEs, a store with no `close`.
 * The slot id is handed back even on total failure — enrollment then opens that (empty) namespace,
 * which is exactly today's behaviour.
 */
export function startCommunityPrefetch(
  session: Session,
  deps: CommunityPrefetchDeps,
  opts: CommunityPrefetchOptions = {},
): CommunityPrefetch {
  const cid = communityId(session.relayUrl);
  const slotId = newSlotId();
  const capMs = Math.max(1_000, Math.trunc(opts.essentialsCapMs ?? DEFAULT_ESSENTIALS_CAP_MS));
  const spaceCount = Math.max(1, Math.trunc(opts.spaceCount ?? DEFAULT_SPACE_COUNT));
  const spaceMessageLimit = Math.max(
    1,
    Math.trunc(opts.spaceMessageLimit ?? DEFAULT_SPACE_MESSAGE_LIMIT),
  );

  let store: EventStore | null = null;
  let relay: RelayClient | null = null;
  let finished = false;
  let bulkStarted = false;

  /** Release a store handle. Not every implementation has `close` (in-memory / pre-native). */
  const closeStore = (s: EventStore | null): void => {
    try {
      (s as {close?: () => void} | null)?.close?.();
    } catch {
      /* best effort — a store that won't close must not break the handoff */
    }
  };

  /**
   * Bring the store + socket + client up. Resolves true once the relay reports its plan fully
   * EOSE'd. Resolves false (never rejects) on any failure, on socket death, or when `finish()` has
   * already run. The cap is applied by the caller-facing promise below, so a late EOSE after the cap
   * still counts for the bulk wave's readiness check.
   */
  const synced: Promise<boolean> = (async () => {
    try {
      const opened = await deps.createStore(cid, slotId);
      // `finish()` can land DURING the open above (enrollment is one tap away, and the member can
      // abandon an additive join at any time). It saw `store === null` and had nothing to release,
      // so this handle is now ours to close — otherwise a native SQLCipher handle stays open on the
      // exact file enrollment is about to reopen, which is the one thing finish() exists to prevent.
      if (finished) {
        closeStore(opened);
        return false;
      }
      store = opened;
      const socket = await deps.connect();
      if (finished) {
        try { socket.close(); } catch { /* already gone */ }
        return false;
      }
      const client = new RelayClient(socket, store, {
        // Same paced inbound drain the production feed client uses: native WebSocket frames land on
        // the JS thread, and the connecting screen is animating a spinner + progress bar while this
        // runs. Draining a few frames per macrotask is what keeps that animation smooth under a
        // first-sync burst.
        inboundBatchSize: 4,
        inboundTimeSliceMs: 8,
        verify: deps.verify,
        plan: createFeedAndDmPlan({
          store,
          // No enrolled npub yet — see the module doc. This is what correctly reduces the plan to
          // `feed` + `org-config`, and it is ALSO what keeps this connection from ever carrying an
          // npub-scoped filter: there is no identity to leak here, and none is invented.
          getMyPubkey: () => undefined,
          getOrganizerPubkey: () => session.community.organizerPubkey,
        }),
      });
      relay = client;
      return await new Promise<boolean>(resolve => {
        let settled = false;
        const done = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        client.onSynced(() => done(true));
        // A socket that dies before EOSE is a definite negative, not something to wait out the cap
        // for — resolve now so the connecting screen advances immediately instead of stalling.
        socket.onClose(() => done(false));
        // Already synced (a relay that EOSEs before this listener attaches is possible on a fake /
        // very fast transport) — don't wait for an event that has already fired.
        if (client.isSynced()) done(true);
      });
    } catch (e) {
      log.warn('onboarding', 'community prefetch could not start', e);
      return false;
    }
  })();

  /** The blocking wave: `synced`, but never longer than the cap. */
  const essentials: Promise<boolean> = new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      log.info('onboarding', `community prefetch cap (${capMs}ms) reached — continuing`);
      resolve(false);
    }, capMs);
    void synced.then(ok => {
      clearTimeout(timer);
      resolve(ok);
    });
  });

  /**
   * The channel coordinates worth pulling messages for: the newest kind-30311 definitions in the
   * store. Derived through the canonical {@link parseChannel} rather than by re-deriving a
   * `30311:<pubkey>:<d>` string here, so a change to how a channel's coordinate is formed can never
   * leave this file quietly asking for the wrong thing.
   */
  const topChannelCoordinates = (from: EventStore): string[] => {
    const seen = new Set<string>();
    const coords: string[] = [];
    const defs = from
      .query({kinds: [Kind.LiveActivity]})
      .slice()
      .sort((a, b) => b.created_at - a.created_at);
    for (const ev of defs) {
      const channel = parseChannel(ev);
      if (!channel || seen.has(channel.id)) continue;
      seen.add(channel.id);
      coords.push(channel.id);
      if (coords.length >= spaceCount) break;
    }
    return coords;
  };

  return {
    slotId,
    cid,
    waitForEssentials: () => essentials,
    startBulk: () => {
      if (bulkStarted) return;
      bulkStarted = true;
      void (async () => {
        // Wait on `synced` (not `essentials`): if the relay EOSE'd just after the cap fired, the
        // channel definitions ARE in the store and the bulk pull is still worth issuing.
        const ok = await synced;
        const client = relay;
        const from = store;
        if (!ok || finished || !client || !from) return;
        try {
          const coords = topChannelCoordinates(from);
          if (coords.length === 0) return;
          // One bounded, one-shot REQ (RelayClient.fetchByFilter closes it on EOSE). Under
          // SCOPED_CHANNEL_SYNC these messages are NOT on the firehose and the plan's `channels` sub
          // is omitted for a member who has joined nothing — so without this, tapping into a space
          // from the Updates tab lands on an empty room.
          client.fetchByFilter([
            {kinds: CHANNEL_CHAT_KINDS, '#a': coords, limit: spaceMessageLimit},
          ]);
          log.info('onboarding', `community prefetch: pulling messages for ${coords.length} space(s)`);
        } catch (e) {
          // Best-effort by construction — the feed relay re-covers all of this after enrollment.
          log.warn('onboarding', 'community prefetch bulk wave failed', e);
        }
      })();
    },
    finish: async () => {
      if (finished) return;
      finished = true;
      try { relay?.close(); } catch { /* socket already gone */ }
      relay = null;
      // Release the native SQLCipher handle BEFORE enrollment reopens the same file.
      closeStore(store);
      store = null;
    },
  };
}
