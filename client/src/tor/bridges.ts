/**
 * Bridge / pluggable-transport configuration (PLAN.md §3.2).
 *
 * The app defaults to obfs4 bridges to disguise Tor traffic as random bytes and bypass
 * DPI; Snowflake is the togglable second transport (looks like WebRTC). The native layer
 * owns the `ClientTransportPlugin` line (it knows the bundled PT binary path); this module
 * produces the `UseBridges` + `Bridge` lines from the configured bridge set.
 */
import type {TransportType, TorStartConfig} from './types';

/**
 * PREFERRED_TRANSPORT is what the app tries FIRST: WebTunnel wraps Tor in
 * WebSocket-over-HTTPS to a real website on :443, so to a censor it is indistinguishable
 * from ordinary HTTPS browsing (no obfs4-style "random bytes" fingerprint) while keeping
 * obfs4-class speed. WebTunnel bridges are secret per-deployment and rotate, so they are
 * fetched live from the moat API (see bridgeFetch.ts) rather than hardcoded.
 *
 * IMPLEMENTED under Arti as of 2026-07-27 (this paragraph previously said the opposite and was
 * stale): `build-pt.sh` builds the upstream webtunnel client as `libWebtunnel.so`, it is present in
 * android/app/src/main/jniLibs for both shipped ABIs, `pt.rs::binary_for()` maps "webtunnel" →
 * `libWebtunnel.so`, and "webtunnel" is in its `KNOWN_TRANSPORTS`. Nothing about this transport is
 * a stub any more; what still limits it is BRIDGE SUPPLY, not the binary — see
 * DEFAULT_WEBTUNNEL_BRIDGES below.
 *
 * DEFAULT_TRANSPORT is the zero-network fallback used when no WebTunnel bridges could be
 * fetched: obfs4 with the bundled bridge set. Slower to evade modern DPI, but needs no
 * network round-trip to start, and is the only transport arti-ffi actually ships a PT binary for.
 */
export const PREFERRED_TRANSPORT: TransportType = 'webtunnel';
export const DEFAULT_TRANSPORT: TransportType = 'obfs4';

/**
 * Bridge-transport fallback ladder, most-preferred (fastest) first. The connect cascade walks
 * DOWN this ladder: when a transport reaches Tor but its onion rendezvous keeps failing
 * (throttled or blocked circuits), the app escalates to the next tier instead of looping on a
 * dead transport forever. `direct` is intentionally NOT in this list — it is tried first, ahead
 * of any bridge tier, and is governed separately (it carries no bridges and is skipped on
 * networks that block direct onion circuits).
 *
 *   webtunnel — HTTPS-disguised, obfs4-class speed; best when its bridges can be fetched.
 *   obfs4     — random-bytes DPI evasion; bundled bridge pool needs no network to start.
 *   snowflake — WebRTC; slowest/flakiest but reaches the network where the others are blocked.
 */
export const BRIDGE_LADDER: readonly TransportType[] = ['webtunnel', 'obfs4', 'snowflake'];

/** Default local SOCKS port request (0 = let Tor pick a free port). */
export const DEFAULT_SOCKS_PORT = 0;

/**
 * Bundled obfs4 bridge lines — Tor Project's OWN curated "built-in bridges" set, not a
 * third-party scrape. Source: the moat "builtin" endpoint
 * (https://bridges.torproject.org/moat/circumvention/builtin) — the same endpoint Tor
 * Browser's and Orbot's "select a built-in bridge" pickers call, and what `Bridge` lines
 * Tor Browser itself ships. `bridges.torproject.org` does not resolve from this dev
 * sandbox (nor does gitlab.torproject.org), so these 11 lines were taken verbatim from
 * guardianproject/orbot-android's vendored snapshot of that exact endpoint's JSON response
 * (orbotservice/src/main/assets/builtin-bridges.json — its scripts/update-bridges.sh is
 * literally `wget https://bridges.torproject.org/moat/circumvention/builtin`), commit-dated
 * 2025-09-16. To refresh: re-fetch that URL directly once it's reachable, or re-pull
 * Orbot's file and diff. Each line below was checked by hand AND with a script against
 * torSettings.ts's OBFS4_RE (see the "DEFAULT_OBFS4_BRIDGES sanity" describe block in
 * bridges.test.ts, which now asserts it for every entry on every test run).
 *
 * Replaces a 30-line scriptzteam/Tor-Bridges-Collector scrape (a bulk, unvetted community
 * collection — see bridgeFetch.ts's GITHUB_OBFS4_URLS for where that source is still used,
 * appropriately, as a live runtime fallback) that field-testing on 2026-07-27 found 100%
 * dead: 2 of its 8 shipped hosts actively refused the connection (ECONNREFUSED in ~4ms —
 * retired hosts) and the rest timed out; a further 16 sampled fresh from the same collector
 * were also all unreachable. A dead bundled bridge is worse than no bundled bridge — it
 * costs a real user connect-time attempting it — so 11 genuinely Tor-published bridges beat
 * 30 unverified ones. Unlike the old set, these are NOT uniformly on :443/:80 — Tor's own
 * curated list deliberately mixes in high ports (including :22, hiding behind SSH's usual
 * port) and that diversity is intentional, not a mistake to "fix".
 *
 * pickRandom() draws a random subset of these per connection so each user presents a
 * different subset. NOTE: this pool is only 11 wide (was 30) — an 8-of-11 draw overlaps
 * heavily across users, so enumeration-resistance is weaker than before. That old
 * resistance was worthless anyway once every entry behind it was dead; prefer widening this
 * list with more Tor Project-sourced entries over padding it back out with scraped ones.
 */
export const DEFAULT_OBFS4_BRIDGES: readonly string[] = [
  'obfs4 85.31.186.98:443 011F2599C0E9B27EE74B353155E244813763C3E5 cert=ayq0XzCwhpdysn5o0EyDUbmSOx3X/oTEbzDMvczHOdBJKlvIdHHLJGkZARtT4dcBFArPPg iat-mode=0',
  'obfs4 146.57.248.225:22 10A6CD36A537FCE513A322361547444B393989F0 cert=K1gDtDAIcUfeLqbstggjIw2rtgIKqdIhUlHp82XRqNSq/mtAjp1BIC9vHKJ2FAEpGssTPw iat-mode=0',
  'obfs4 85.31.186.26:443 91A6354697E6B02A386312F68D82CF86824D3606 cert=PBwr+S8JTVZo6MPdHnkTwXJPILWADLqfMGoVvhZClMq/Urndyd42BwX9YFJHZnBB3H0XCw iat-mode=0',
  'obfs4 37.218.245.14:38224 D9A82D2F9C2F65A18407B1D2B764F130847F8B5D cert=bjRaMrr1BRiAW8IE9U5z27fQaYgOhX1UCmOpg2pFpoMvo6ZgQMzLsaTzzQNTlm7hNcb+Sg iat-mode=0',
  'obfs4 209.148.46.65:443 74FAD13168806246602538555B5521A0383A1875 cert=ssH+9rP8dG2NLDN2XuFw63hIO/9MNNinLmxQDpVa+7kTOa9/m+tGWT1SmSYpQ9uTBGa6Hw iat-mode=0',
  'obfs4 45.145.95.6:27015 C5B7CD6946FF10C5B3E89691A7D3F2C122D2117C cert=TD7PbUO0/0k6xYHMPW3vJxICfkMZNdkRrb63Zhl5j9dW3iRGiCx0A7mPhe5T2EDzQ35+Zw iat-mode=0',
  'obfs4 192.95.36.142:443 CDF2E852BF539B82BD10E27E9115A31734E378C2 cert=qUVQ0srL1JI/vO6V6m/24anYXiJD3QP2HgzUKQtQ7GRqqUvs7P+tG43RtAqdhLOALP7DJQ iat-mode=1',
  'obfs4 51.222.13.177:80 5EDAC3B810E12B01F6FD8050D2FD3E277B289A08 cert=2uplIpLQ0q9+0qMFrK5pkaYRDOe460LL9WHBvatgkuRr/SL31wBOEupaMMJ6koRE6Ld0ew iat-mode=0',
  'obfs4 193.11.166.194:27020 86AC7B8D430DAC4117E9F42C9EAED18133863AAF cert=0LDeJH4JzMDtkJJrFphJCiPqKx7loozKN7VNfuukMGfHO0Z8OGdzHVkhVAOfo1mUdv9cMg iat-mode=0',
  'obfs4 193.11.166.194:27025 1AE2C08904527FEA90C4C4F8C1083EA59FBC6FAF cert=ItvYZzW5tn6v3G4UnQa6Qz04Npro6e81AP70YujmK/KXwDFPTs3aHXcHp4n8Vt6w/bv8cA iat-mode=0',
  'obfs4 193.11.166.194:27015 2D82C2E354D531A68469ADF7F878FA6060C6BACA cert=4TLQPJrTSaDffMK7Nbao6LC7G9OW/NHkUwIdjLSS3KYf0Nv4/nQiiI8dY2TcsQx01NniOg iat-mode=0',
];

/**
 * Snowflake bridge lines — current Tor Browser built-in defaults (tor-browser-build
 * pt_config.json). Both bridges share the same CDN77 broker front; they differ only in
 * relay IP/fingerprint (both are TEST-NET-1 placeholder IPs — the real rendezvous never
 * dials them directly, see the WebRTC/broker flow this PT implements).
 *
 * The `url=` broker and the two relay IP/fingerprint pairs have been stable for a long
 * time; `fronts=` (the domain-fronting front list) is what actually churns — a CDN
 * discontinues fronting, or a specific front domain gets blocked/reassigned, so Tor
 * Project swaps it every few months. `fronts=` (plural) is confirmed still the correct
 * key: Snowflake's client accepts the legacy singular `front=` (one domain) too, but every
 * source below — old and new — uses the plural, comma-separated form, so no rename is
 * needed here. History, most recent first (gitlab.torproject.org and
 * bridges.torproject.org do not resolve from this dev sandbox, so this is pieced together
 * from tbb-commits/tor-commits mailing-list mirrors of the gitlab commit notifications,
 * cross-checked against guardianproject/orbot-android's vendored snapshot of the live moat
 * "builtin" endpoint for the pre-2025-10 state):
 *   - 2025-10-22 (tor-browser-build Bug 41609, "Use new CDN77 fronts for snowflake"):
 *     fronts= -> app.datapacket.com,www.datapacket.com; url= back to the same
 *     1098762253.rsc.cdn77.org used before Bug 41574 below. This is what's shipped here.
 *   - 2025-10-06 (Bug 41574, "Update Snowflake builtin bridge lines"): a brief detour to a
 *     Netlify front (url=...netlify.app/, fronts=vuejs.org) — superseded 16 days later by
 *     41609 above, so NOT what's shipped here.
 *   - <=2025-09-16: fronts=www.cdn77.com,www.phpmyadmin.net (confirmed via Orbot's
 *     vendored snapshot of https://bridges.torproject.org/moat/circumvention/builtin dated
 *     that day) — this is what this file had until this pass, i.e. it was already one Tor
 *     Project rotation behind (three, counting the 41574 detour) despite citing "Bug
 *     41574" in this comment; that citation was stale/wrong the moment 41609 landed.
 *
 * The `ice=` list MUST carry multiple STUN servers: NAT traversal for the WebRTC rendezvous
 * needs several reachable STUN endpoints. A single STUN server (e.g. only Google's) makes
 * the rendezvous fail when that one is rate-limited or blocked — Tor then stalls at
 * "Bootstrapped 10% (conn_done)" because it connected to the PT but never found a proxy.
 * The list below is Orbot's 2025-09-16 vendored snapshot (see above) of Tor's own list —
 * it replaces this file's previous ad hoc list (stun.l.google.com/bluesip.net/dus.net/
 * sonetel.com/voys.nl), none of which actually appear in Tor Project's own vendored copy.
 * The Bug 41574 commit message (mailing-list summary only, NOT independently confirmed
 * against a primary fetch the way fronts= above was) reports trimming this further —
 * dropping stun.antisip.com and one of the two stun.nextcloud.com entries, 8 -> 6 — but
 * rather than guess which exact 6 survive, this ships the fully-verified 8-entry pre-trim
 * set: STUN redundancy just needs several reachable servers, not this exact set, so two
 * extra real (if possibly since-retired) entries cost a wasted lookup at worst, whereas
 * guessing wrong at a cut risks losing one that still works.
 *
 * NO `ampcache=` HERE, AND THAT MATCHES UPSTREAM — do not "add it" as a fallback. Verified
 * 2026-07-28 against two independent mailing-list mirrors of the Bug 41609 commit (the current
 * state of tor-browser-build's pt_config.json, the exact file Tor Browser itself consumes): the
 * builtin Snowflake line carries only url=/fronts=/ice=/utls-imitate=, never ampcache=. AMP-cache
 * IS still a real, separate Snowflake rendezvous METHOD (Orbot exposes it as its own menu entry),
 * but it has never been a field on the builtin domain-fronting bridge line — bolting one on here
 * would be exactly the invented-field failure this file's sourcing discipline exists to prevent.
 */
const SNOWFLAKE_BROKER =
  'url=https://1098762253.rsc.cdn77.org/ ' +
  'fronts=app.datapacket.com,www.datapacket.com ' +
  'ice=stun:stun.antisip.com:3478,stun:stun.epygi.com:3478,' +
  'stun:stun.uls.co.za:3478,stun:stun.voipgate.com:3478,stun:stun.mixvoip.com:3478,' +
  'stun:stun.nextcloud.com:3478,stun:stun.bethesda.net:3478,stun:stun.nextcloud.com:443 ' +
  'utls-imitate=hellorandomizedalpn';

export const DEFAULT_SNOWFLAKE_BRIDGES: readonly string[] = [
  'snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 ' +
    'fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 ' +
    SNOWFLAKE_BROKER,
  'snowflake 192.0.2.4:80 8838024498816A039FCBBAB14E6F40A0843051FA ' +
    'fingerprint=8838024498816A039FCBBAB14E6F40A0843051FA ' +
    SNOWFLAKE_BROKER,
];

/**
 * WebTunnel bridge lines. These are secret per-deployment and rotate frequently (a public,
 * well-known WebTunnel bridge gets its domain blocked quickly), so the app does NOT ship a
 * hardcoded set — it fetches live WebTunnel bridges at startup (bridgeFetch.ts). Provision private
 * WebTunnel bridges out of band and paste them here only if you want a zero-network bootstrap path.
 * Format (VERIFIED against real published lines, 2026-07-27 — see below):
 *   webtunnel <addr>:443 <FINGERPRINT> url=https://<domain>/<path> ver=0.0.3
 *
 * EMPTY IS NOT AN OVERSIGHT, AND IT IS NOT FIXABLE BY COPYING TOR PROJECT'S BUILT-IN SET: there is
 * no built-in webtunnel set to copy. Tor's own "builtin" moat endpoint — the one Tor Browser's and
 * Orbot's "select a built-in bridge" pickers call, and the source of DEFAULT_OBFS4_BRIDGES above —
 * returns exactly three keys: `obfs4`, `snowflake`, `meek-azure` (re-fetched 2026-07-27 through
 * Orbot's vendored snapshot of that endpoint, which is a verbatim `wget` of it). WebTunnel is
 * distributed ONLY per-request through BridgeDB/moat, by design: its whole security property is
 * that its front domain is not on a list a censor can enumerate, which a hardcoded builtin set
 * would immediately destroy for every user at once.
 *
 * So the reachability work for webtunnel belongs in the FETCH path, not here — bridgeFetch.ts now
 * has three sources for it (direct moat, CDN77-fronted moat, and the GitHub collector), and
 * bridgeCache.ts persists whatever any of them returns for 24h so a later launch on a network where
 * moat is blocked can still dial webtunnel.
 *
 * NOTE on the address field: real webtunnel lines routinely carry a PLACEHOLDER address — an
 * RFC 3849 `[2001:db8:…]:443` documentation IPv6, occasionally an RFC 1918 IPv4 — because the
 * webtunnel client dials the `url=` over HTTPS and never connects to that address. It exists only
 * to give tor a unique addr:port key for its bridge bookkeeping. A placeholder address here is
 * therefore NORMAL and must not be treated as a malformed or anonymised (unusable) line.
 */
export const DEFAULT_WEBTUNNEL_BRIDGES: readonly string[] = [];

/**
 * NOTE on meek_lite (HTTPS domain-fronting): the native layer accepts it (pt.rs's KNOWN_TRANSPORTS,
 * served by the same libLyrebird.so as obfs4), but `TransportType` deliberately does NOT admit it,
 * so there is no DEFAULT_MEEK_BRIDGES constant here and no ladder rung for it. There would be
 * nothing to put in such a constant anyway: a meek_lite bridge needs an operator-run CDN front plus
 * a real bridge behind it, and the classic public option — Tor Project's Azure-fronted
 * "meek-azure" — was discontinued years ago over CDN egress cost, so there is no current TPO-run
 * public endpoint to hardcode. Exposing meek_lite is a deliberate cross-module piece of work (every
 * `Record<TransportType, …>` in the app gains an arm, including one in app/screens/, outside this
 * module); see the subset note on `TransportType` in ./types for the full cost, and lyrebird's
 * transports/meeklite/README.md for the url=/front=/targets= bridge-line grammar it would need.
 */

/**
 * Fisher-Yates shuffle returning a random n-element subset of arr.
 * Pass the full bridge list; Tor receives a random 8-bridge subset per connect
 * so each user looks different and dead bridges rotate out naturally.
 */
export function pickRandom<T>(arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy.slice(0, Math.min(n, copy.length));
}

/** The default bridge lines for a transport. `direct` uses no bridges at all. */
export function defaultBridgeLines(transport: TransportType): string[] {
  switch (transport) {
    case 'direct':
      return [];
    case 'snowflake':
      return [...DEFAULT_SNOWFLAKE_BRIDGES];
    case 'webtunnel':
      return [...DEFAULT_WEBTUNNEL_BRIDGES];
    // `default` is obfs4's arm, so any transport NOT cased above silently receives obfs4 bridge
    // lines. That is correct only while every other TransportType member genuinely wants them. If
    // TransportType ever gains a member with a different bridge-line shape (meek_lite's url=/front=
    // grammar has nothing in common with obfs4's cert=/iat-mode=), give it its own case here —
    // otherwise it gets handed lines it cannot parse, with no error.
    default:
      return [...DEFAULT_OBFS4_BRIDGES];
  }
}

/**
 * Produces `UseBridges 1` + `Bridge <line>` in classic torrc syntax. This was never accurate for the
 * native layer even under C-tor (it ran obfs4/snowflake via an in-process IPtProxy Controller, not a
 * `ClientTransportPlugin ... exec <path>` torrc line), and it is not what today's Arti pipeline
 * consumes either: `buildStartConfig` below sends the RAW bridge line strings straight through
 * `TorStartConfig.bridgeLines` to StiqArtiModule.kt, which marshals them into the JSON `arti_start()`
 * takes; on the Rust side, `arti-ffi/src/pt.rs::configure()` parses each one directly with
 * `BridgeConfigBuilder::from_str` — no torrc text, no `ClientTransportPlugin` line, ever assembled.
 * tor-ptmgr instead spawns the PT binary itself from `nativeLibraryDir` (see pt.rs's module doc).
 * This function's torrc-formatted output is unused by that pipeline; kept (and still tested) only as
 * a small, self-contained utility in case something ever needs literal torrc lines again.
 */
export function buildTorrcBridgeLines(bridgeLines: string[]): string[] {
  if (bridgeLines.length === 0) {
    throw new Error('refusing to enable bridges with an empty bridge list');
  }
  return ['UseBridges 1', ...bridgeLines.map(line => `Bridge ${line}`)];
}

/** Assemble a complete start config, falling back to the transport's default bridges. */
export function buildStartConfig(opts?: {
  transport?: TransportType;
  bridgeLines?: string[];
  socksPort?: number;
  dataDir?: string;
  onionAuth?: TorStartConfig['onionAuth'];
  /**
   * Bare relay onion host for the native reachability probe — set for PUBLIC communities too, not
   * only auth-gated ones (see TorStartConfig.relayOnion). Omitted from the emitted config when
   * empty/absent so a config without a known relay is byte-identical to before the field existed.
   */
  relayOnion?: string;
  onionAuthExtra?: TorStartConfig['onionAuthExtra'];
  dormancy?: boolean;
}): TorStartConfig {
  const transport = opts?.transport ?? DEFAULT_TRANSPORT;
  const bridgeLines =
    opts?.bridgeLines && opts.bridgeLines.length > 0
      ? opts.bridgeLines
      : defaultBridgeLines(transport);
  return {
    transport,
    bridgeLines,
    socksPort: opts?.socksPort ?? DEFAULT_SOCKS_PORT,
    dataDir: opts?.dataDir,
    ...(opts?.onionAuth ? {onionAuth: opts.onionAuth} : {}),
    ...(opts?.relayOnion ? {relayOnion: opts.relayOnion} : {}),
    ...(opts?.onionAuthExtra && opts.onionAuthExtra.length > 0
      ? {onionAuthExtra: opts.onionAuthExtra}
      : {}),
    ...(opts?.dormancy ? {dormancy: true} : {}),
  };
}
