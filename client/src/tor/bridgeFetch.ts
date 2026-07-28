/**
 * Bridge fetcher — queries the Tor Project moat/circumvention API for fresh bridge lines
 * (WebTunnel or obfs4) when the bundled bridges are absent or fail to connect.
 *
 * Races three sources concurrently, staggered by mild preference, first-non-empty-wins (see
 * `fetchFreshBridges` below for why these run concurrently rather than one-after-another):
 *   1. Direct HTTPS to bridges.torproject.org (works on uncensored networks)
 *   2. Domain-fronted via the CDN77 edge (same CDN front used by Snowflake) — the TCP
 *      connection goes to cdn77.com but the Host header routes the request to the Tor
 *      Project's moat service, bypassing DNS/SNI-level blocking.
 *   3. GitHub raw bridge-collector (scriptzteam/Tor-Bridges-Collector) — a community repo
 *      that polls the official Tor distribution hourly and commits fresh bridge lines.
 *      raw.githubusercontent.com is a CDN-served static file, reachable on most ISPs
 *      even when bridges.torproject.org is fully blocked. Serves BOTH obfs4 and webtunnel
 *      (see GITHUB_WEBTUNNEL_URLS — webtunnel was wrongly excluded from this hop until
 *      2026-07-27). Returns a random 12-line subset so different clients present different
 *      bridge sets, validated and de-duplicated by `githubBridgeLines`.
 *
 * This is a clearnet HTTPS call made BEFORE Tor is up — it fetches bridge addresses only,
 * never touches the relay or exposes user content. This is the same bootstrap pattern Tor
 * Browser uses (moat protocol, tor-browser-spec §3.3).
 *
 * RESIDUAL EXPOSURE (audit #50): the DIRECT and GitHub hops are NOT domain-fronted, so their
 * destination CDN (and any on-path observer) sees the device's real IP fetching Tor bridge lists —
 * a Tor/STIQ-bootstrap signal outside Tor. Only the CDN77-fronted moat hop hides the destination
 * behind an unrelated SNI/Host. When the user has explicitly selected a censored/bridged connection
 * mode, pass `{frontedOnly: true}` so ONLY the fronted hop is used and the bootstrap intent is never
 * revealed to the direct/GitHub destinations. (Even the fronted hop still exposes the real IP to the
 * fronting CDN; this matches Tor Browser's moat posture and is the accepted tradeoff.)
 *
 * PROTOCOL CHECK (2026-07-27): endpoint paths/hosts below were re-verified against Tor Project's
 * own infrastructure where reachable. `bridges.torproject.org` and `gitlab.torproject.org` do not
 * resolve from this dev sandbox, so this was done via: (a) guardianproject/orbot-android's
 * `scripts/update-bridges.sh`, which runs `wget https://bridges.torproject.org/moat/circumvention/
 * builtin` — the "builtin" endpoint, a sibling of the "settings" endpoint this file calls under the
 * same `/moat/circumvention/` prefix — confirming that path prefix and the CDN77 host
 * (`1098762253.rsc.cdn77.org`, the same one Snowflake's broker uses — see bridges.ts) are both still
 * correct and current; (b) pkg.go.dev's rendering of rdsys's actual Go source
 * (gitlab.torproject.org/tpo/anti-censorship/rdsys, pkg/usecases/distributors/moat) for the response
 * shape — see moatBridgeStrings() below, which found and fixed a real mismatch. The request body
 * shape (`{data:[{version,settings,transports}]}`) matches moat's documented JSON-API-style envelope
 * (protocol version "0.1.0") and was not changed.
 */
import type {TransportType} from './types';
// The one place in TS that encodes the wire shape of a bridge line (the same validator the custom-
// bridge paste box in Settings runs on untrusted input). Used ONLY on the GitHub-collector hop
// below — a bulk, unvetted community scrape — never on a moat response: moat is Tor Project's own
// distributor, and its obfs4 lines have historically used shorter/differently-shaped fingerprint
// fields than OBFS4_RE demands, so validating them here would silently empty a legitimate fetch.
import {validateBridgeLine} from './torSettings';

const MOAT_PATH = '/moat/circumvention/settings';
const MOAT_DIRECT = `https://bridges.torproject.org${MOAT_PATH}`;
const MOAT_FRONTED = `https://1098762253.rsc.cdn77.org${MOAT_PATH}`;
// Community obfs4 bridge collectors, tried in order. The scriptzteam repo has used both `main`
// and `master` as its default branch over its life, and raw.githubusercontent.com serves them
// at different ref paths — listing both means a branch rename can't silently break the fetch.
// Re-verified 2026-07-27: GitHub's API 301-redirects .../branches/master -> .../branches/main
// (confirming the rename actually happened), and raw.githubusercontent.com serves bridges-obfs4
// successfully at BOTH ref names today, so both URLs below are live, not dead weight.
const GITHUB_OBFS4_URLS = [
  'https://raw.githubusercontent.com/scriptzteam/Tor-Bridges-Collector/main/bridges-obfs4',
  'https://raw.githubusercontent.com/scriptzteam/Tor-Bridges-Collector/master/bridges-obfs4',
] as const;
/**
 * The SAME collector's webtunnel list. Added 2026-07-27, replacing a comment in `fetchFreshBridges`
 * that claimed "WebTunnel lines in that repo use RFC 3849 anonymised IPs and cannot be used
 * directly" — that claim was WRONG and it left the app's single most important anti-censorship
 * transport with exactly one live source (moat), on precisely the networks where moat is blocked.
 *
 * Verified 2026-07-27 by fetching the file and cross-checking against a real bridge operator's own
 * published lines (Emerald Onion): a webtunnel bridge line's address field is a PLACEHOLDER by
 * design — `[2001:db8:…]:443`, sometimes even an RFC 1918 IPv4 — because the client dials `url=`
 * over HTTPS and never touches that address; it exists only to give tor a unique addr:port key.
 * That is what BridgeDB itself hands out, so these lines are ordinary distributable webtunnel
 * bridges, not redacted ones. Tor Project publishes NO built-in webtunnel set (see
 * bridges.ts::DEFAULT_WEBTUNNEL_BRIDGES), so this collector is the only non-moat source there is.
 *
 * Lines from here are the least-trusted input in this file, so unlike the moat hops they are run
 * through `validateBridgeLine` and de-duplicated (see `githubBridgeLines`).
 */
const GITHUB_WEBTUNNEL_URLS = [
  'https://raw.githubusercontent.com/scriptzteam/Tor-Bridges-Collector/main/bridges-webtunnel',
  'https://raw.githubusercontent.com/scriptzteam/Tor-Bridges-Collector/master/bridges-webtunnel',
] as const;

/** Which transports the GitHub collector hop can serve, and from where. */
const GITHUB_URLS: Partial<Record<TransportType, readonly string[]>> = {
  obfs4: GITHUB_OBFS4_URLS,
  webtunnel: GITHUB_WEBTUNNEL_URLS,
};

const CONTENT_TYPE = 'application/vnd.api+json';

function moatBody(transport: TransportType): string {
  return JSON.stringify({
    data: [{version: '0.1.0', settings: [], transports: [transport]}],
  });
}

/**
 * One rdsys `Settings` element: `{Bridges BridgeSettings}` — a single bridge-type recommendation.
 * `type` is rdsys's `BridgeSettings.BridgeType` field (`json:"type"`) — the discriminator that says
 * which transport `bridge_strings` below actually belongs to. `Settings` being an ARRAY (see
 * moatBridgeStrings' doc comment) means a single moat response can legitimately carry more than one
 * entry — e.g. one obfs4 recommendation and one snowflake recommendation side by side — so this field
 * is NOT redundant with the single `transport` this file requested; it is the only way to tell which
 * entry is which once there's more than one.
 */
interface MoatSettingsEntry {
  bridges?: {type?: string; bridge_strings?: string[]};
}

/**
 * Flatten a moat response's `data[0].settings` into bridge line strings for the REQUESTED transport
 * only, accepting EITHER shape the real API can plausibly send instead of committing to one and
 * silently returning nothing if that guess is wrong:
 *   - an ARRAY of `{bridges: {bridge_strings}}` — what rdsys's actual Go source declares:
 *     `type CircumventionSettings struct { Settings []Settings }` and
 *     `type Settings struct { Bridges BridgeSettings }` (gitlab.torproject.org/tpo/anti-censorship/
 *     rdsys, pkg/usecases/distributors/moat — confirmed via pkg.go.dev on 2026-07-27, since
 *     gitlab.torproject.org itself doesn't resolve from this dev sandbox). `Settings` being an
 *     array (there can be more than one bridge-type recommendation) means the correct access path
 *     is `settings[i].bridges`, not `settings.bridges`.
 *   - a single flat `{bridges: {bridge_strings}}` object — what this function assumed before
 *     2026-07-27 (i.e. `settings.bridges` directly). A Tor Project forum thread ("Moat
 *     circumvention/map violate the documentation by provide bridge_strings") reports the live
 *     server's actual output has NOT always matched its documented/struct shape, so this shape
 *     is kept as a fallback rather than deleted outright.
 *
 * FILTERING (fixes a real mixing bug): the array shape means moat can return recommendations for
 * MULTIPLE transports in one response (moatBody() only requests one, but nothing guarantees the
 * server honors that narrowly). Concatenating every entry's bridge_strings unconditionally — what
 * this function did right after gaining array support — means asking for obfs4 could silently
 * return snowflake lines mixed into the result, which the caller then dials as if they were obfs4
 * bridges. An entry is kept only if it carries NO `type` (the flat/legacy shape above, and the
 * documented case where a live response doesn't match rdsys's own struct, never included one) or its
 * `type` matches the requested transport; an entry that NAMES a different transport is dropped. This
 * is the only filter in the pipeline — App.tsx's obfs4 caller (resolveBridges) does not re-validate
 * the returned lines by transport the way its webtunnel/seeded-bridge sibling does, so this function
 * is the sole guard.
 */
function moatBridgeStrings(
  settings: MoatSettingsEntry | MoatSettingsEntry[] | undefined,
  transport: TransportType,
): string[] {
  const entries = Array.isArray(settings) ? settings : settings ? [settings] : [];
  return entries
    .filter(entry => {
      const type = entry?.bridges?.type;
      return type === undefined || type === transport;
    })
    .flatMap(entry => entry?.bridges?.bridge_strings ?? []);
}

/**
 * Forward an external abort signal into an attempt's own per-timeout AbortController, so a
 * source that loses fetchFreshBridges' concurrent race (see below) can be cancelled from outside
 * instead of running to its own timeout in the background. Returns a detach function so the
 * listener doesn't outlive the attempt when it settles on its own first.
 */
function linkAbort(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  external.addEventListener('abort', onAbort);
  return () => external.removeEventListener('abort', onAbort);
}

async function moatPost(
  url: string,
  body: string,
  timeoutMs: number,
  transport: TransportType,
  hostOverride?: string,
  raceCancel?: AbortSignal,
): Promise<string[]> {
  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPE,
    'Accept': CONTENT_TYPE,
  };
  if (hostOverride) {
    headers['Host'] = hostOverride;
  }
  // Same abort-on-timeout pattern as fetchOneGithubObfs4 below: without this, a losing
  // attempt's fetch keeps running in the background after we move on to the next fallback,
  // and a censored-network retry loop accumulates leaked in-flight requests over time.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // `raceCancel` fires the instant a DIFFERENT source group wins fetchFreshBridges' concurrent
  // race below — forwarding it into this attempt's own controller means a losing hop stops its
  // in-flight fetch immediately instead of idling until its own per-attempt timeoutMs.
  const detachRaceCancel = linkAbort(raceCancel, controller);
  try {
    const resp = await fetch(url, {method: 'POST', headers, body, signal: controller.signal});
    if (!resp.ok) throw new Error(`moat HTTP ${resp.status}`);
    const json = (await resp.json()) as {
      data?: Array<{settings?: MoatSettingsEntry | MoatSettingsEntry[]}>;
    };
    const lines = moatBridgeStrings(json?.data?.[0]?.settings, transport);
    if (lines.length === 0) {
      throw new Error('moat: empty bridge list');
    }
    return lines;
  } finally {
    clearTimeout(timer);
    detachRaceCancel();
  }
}

function shuffleSlice(arr: string[], n: number): string[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy.slice(0, Math.min(n, copy.length));
}

/** `ver=0.0.3` → [0,0,3]; absent/garbage → [] (sorts lowest). Used to pick a bridge's newest line. */
function parseVer(line: string): number[] {
  const m = /(?:^|\s)ver=(\d+(?:\.\d+)*)/.exec(line);
  if (!m) return [];
  return m[1]!.split('.').map(n => Number(n));
}

/** True when a > b, comparing version tuples component-wise (missing components count as 0). */
function verGreater(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Parse a collector file into usable bridge lines for ONE transport.
 *
 * Beyond the transport-prefix filter the obfs4 path always had, this now:
 *   - runs every line through `validateBridgeLine` and keeps only those the app's own parser calls
 *     that exact transport (this file is the only guard on collector output — App.tsx's obfs4
 *     caller does not re-validate), and
 *   - collapses a bridge that appears MORE THAN ONCE to its newest line. The webtunnel list carries
 *     the same fingerprint several times with different `ver=` values — the bridge's history, not
 *     several bridges — and handing arti two entries for one addr:port is at best wasted circuits
 *     and at worst a config it rejects outright. Keyed on the fingerprint (field 3), the identity
 *     that actually distinguishes bridges; the highest `ver=` wins, since an older protocol version
 *     is the one our bundled client is more likely to have dropped support for.
 */
export function githubBridgeLines(text: string, transport: TransportType): string[] {
  const best = new Map<string, string>();
  const order: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line.startsWith(`${transport} `)) continue;
    if (validateBridgeLine(line) !== transport) continue;
    // "<transport> <addr:port> <fingerprint> …" — fall back to the whole line when a collector
    // entry somehow has no third field, so an odd line de-dupes against itself rather than
    // colliding with every other odd line under a shared empty key.
    const key = line.split(/\s+/)[2] ?? line;
    const prev = best.get(key);
    if (prev === undefined) {
      best.set(key, line);
      order.push(key);
    } else if (verGreater(parseVer(line), parseVer(prev))) {
      best.set(key, line);
    }
  }
  return order.map(k => best.get(k)!);
}

async function fetchOneGithubList(
  url: string,
  timeoutMs: number,
  transport: TransportType,
  raceCancel?: AbortSignal,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // See moatPost's identical comment — cancels this mirror fetch the instant another source
  // group wins fetchFreshBridges' race, rather than idling until timeoutMs.
  const detachRaceCancel = linkAbort(raceCancel, controller);
  try {
    const resp = await fetch(url, {signal: controller.signal});
    if (!resp.ok) throw new Error(`github HTTP ${resp.status}`);
    const lines = githubBridgeLines(await resp.text(), transport);
    if (lines.length === 0) throw new Error('github: empty bridge list');
    return lines;
  } finally {
    clearTimeout(timer);
    detachRaceCancel();
  }
}

async function fetchGithubBridges(
  transport: TransportType,
  timeoutMs: number,
  raceCancel?: AbortSignal,
): Promise<string[]> {
  const urls = GITHUB_URLS[transport];
  if (!urls) throw new Error(`github: no collector list for '${transport}'`);
  let lastErr: unknown;
  for (const url of urls) {
    // Already lost the race while switching between mirror URLs (e.g. the main-branch mirror
    // just failed) — don't bother firing the master-branch mirror too.
    if (raceCancel?.aborted) throw lastErr ?? new Error('github: cancelled, another source won');
    try {
      // Return a random subset so different clients present different bridge sets, and a
      // generous 12 so enough survive the live/dead churn of a public collector.
      return shuffleSlice(await fetchOneGithubList(url, timeoutMs, transport, raceCancel), 12);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(`github: all ${transport} mirrors failed`);
}

/** Tuning for a bridge fetch. */
export interface FetchBridgesOptions {
  /**
   * Use ONLY the domain-fronted moat hop — skip the non-fronted direct and GitHub hops so the
   * device's real IP never reveals Tor-bootstrap intent to those destinations (audit #50). Set this
   * when the user has selected a censored/bridged connection mode, where hiding bootstrap intent
   * matters more than the extra reachability the direct/GitHub fallbacks buy.
   */
  frontedOnly?: boolean;
}

// Stagger, in ms, before each non-primary source group is allowed to fire (see fetchFreshBridges'
// doc comment below). Direct always starts at t=0.
const MOAT_FRONTED_STAGGER_MS = 2_000;
const GITHUB_STAGGER_MS = 4_000;

/**
 * Gate a staggered source's start on two things racing each other: its own delay elapsing, or
 * `raceCancel` firing first because a different source group already won. Resolves 'go' in the
 * former case, 'cancelled' in the latter — a 'cancelled' source must never touch the network at
 * all, not even to fire-and-abort immediately, since that would still cost the destination a
 * connection attempt for no reason.
 */
function staggerGate(delayMs: number, raceCancel: AbortSignal): Promise<'go' | 'cancelled'> {
  if (raceCancel.aborted) return Promise.resolve('cancelled');
  if (delayMs <= 0) return Promise.resolve('go');
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      raceCancel.removeEventListener('abort', onCancel);
      resolve('go');
    }, delayMs);
    const onCancel = () => {
      clearTimeout(timer);
      resolve('cancelled');
    };
    raceCancel.addEventListener('abort', onCancel);
  });
}

/**
 * Wrap one of fetchFreshBridges' three source groups behind its stagger delay. `run` is only
 * ever invoked after `staggerGate` resolves 'go' — i.e. never for a source that the race already
 * settled before its turn came up.
 */
async function staggeredSource(
  startDelayMs: number,
  raceCancel: AbortSignal,
  run: (raceCancel: AbortSignal) => Promise<string[]>,
): Promise<string[]> {
  const gate = await staggerGate(startDelayMs, raceCancel);
  if (gate === 'cancelled') {
    throw new Error('source cancelled before its stagger elapsed — another source already won');
  }
  return run(raceCancel);
}

/**
 * Fetch fresh bridge lines for the given transport from the Tor Project moat API,
 * falling back to a GitHub-hosted bridge collector when moat is blocked.
 * Defaults to WebTunnel — the preferred transport, whose bridges rotate and are not shipped
 * in the binary. Returns an empty array if all sources fail (caller falls back to the
 * bundled bridge set). Times out per attempt so a slow network doesn't block the retry cycle.
 *
 * With `frontedOnly`, only the CDN77-fronted moat hop is attempted, so the non-fronted direct and
 * GitHub hops never expose the real IP's Tor-bootstrap intent (audit #50).
 *
 * SOURCES RUN CONCURRENTLY, NOT SEQUENTIALLY (changed 2026-07-28). This function used to try
 * direct (15s timeout) then fronted (15s) then GitHub (10s x up to 2 mirrors) one after another —
 * but on a censored network, where this fetch matters most, moat-direct is blocked BY DEFINITION
 * (that is what "censored" means here), so every single call on those networks paid the full 15s
 * direct timeout before even reaching the hop that had a chance of working, with a measured worst
 * case of 40-50s of pure waiting before a bridge could dial. Sequential ordering was a strict loss
 * on exactly the networks this code exists for.
 *
 * Instead, all three source groups start concurrently, each behind a small stagger — direct at
 * t=0, fronted at t=2s, GitHub at t=4s — and the first to yield a non-empty bridge list wins;
 * `staggeredSource`/`staggerGate` cancel every source still waiting on its stagger the instant a
 * winner is known, and `raceCancel` (threaded into moatPost/fetchOneGithubList via `linkAbort`)
 * aborts any source that had already started, so a loser never runs past the moment it lost. The
 * stagger keeps the mild existing preference for moat over the GitHub collector — a clean network
 * still gets its answer from moat first — while avoiding hammering every source on every single
 * healthy fetch. If every source fails or returns empty, behavior is unchanged from before: this
 * resolves to `[]` and the caller falls back to the bundled bridge set.
 */
export async function fetchFreshBridges(
  transport: TransportType = 'webtunnel',
  opts: FetchBridgesOptions = {},
): Promise<string[]> {
  const body = moatBody(transport);
  // Fires the instant one source group wins, so every other in-flight or not-yet-started source
  // is cancelled/skipped rather than left to run to its own timeout (see doc comment above).
  const raceCancel = new AbortController();

  const attempts: Array<Promise<string[]>> = [];

  // 1. Direct — NON-fronted, exposes real IP + bootstrap intent to bridges.torproject.org. Skipped
  //    in frontedOnly mode. Starts immediately: the mildly-preferred source on a healthy network.
  if (!opts.frontedOnly) {
    attempts.push(
      staggeredSource(0, raceCancel.signal, signal =>
        moatPost(MOAT_DIRECT, body, 15_000, transport, undefined, signal),
      ),
    );
  }

  // 2. Domain-fronted via CDN77 (Host header routes to bridges.torproject.org). The only hop that
  //    hides the destination, so it is always tried. Staggered slightly behind direct — UNLESS
  //    frontedOnly, where it's the only source in play at all, so there is nothing to stagger
  //    behind and it fires immediately (staggering it there would just add a dead 2s in the one
  //    mode where hiding bootstrap intent already matters most).
  attempts.push(
    staggeredSource(opts.frontedOnly ? 0 : MOAT_FRONTED_STAGGER_MS, raceCancel.signal, signal =>
      moatPost(MOAT_FRONTED, body, 15_000, transport, 'bridges.torproject.org', signal),
    ),
  );

  // 3. GitHub bridge collector — obfs4 AND webtunnel. NON-fronted, so skipped in frontedOnly mode.
  //    webtunnel was excluded here until 2026-07-27 on the belief that the collector's WebTunnel
  //    lines "use RFC 3849 anonymised IPs and cannot be used directly"; they are not anonymised —
  //    a placeholder address is the normal shape of a webtunnel line, which is dialed by `url=`
  //    (see GITHUB_WEBTUNNEL_URLS). That mistake left webtunnel — the transport that still works
  //    against DPI that obfs4 no longer evades — with moat as its ONLY source, i.e. no source at
  //    all on the censored networks it exists for. There is no bundled webtunnel set to fall back
  //    to either (bridges.ts::DEFAULT_WEBTUNNEL_BRIDGES; Tor Project publishes no builtin one), so
  //    this hop is the difference between a webtunnel rung that can dial and one that is skipped.
  //    Staggered furthest back — least preferred, and the one most likely to be hit on every
  //    healthy fetch if it ran unconditionally at t=0.
  if (GITHUB_URLS[transport] && !opts.frontedOnly) {
    attempts.push(
      staggeredSource(GITHUB_STAGGER_MS, raceCancel.signal, signal =>
        fetchGithubBridges(transport, 10_000, signal),
      ),
    );
  }

  try {
    // Promise.any resolves with the first FULFILLED promise (moatPost/fetchGithubBridges already
    // throw rather than resolve on an empty list — see their own bodies — so "fulfilled" here
    // already means "non-empty"), and rejects only once every attempt has rejected, which is
    // exactly the "all sources failed/empty" case this returns `[]` for below.
    return await Promise.any(attempts);
  } catch {
    return [];
  } finally {
    // Cancel whatever is still pending — a losing source's late success (or late failure) has
    // nowhere left to write once this has already resolved for the caller.
    raceCancel.abort();
  }
}
