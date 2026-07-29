/**
 * Static, compile-time configuration.
 * Hardcoded moderator npubs live in `moderation/moderators.ts` (PLAN.md §3.4).
 */

export const APP_NAME = 'stiq';

/**
 * NIP-13 proof-of-work difficulty (leading zero bits) the relay requires on DM gift wraps
 * (kind 1059). MUST match the relay's `pow_difficulty` config — the relay rejects any gift
 * wrap below this, so a mismatch silently breaks DMs.
 */
export const DM_POW_DIFFICULTY = 20;

/**
 * NIP-13 difficulty mined on the credential-exchange mailbox request (kind 9020) during
 * onboarding. MUST match the relay's `enroll_pow`. Kept lower than DM_POW_DIFFICULTY so the
 * pure-JS miner can complete an enrollment request on-device in a few seconds (a one-time cost),
 * without depending on the native PoW module. The relay still gates it, so spam stays expensive.
 */
export const ENROLL_POW_DIFFICULTY = 12;

/**
 * Auto-lock inactivity-timeout duration in milliseconds (PLAN.md §3.5) — the duration AutoLock's
 * idle timer uses WHEN it is armed with a real value. As of the 2026-07-15 bug round, production
 * (App.tsx) no longer arms it with this value by default (it wires `Infinity` instead — "no idle
 * lock" — see IDLE_LOCK_ENABLED near the bottom of this file). Left as-is rather than removed, so
 * turning idle-lock back on is a one-flag revert: flip IDLE_LOCK_ENABLED true and App.tsx wires
 * this duration back in, byte-identical to the pre-round behavior.
 */
export const AUTO_LOCK_MS = 5 * 60_000; // 5 minutes

/**
 * Feature flag: ADDITIONALLY reconcile the feed via NIP-77 Negentropy (fetch only the missing-id
 * delta) as a warm-cache gap-repair pass layered on top of the standing live feed REQ.
 *
 * The live feed REQ (subscriptionPlan's `feed` subscription) ALWAYS runs, regardless of this flag
 * — it is the feed's primary delivery mechanism: a Nostr REQ carrying a `since`/`limit` returns its
 * initial page and then STAYS OPEN, streaming every new matching event as it's published. This
 * flag only gates a SEPARATE reconciliation session, opened on its own subId (`feed-neg`, distinct
 * from the live REQ's `feed` subId so the two never share EVENT/EOSE/pendingSubs bookkeeping), run
 * only when the cache is WARM (never on a cold cache — see COLD_FEED_LIMIT). It exists to catch
 * anything the live REQ's window might have missed (e.g. a dropped frame across a reconnect gap).
 * The relay advertises NIP-77; the client falls back automatically to a legacy REQ on any
 * reconciliation error, so this is safe to toggle.
 */
export const NEGENTROPY_SYNC = true as boolean;

/**
 * Timing-correlation defense (T15). DEFAULT-ON, invisible: adds a small bounded random delay to
 * the NETWORK delivery of every outbound write (posts/votes/comments/DM gift wraps/reconnect
 * resends) and randomizes the background-sync cadence, so an adversary observing Tor traffic
 * timing cannot align a wire send with the user action that produced it. It never touches the
 * optimistic UI render (that already happened in `AppRuntime.publishOptimistic`), so there is no
 * perceived send latency. This flag is the kill-switch: set it `false as boolean` and rebuild to
 * restore byte-identical legacy timing. Consumed by `AppRuntime.deliver` (send jitter),
 * `App.tsx`/`syncTask` (randomized period + startup jitter), and `MirrorSet.publish`
 * (per-secondary stagger). The pure timing modules (`timing/sendJitter.ts`,
 * `background/syncSchedule.ts`) do NOT read this flag — callers decide.
 */
export const TIMING_JITTER = true as boolean;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Ship-dark feature flags (STIQ implementation program, 2026-07-10). Each follows the exact
// NEGENTROPY_SYNC `as boolean` module-const pattern (the `as boolean` defeats literal-type
// narrowing so BOTH branches typecheck). Unless noted, default OFF = today's behavior byte-for-byte;
// flip the const and rebuild to enable. They live together here (config.ts is the single
// conventional home) so the flag block is the one coordinated merge point across the program.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * T1 — Real push over Tor via UnifiedPush + self-hosted ntfy + a keyless firehose watcher. Gated
 * ADDITIONALLY on `caps.push?.watcher` (relay advertised it), the native `StiqUnifiedPush` module,
 * and an available distributor; any absence silently falls through to the unchanged WorkManager
 * polling path. Clients-first: ship this true BEFORE the relay advertises the watcher.
 */
export const PUSH_UNIFIEDPUSH = false as boolean;

/**
 * T2 — App-guided auto-escalating transport ladder (per-network memory + hard per-rung timeouts)
 * replacing the preset-driven connect. OFF = today's ConnectionSheet presets drive connect;
 * true = App.tsx runs connectGuided() and the Sheet demotes presets to an Advanced escape hatch.
 */
export const GUIDED_AUTO_LADDER = true as boolean;

/**
 * T4 — Tor mobile dormancy: signal the embedded daemon DORMANT on background / ACTIVE on resume
 * instead of the binary run/force-kill lifecycle. ON (default): backgrounding idles the live daemon
 * dormant (kept alive) after the grace period, foreground return signals it ACTIVE, and a WorkManager
 * sync adopts the dormant daemon instead of cold-starting a second one. Force-kill teardown remains
 * as the fallback when the daemon can't be idled (not live, or the native DORMANT signal fails).
 * This flag is the one-line ROLLBACK SWITCH: flip to false to restore the legacy force-kill lifecycle.
 */
export const TOR_DORMANCY = true as boolean;

/**
 * T4-S4 measurement gate: when ON, App.tsx emits one `[T4-METRIC] usable dt=… path=<cold|resume>
 * flag=<TOR_DORMANCY>` logcat line on the first relay onSynced after each (re)connect, for the
 * dormancy before/after timing runbook. NOT gated on __DEV__: STIQ's `bundleInDebug=true` debug
 * build bundles with `--dev false` (RN plugin, debuggableVariants=[]), so `__DEV__` is FALSE in the
 * installed debug APK and a __DEV__ gate would be dead-code-eliminated. The `as boolean` cast keeps
 * the branch when this const is flipped true. Committed default OFF (dark); flip true only for the
 * T4 timing builds (alongside TOR_DORMANCY), then flip back before committing.
 */
export const T4_METRIC = false as boolean;

/**
 * T9 — Signed in-app APK updates over Tor from an F-Droid-format repo carried in the join code.
 * OFF = no update checks and no data unless the community actually ships a repo path.
 */
export const APK_UPDATES = false as boolean;

/**
 * Native BIP-340 schnorr signature verification for relay-event ingest (StiqSchnorr module, backed
 * by bitcoin-core libsecp256k1 via secp256k1-kmp). Pure-JS verifyEvent measures several ms per event
 * on Hermes — the per-tick cost floor of the paced inbound drain during a relay burst; native cuts
 * it to well under a millisecond. OFF = nostr-tools verifyEvent, byte-identical to today. Even when
 * ON, a missing/incompilable native module or ANY throw falls back to the pure-JS path automatically
 * (nostr/nativeVerify.ts), so flipping this can never brick ingest — but it must NOT be flipped
 * until the native module has passed on-device validation (accept/reject parity vs verifyEvent).
 */
export const NATIVE_SCHNORR_VERIFY = true as boolean;

/**
 * Native modular arithmetic for the blind-RSA token pathway (StiqRsaMath module, backed by Android
 * BigInteger → BoringSSL BIGNUM). A wallet refill blinds/unblinds DRAW_BATCH=100 tokens; the
 * per-token 2048-bit modexp/inverse in pure JS (sjcl + BigInt) is seconds of JS-thread work on a
 * mid-range phone — the 2026-07-23 "insane actions delay" field report. ON = FastBlindRsa
 * (onboarding/blindrsaFast.ts) when the native module is present; a missing module falls back to
 * RealBlindRsa automatically, byte-identical to before, so flipping this can never brick a draw.
 * Durable draw markers interop across both clients in both directions (same RFC 9474 `inv` bytes).
 */
export const NATIVE_BLIND_RSA = true as boolean;

/**
 * T10 — Tor-tuned negentropy sync: higher initiator branching factor (SYNC_TOR_BUCKETS) + larger
 * bounded outbound frames (SYNC_TOR_FRAME_BYTES) + a per-community watermark reconcile window, to
 * cut reconciliation round-trips over Tor. OFF = buckets 16 / unlimited frame / buildFeedFilter.
 */
export const SYNC_TOR_TUNING = false as boolean;

/**
 * T10 — Low-bandwidth degraded sync: text-only resumable reconcile (drops voice/picture kinds) +
 * prefetch of the active space's pinned + organizer-authored content ahead of the general reconcile.
 * OFF = full-fidelity FEED_KINDS, no prefetch.
 */
export const SYNC_LOW_BANDWIDTH = false as boolean;

/**
 * T10 tuning constants consumed by App.tsx startRelay when SYNC_TOR_TUNING is on. Higher initiator
 * branching (32 vs the default 16) and a 128 KiB bounded outbound frame cut reconciliation
 * round-trips over Tor while staying wire-compatible (the responder reads explicit bounds). Inert
 * unless SYNC_TOR_TUNING is true.
 */
export const SYNC_TOR_BUCKETS = 32;
export const SYNC_TOR_FRAME_BYTES = 131072;

/**
 * T12 — Trust the relay's machine-readable reject-code table for the retryable/terminal send
 * decision (gated ALSO on caps.rejectCodesVersion >= CAPS_REJECT_CODES_MACHINE_MIN). This ships
 * DEFAULT-ON as a kill-switch: calm-message rendering is always on regardless, but the retry
 * DECISION only switches to the code table once the relay advertises v3; until then it falls back
 * to the legacy prose heuristic. Set false to force the legacy heuristic even against a v3 relay.
 */
export const TRUST_RELAY_REJECT_CODES = true as boolean;

/**
 * T14 — Deliver organizer-seeded WebTunnel/obfs4 bridge lines (via the join code / community
 * config) into the transport ladder's bridge resolution. OFF = the built-in bridge set only
 * (DEFAULT_WEBTUNNEL_BRIDGES is empty), so seeded bridges never load.
 */
export const COMMUNITY_SEEDED_BRIDGES = false as boolean;

/**
 * T16 — Event-store compaction v2 in SqliteEventStore: collapse superseded replaceables, expire
 * ephemerals, and honor a mutable organizer RetentionPolicy. OFF = no compaction (today's store).
 */
export const COMPACTION_V2 = false as boolean;

/**
 * T18 — Fuzzy Message Detection (FMD) EVALUATION harness. Eval-only, never flipped in a shipped
 * APK: gates FMD flag-tag injection on DMs/mentions, the client-side detection filter, and the
 * on-device throughput bench. OFF = no FMD anywhere.
 */
export const FMD_EVAL_ENABLED = false as boolean;

/**
 * Newest-N bound applied to a standing live subscription (the feed REQ, and a fresh NIP-29 group's
 * chat resubscription) when the local cache is COLD — i.e. we hold no cached high-water mark for
 * that surface yet. A Nostr REQ carrying a `limit` returns the newest N events first and then
 * STAYS OPEN, streaming anything published after — so one bounded REQ both avoids downloading a
 * community's entire history oldest-first on a fresh device, and doubles as the live delivery tail
 * (the same subscription is how new posts/comments/messages arrive going forward). 50 is a product
 * choice: enough recent context on first load without a multi-minute, oldest-first backfill.
 */
export const COLD_FEED_LIMIT = 50;

/**
 * Page size for the on-demand, one-shot scroll-back REQ (RelayClient.requestOlder), shared by the
 * feed/channel/group surfaces: `{...filter, until: <oldest locally-known created_at>, limit:
 * OLDER_PAGE_LIMIT}`. Kept equal to COLD_FEED_LIMIT so a manual "load older" page is the same size
 * as the initial cold page.
 */
export const OLDER_PAGE_LIMIT = 50;

/**
 * Whether this build's relay supports NIP-29 relay-managed groups. Gates the "Managed group"
 * option in the channel creator. The single baked-in stiq relay implements and advertises
 * NIP-29 (deployed Phase D), so this is true; a build pointed at a relay without NIP-29 would
 * set it false and only offer open NIP-53 channels.
 */
export const RELAY_SUPPORTS_NIP29 = true as boolean;

/**
 * P2-4 — dev/diagnostic long-task watchdog threshold, in ms (UI_FREEZE_DIAGNOSIS_ONDEVICE_
 * 2026-07-12.md §4/§6). `0` = OFF: `installLongTaskWatchdog()` (`dev/longTaskWatchdog.ts`) reads
 * this flag and returns without starting a timer, so a shipped build pays nothing. Any positive
 * value is the blocked-ms threshold above which a JS-thread stall gets logged via
 * `global.nativeLoggingHook` (falls back to `console.warn`) with a `[STIQ-LONGTASK]` marker — set
 * it to e.g. 120 on-device to catch >120ms stalls and name which of A1/A2/A3/B1/B2/B3 (see the
 * diagnosis doc) actually dominates before committing to the larger P1 refactors.
 *
 * UI smoothness overhaul (PLAN_UI_SMOOTHNESS_OVERHAUL_2026-07-22.md, Phase 0): default ON in
 * dev builds at 250ms so any smoothness regression introduced during the migration is caught
 * immediately on-device. Release builds stay OFF (0) — `__DEV__` is compile-time false there.
 */
export const LONGTASK_WATCHDOG_MS = (__DEV__ ? 250 : 0) as number;

/**
 * Hard invariant: the client never opens a clearnet connection to the relay.
 * All transport goes through the bundled Tor daemon (PLAN.md §3.2, Step 4).
 */
export const ALLOW_CLEARNET_FALLBACK = false as const;

/**
 * No community is baked into the build. Every community-specific value — which relay to talk
 * to, which issuer to trust, and which organizer key roots moderation — is carried in the
 * `stiq:join:1:…` invite code (see onboarding/join.ts), parsed into a `Community`, and persisted
 * as the active `EnrolledCommunity` (communities/communityStore.ts). The runtime reads those
 * live values; the constants below are ONLY empty fallbacks for the un-enrolled state.
 *
 * RELAY_ONION_WS: relay-URL fallback used before the member has joined anything. Empty means an
 * un-enrolled app opens no relay connection (it has no community yet); the real relay comes from
 * the active community at enrollment. A white-label single-community build MAY set this, but the
 * default ships blank so nothing community-specific is hardcoded.
 */
export const RELAY_ONION_WS = '';

/**
 * Organizer Nostr public key (npub) fallback — the moderation root of trust (PLAN.md §3.4).
 * Normally EMPTY: the trust root is the organizer carried in the join code (`op`), stored on the
 * active community as `organizerPubkey` and resolved live by AppRuntime. When empty (and no
 * community is active) the client falls back to MODERATOR_NPUBS. A white-label build MAY pin an
 * organizer here, but the default ships blank.
 */
export const ORGANIZER_NPUB = '';

// ── Media & links (PLAN.md §3.2 — all remote bytes go through Tor, never the OS stack) ──

/**
 * Blossom media server used for OUTBOUND image uploads (Tier 3). Empty string disables
 * uploads (the composer hides the image button). Set this to a Blossom server's base URL —
 * an `.onion` host is strongly preferred so uploads/downloads never touch a Tor exit node.
 * The relay itself NEVER stores media; images live on this third-party content-addressed
 * store and are referenced from posts via NIP-94 `imeta` tags (sha256-pinned).
 */
export const MEDIA_BLOSSOM_ENDPOINT = '' as const;

/**
 * If true, the client refuses to fetch or upload media from/to a non-`.onion` host
 * (no Tor-exit egress for media at all). If false, clearnet media is allowed but the UI
 * warns that opening it leaves the Tor network via an exit node.
 */
export const REQUIRE_ONION_MEDIA = false as const;

/** Hard ceiling on any single media fetch/upload. Enforced at the Tor-fetch chokepoint. */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/** The only image types the client will decode/render. A response of any other type is dropped. */
export const MEDIA_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Connect+read deadline for a media or reader-mode fetch over Tor. */
export const MEDIA_FETCH_TIMEOUT_MS = 30_000;

/**
 * Link opening. The live full page, loaded over Tor (Android WebView pointed at Tor's
 * HTTPTunnelPort), is the PRIMARY renderer — JS on, so most sites work. Reader-mode (fetch
 * over Tor → render extracted text only, no live page, no subresource fetches) is the
 * automatic FALLBACK when the Tor proxy is unavailable, and the only mode on iOS. (A full-page
 * WebView over Tor IS technically possible on iOS 17+ via WKWebsiteDataStore.proxyConfigurations,
 * but the deployment floor is 15.1, so reader-mode is the leak-free path there — not because
 * WKWebView "can't" be proxied, which is stale.) READER_MODE_DEFAULT is a kill-switch: set it true to force every
 * link back to reader-only (e.g. if full-page rendering is ever deemed too risky).
 */
export const READER_MODE_DEFAULT = false as const;
export const ALLOW_FULL_PAGE_WEBVIEW = true as const;

/** Max redirect hops followed (over Tor) when resolving a link's final destination. */
export const LINK_MAX_REDIRECTS = 3;

/**
 * Author's-note UI (the pinned kind-1111 comment an author can attach to their own post,
 * rendered in the post-detail view — MainScreen.tsx, under `// ── Author's note ──`). OFF hides
 * every surface: an existing post's note text, the author's "Edit"/"Add note" affordance, the
 * live length counter, and the "view prior edits" entry point + its history dialog all disappear
 * — the detail view renders as if the block were never there, no gap/divider left behind. Nothing
 * underneath changes: `feed/pinned.ts` (buildPinnedComment/loadPinnedHistory),
 * `AppRuntime.setPinnedComment`, the durable `PendingPinnedWrite` recovery path (drainPendingPosts
 * keeps draining any already-queued note write regardless of this flag), `postRules.authorNoteMax`,
 * and the relay's length enforcement all keep running exactly as before. Flipping this back to
 * `true` restores today's author's-note UI byte-identical.
 */
export const AUTHOR_NOTE_ENABLED = false as boolean;

/**
 * PUBLISH inline media (pictures, and later voice) as separate, lazily-fetched blob events rather
 * than as base64 inside the post body — see feed/mediaBlob.ts.
 *
 * ON — the committed value since 2026-07-15, once the relay precondition below was met and verified:
 * a composed picture's (and voice clip's) bytes go out as their own kind-30351 event and the body
 * carries a 72-char reference, so the feed REQ stops streaming every picture in the community to
 * every member whether or not they ever tap it. That is bug 2.
 *
 * OFF is the supported ROLLBACK, and is byte-identical to before the split existed: a composed
 * picture keeps riding inline in the body, exactly as every picture already in the wild does. It
 * remains fully covered (app/mediaBlobPublish.off.test.ts, app/mediaBlobPublish.channel.off.test.ts,
 * feed/mediaBlob.test.ts's explicit-`false` cases) — deliberately, because a rollback is only ever
 * reached in an incident, and one that half-works is worse than none.
 *
 * This gates the WRITE path ONLY. The read path is unconditional and always has been safe to ship:
 * a body carrying a blob reference renders and fetches correctly regardless of this flag, and a body
 * carrying inline base64 renders exactly as before. So flipping this on affects only what THIS
 * device composes next, and flipping it back off never strands content — bodies published while it
 * was on keep working forever.
 *
 * ✅ RELAY PRECONDITION MET — DEPLOYED + VERIFIED 2026-07-15 (binary 62ef1ab1…, NRestarts=0, no errors).
 * Both gates below now admit 30351 on the live relay, via TWO DIFFERENT mechanisms — and the first one
 * is a trap worth recording: a deployed `config.json` that carries its own `allowed_kinds` array
 * OVERRIDES `DefaultAllowedKinds` entirely (config.go's `len(c.AllowedKinds)==0` fallback). It DID
 * (42 kinds, no 30351), so the Go change alone was silently inert and the file had to be patched on the
 * box too (now 43). The history below is kept because it explains why this flag exists at all:
 *
 * ⚠️ (historical — the precondition that had to be met first) TWO relay-side changes are required, not one — a blob is a
 * blind, token-bearing event (AppRuntime.mintMediaBlobs signs it through the same feedSigner as a
 * post, because that signer is what mints the fresh throwaway key each blob must have), so it is
 * gated twice on the way in:
 *   1. `DefaultAllowedKinds` (relay/internal/config/config.go) — the plain kind allow-list.
 *   2. `blindContentKinds` (relay/internal/policy/membership.go) — handleBlindPost REJECTS any
 *      token-bearing event whose kind is not in this set ("not permitted on the blind-post token
 *      path"), a deliberate anti-evasion guard. 30351 is absent today, so allow-listing alone is
 *      NOT enough: every blob would still be refused.
 * Either miss is silent-ish but total: the refusal is a non-retryable `blocked:`, and since a post is
 * not sent until its blobs land (deliver()'s gate), pictures would stop posting entirely rather than
 * degrade. The ordered rollout is: 1+2 relay-side, redeploy, THEN flip this true in a later build.
 * The blob split cannot be delivered client-only; that is a property of the wire format chosen, not
 * of this implementation.
 *
 * Content-sealing compatibility (T5.2, 2026-07-29): BlindSigner seals a blob's content under the
 * write content-epoch key like any body, and NIP-44 ciphertext is itself base64 — so
 * `readMediaBlobPayload` now routes through `resolveContent` FIRST. A still-locked blob reads as
 * "not found" (soft-fail, retryable; heals on epoch unlock) instead of handing ciphertext to the
 * PNG/voice decoders. Pinned by blind/sealedEverywhere.test.ts.
 */
export const LAZY_MEDIA_BLOBS = true as boolean;

/**
 * PIN lock triggers (bug round 2026-07-15, user decision — see BUGROUND_COORDINATION.md). Before
 * this round the app locked on TWO triggers: (a) immediately whenever it backgrounded (App.tsx's
 * AppState 'background' handler, "security finding #22"), and (b) after AUTO_LOCK_MS of
 * foreground inactivity (AutoLock's own idle timer, armed by unlock()/touch()). (a) broke the
 * picture picker: launching the OS image library backgrounds the app as its own foreground
 * Activity, so AppState fires 'background' the instant the user taps the library button — the app
 * locked before a photo was even chosen, and unlocking then remounted a brand-new MainScreen
 * straight to the feed, silently discarding the whole in-progress composer and the picked photo.
 * The user decided the PIN should re-lock ONLY on a genuine cold start (a fresh process — e.g.
 * swiped out of recents) — never on backgrounding, never on an idle timer.
 *
 * LOCK_ON_BACKGROUND false (default): App.tsx's AppState 'background' handler no longer calls
 * runtime.lock(). This alone subsumes the picker bug — the OS picker's background/foreground
 * bounce is now a no-op for the lock screen, same as any other quick background/foreground bounce
 * (nothing else in the app calls runtime.lock() unconditionally on a live process). true restores
 * the pre-round immediate-lock-on-background behavior byte-identical (including the picker bug) —
 * the call site and its explanatory comment are unchanged in App.tsx, just gated behind this flag.
 *
 * IDLE_LOCK_ENABLED false (default): App.tsx wires AutoLock's timeoutMs to `Infinity` instead of
 * AUTO_LOCK_MS, so AutoLock.arm() (lock/autolock.ts) never schedules a timer — touch() and the
 * onUserActivity wiring keep firing exactly as before, they just refresh a timer that is never
 * running, so nothing dead-ends silently. true restores the AUTO_LOCK_MS-based idle lock
 * byte-identical to before this round. Both flags are independent, one-line reverts —
 * AutoLock's arm/disarm/timer mechanics were never touched, only what App.tsx wires into them.
 *
 * Cold-start locking is unaffected by either flag: a fresh `AutoLock` instance always constructs
 * with `state = 'locked'` (lock/autolock.ts), and that state lives only in JS memory — never
 * persisted — so a genuine process restart (the only thing "swipe out of recents" produces) always
 * lands on a brand-new, locked AutoLock regardless of these flags.
 */
export const LOCK_ON_BACKGROUND = false as boolean;
export const IDLE_LOCK_ENABLED = false as boolean;

/**
 * The PIN-lock USER INTERFACE (bug round 2026-07-15, bugs 5+6 — user decision: *"keep the PIN
 * FEATURE IN THE code, but delete every trace of it in the UI/UX, make it return-able upon my
 * request"*). This is a ship-dark flag, NOT a deletion: every line of PIN/lock logic — `lock/`
 * (pin.ts's dual-PIN vault, controller.ts, duress.ts, attemptLimiter.ts, autolock.ts, nativeKdf.ts),
 * `app/screens/LockScreen.tsx`, `ui/PinKeypad.tsx` — is untouched, still compiled, and still covered
 * by its own unchanged test suites. Flipping this const back to `true` and rebuilding restores
 * today's PIN experience byte-identically, including the onboarding PIN step's POSITION in the
 * wizard (the step is skipped by a conditional transition, never removed from the flow).
 *
 * OFF (default) hides exactly four surfaces and nothing else:
 *   1. SettingsScreen's entire `SECURITY` section (its `PIN lock` Switch is its only row, so the
 *      section header goes with it — no empty header, no orphaned divider, no dead gap) and the
 *      "Confirm your PIN" dialog that the toggle opened to disable the lock.
 *   2. OnboardingScreen's PIN step: identity → done goes straight through (the exact transition
 *      "add mode" — joining a SECOND community — has always taken), and the step-dot chrome shows
 *      3 dots (code · connect · identity) instead of 4. `PinStep` itself is untouched and still
 *      unit-tested.
 *   3. `app/route.ts`'s `resolveScreen`, which can no longer return `'lock'` — so `LockScreen` is
 *      unreachable. This is load-bearing, not cosmetic: see the trap note below.
 *   4. `lock/pinPrefs.ts`'s `loadPinEnabled()`, which reports the EFFECTIVE preference `false`.
 *
 * ⚠️ WHY (4) IS MANDATORY — the "trapped existing user" trap. `stiq.lock.pinEnabled` (AsyncStorage,
 * default TRUE) is persisted, so members who are on a PIN today would still read back `true` after
 * this flag lands. Two things in AppRuntime key off `pinEnabled` and would have stranded them:
 *   · `getSnapshot()` skips the ENTIRE heavy build when `lock === 'locked' && this.pinEnabled` —
 *     and a cold start always constructs `AutoLock` in `'locked'`. `autolock.unlock()` is only ever
 *     reached from `lock/controller.ts` (i.e. the LockScreen) or from enrollment, so with the lock
 *     screen unreachable NOTHING would ever clear that state: the member would land on a real feed
 *     screen that is **permanently empty**.
 *   · `lock()` / `schedulePrewarmWhileLocked()` read the same field.
 * Reporting the effective preference as `false` puts those members into the `pinEnabled === false`
 * configuration that has ALREADY shipped and is already tested (it is exactly what a member who
 * turned the Settings toggle off has been living in all along) — no new code path is introduced.
 * `savePinEnabled()` is deliberately NOT gated, and with the toggle hidden nothing ever calls it, so
 * each member's real persisted choice survives untouched and comes straight back when this flips on.
 *
 * NOT changed by this flag: the vault's KDF/sealing, duress classification, the brute-force limiter,
 * `LockController`, or `AutoLock`'s mechanics. Note that while the UI is dark the duress panic-wipe
 * is unreachable *in practice* (its only trigger is a PIN typed into the LockScreen) — the code path
 * is intact and tested, but the coercion defence is inert for as long as this flag is off.
 */
export const PIN_LOCK_UI = false as boolean;

/**
 * MEMBERSHIP-SCOPED CHANNEL SYNC (bug round 2026-07-15, bug 8 — user: *"the syncing/requesting/
 * reading from the relay is messy and it's heavy … only what the user is expected to click on is
 * requested/loaded … e.g. only the channels they are a part of"*).
 *
 * OFF is the supported ROLLBACK — it was the committed default while this shipped dark, and is
 * BYTE-IDENTICAL to master before bug 8: NIP-53 LiveChat (1311) stays inside the firehose kind
 * set, no `channels` subscription is emitted, `AppRuntime.openChannel/closeChannel` are no-ops (the
 * App.tsx deps they call are not wired), and every derived list (TEXT_ONLY_FEED_KINDS, the
 * negentropy reconcile universe, the feed scroll-back filter) resolves to exactly the arrays it
 * resolved to before this round. Still fully covered, in nostr/subscriptionPlan.channels.off.test.ts.
 *
 * ON — the committed value since 2026-07-15 — kind 1311 leaves the unscoped firehose and arrives
 * ONLY through membership-scoped REQs:
 *   1. A standing `channels` sub — `{kinds:[1311], '#a': <cover set>, limit}` — carrying the
 *      channel coordinates the member is actually in, MIXED with `MIN_DECOY_POOL`-gated decoy
 *      coordinates drawn from the same frozen, `me`-keyed, Math.random-free machinery the DM /
 *      self-list / space-key subs already use (see nostr/subscriptionPlan.ts). LIMIT-ONLY, never
 *      `since`-bounded — it is a standing REQ, so the buildLiveFeedFilter rule applies to it in full.
 *   2. A per-channel `channel:<coord>` sub opened while a channel view is on screen and closed when
 *      it leaves — the exact mirror of `subscribeGroup`/`unsubscribeGroup` for NIP-29 groups. This
 *      is what keeps DISCOVERY working: a channel reached from a profile, a space embed or a deep
 *      link is not in the cover set, and without this its view would open empty.
 * Below the decoy floor (fewer than MIN_DECOY_POOL non-joined channels known) the standing sub
 * degrades to an UNSCOPED `{kinds:[1311], limit}` firehose — never a bare `#a: [<my channels>]`,
 * which would hand the relay the member's exact channel membership. The member is never pinned alone.
 *
 * Kind 30311 (LiveActivity — the channel DEFINITIONS) deliberately STAYS on the firehose in both
 * states. It is one small, addressable event per channel (the relay returns only the latest per
 * coordinate), and it is what every discovery surface reads from the cache: the channel directory,
 * a member's owned channels on their ProfileScreen, and the notification screen's per-channel
 * toggles. Scoping it would save almost nothing and would break discovery outright.
 *
 * KNOWN, ACCEPTED LEAK (ON): the standing sub's `#a` array is `|joined| + decoyCount` entries, so a
 * relay that knows `decoyCount` learns HOW MANY channels the member is in — never WHICH, since it
 * cannot tell a real coordinate from a decoy. A member in zero channels emits no `channels` sub at
 * all (there is nothing to fetch), which reveals the same "in no channels" fact the array size would.
 * This is strictly less than today, where the relay serves every channel's traffic to everyone.
 *
 * BEHAVIOUR CHANGE (ON), deliberate and matching the ask: the notification centre no longer raises
 * rows for channels the member has NOT joined (their messages no longer stream). Channels they ARE
 * in still badge and notify exactly as before — that is precisely why the standing cover sub exists
 * rather than open/close alone. Decoy channels are INERT: AppRuntime scopes both the derived
 * notification list and the live push to the member's own channel set, so a decoy can never surface
 * as a notification.
 */
export const SCOPED_CHANNEL_SYNC = true as boolean;
