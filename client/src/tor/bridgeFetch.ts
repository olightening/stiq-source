/**
 * Bridge fetcher — queries the Tor Project moat/circumvention API for fresh bridge lines
 * (WebTunnel or obfs4) when the bundled bridges are absent or fail to connect.
 *
 * Tries three sources in order:
 *   1. Direct HTTPS to bridges.torproject.org (works on uncensored networks)
 *   2. Domain-fronted via the CDN77 edge (same CDN front used by Snowflake) — the TCP
 *      connection goes to cdn77.com but the Host header routes the request to the Tor
 *      Project's moat service, bypassing DNS/SNI-level blocking.
 *   3. GitHub raw bridge-collector (scriptzteam/Tor-Bridges-Collector) — a community repo
 *      that polls the official Tor distribution hourly and commits fresh bridge lines.
 *      raw.githubusercontent.com is a CDN-served static file, reachable on most ISPs
 *      even when bridges.torproject.org is fully blocked. Returns a random 10-line subset
 *      so different clients present different bridge sets.
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
 */
import type {TransportType} from './types';

const MOAT_PATH = '/moat/circumvention/settings';
const MOAT_DIRECT = `https://bridges.torproject.org${MOAT_PATH}`;
const MOAT_FRONTED = `https://1098762253.rsc.cdn77.org${MOAT_PATH}`;
// Community obfs4 bridge collectors, tried in order. The scriptzteam repo has used both `main`
// and `master` as its default branch over its life, and raw.githubusercontent.com serves them
// at different ref paths — listing both means a branch rename can't silently break the fetch.
const GITHUB_OBFS4_URLS = [
  'https://raw.githubusercontent.com/scriptzteam/Tor-Bridges-Collector/main/bridges-obfs4',
  'https://raw.githubusercontent.com/scriptzteam/Tor-Bridges-Collector/master/bridges-obfs4',
] as const;

const CONTENT_TYPE = 'application/vnd.api+json';

function moatBody(transport: TransportType): string {
  return JSON.stringify({
    data: [{version: '0.1.0', settings: [], transports: [transport]}],
  });
}

async function moatPost(
  url: string,
  body: string,
  timeoutMs: number,
  hostOverride?: string,
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
  try {
    const resp = await fetch(url, {method: 'POST', headers, body, signal: controller.signal});
    if (!resp.ok) throw new Error(`moat HTTP ${resp.status}`);
    const json = (await resp.json()) as {
      data?: Array<{settings?: {bridges?: {bridge_strings?: string[]}}}>;
    };
    const lines = json?.data?.[0]?.settings?.bridges?.bridge_strings;
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error('moat: empty bridge list');
    }
    return lines;
  } finally {
    clearTimeout(timer);
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

async function fetchOneGithubObfs4(url: string, timeoutMs: number): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {signal: controller.signal});
    if (!resp.ok) throw new Error(`github HTTP ${resp.status}`);
    const text = await resp.text();
    const lines = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('obfs4 '));
    if (lines.length === 0) throw new Error('github: empty bridge list');
    return lines;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGithubObfs4Bridges(timeoutMs: number): Promise<string[]> {
  let lastErr: unknown;
  for (const url of GITHUB_OBFS4_URLS) {
    try {
      // Return a random subset so different clients present different bridge sets, and a
      // generous 12 so enough survive the live/dead churn of a public collector.
      return shuffleSlice(await fetchOneGithubObfs4(url, timeoutMs), 12);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('github: all obfs4 mirrors failed');
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

/**
 * Fetch fresh bridge lines for the given transport from the Tor Project moat API,
 * falling back to a GitHub-hosted bridge collector when moat is blocked.
 * Defaults to WebTunnel — the preferred transport, whose bridges rotate and are not shipped
 * in the binary. Returns an empty array if all sources fail (caller falls back to the
 * bundled bridge set). Times out per attempt so a slow network doesn't block the retry cycle.
 *
 * With `frontedOnly`, only the CDN77-fronted moat hop is attempted, so the non-fronted direct and
 * GitHub hops never expose the real IP's Tor-bootstrap intent (audit #50).
 */
export async function fetchFreshBridges(
  transport: TransportType = 'webtunnel',
  opts: FetchBridgesOptions = {},
): Promise<string[]> {
  const body = moatBody(transport);

  // 1. Direct — NON-fronted, exposes real IP + bootstrap intent to bridges.torproject.org. Skipped
  //    in frontedOnly mode.
  if (!opts.frontedOnly) {
    try {
      return await moatPost(MOAT_DIRECT, body, 15_000);
    } catch {
      // blocked or slow — try domain-fronted
    }
  }

  // 2. Domain-fronted via CDN77 (Host header routes to bridges.torproject.org). The only hop that
  //    hides the destination, so it is always tried.
  try {
    return await moatPost(MOAT_FRONTED, body, 15_000, 'bridges.torproject.org');
  } catch {
    // both moat endpoints failed
  }

  // 3. GitHub bridge collector — only for obfs4 (WebTunnel lines in that repo use RFC 3849
  //    anonymised IPs and cannot be used directly). NON-fronted, so skipped in frontedOnly mode.
  if (transport === 'obfs4' && !opts.frontedOnly) {
    try {
      return await fetchGithubObfs4Bridges(10_000);
    } catch {
      // github also unreachable — caller will use bundled bridges
    }
  }

  return [];
}
