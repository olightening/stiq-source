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
 * obfs4-class speed. It is implemented by the bundled IPtProxy 5.5.0 (Lyrebird). WebTunnel
 * bridges are secret per-deployment and rotate, so they are fetched live from the moat API
 * (see bridgeFetch.ts) rather than hardcoded.
 *
 * DEFAULT_TRANSPORT is the zero-network fallback used when no WebTunnel bridges could be
 * fetched: obfs4 with the bundled bridge set. Slower to evade modern DPI, but needs no
 * network round-trip to start.
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
 * Fresh obfs4 bridge lines sourced from the Tor bridge collector (scriptzteam/
 * Tor-Bridges-Collector, June 2026). All use port 443 or 80 (highest firewall
 * pass-through). At runtime, pickRandom() draws 8 of these per connection so each
 * user presents a different subset — harder to enumerate, and dead bridges rotate out.
 * Refresh from bridges-obfs4 in the collector when updating the app.
 */
export const DEFAULT_OBFS4_BRIDGES: readonly string[] = [
  'obfs4 23.129.64.94:443 21F6BA217C1A9390600D62A6DA6D4D9C9F790259 cert=id1W2fU+DRDy4I+uHZW94QkW7JhEQhW0ZsG5LkFc4804Cj8kuP6oyWZjzH33rlmhSu7JTQ iat-mode=0',
  'obfs4 31.171.250.46:80 F512F63404FB824912C4E65E09EAAA0857922E31 cert=BtB/ImZly0PO+pBoIaTc+NsMHLqXxdiLamfj02hZzErcYk7mvorTpteYbjq7LscCkGwuBA iat-mode=0',
  'obfs4 5.161.69.230:443 1C9149C3BBE256360BAB6A7E44CC18AF01EFEDA3 cert=q602dyj5h+SXVTXjgbwxvwkU/UWUQNKALiD1xX6LnVULg5mzBkvX/rkLW0Bx5Z2iMRm9EA iat-mode=0',
  'obfs4 8.25.228.205:443 72B55DEF94398E24053293B635D1CC9D1EBDF33A cert=rIFUuTHmvd4QZszlhUXRqVgluvN6vg/CrJHHp5OrOQBT0rURbriWPOryHIkrSHxZgmlvAg iat-mode=0',
  'obfs4 23.129.64.98:443 9ED6BDE66619D0CA320AFEBA52C24470CDF64A04 cert=cIZdfn9ZNqFqBQtLLi8N1p5sNh7Zmn6te8Dq730ogiaQiWgYZY9s6RFMO7oei1eU9ynlAA iat-mode=0',
  'obfs4 35.228.161.144:80 3DAD1ED9F9925F7DF30F10DA5CAF94C9591A6B22 cert=fXOfSSMsjv/upmCwiApZjkfy59F0Fwz254l9sH25qCv2eM1rO+e0bBMemnvXgElCchYdcA iat-mode=0',
  'obfs4 5.188.108.24:443 487E5C3BBD6FB1374C93027AFCFFE49A822AB76E cert=ZkF5U+VMv9v6v5lH1Hbqd0JZfytBLVEoJ/2PIvTK9gbmsXfT+38lPyhfC0aP5E38iP16Ow iat-mode=0',
  'obfs4 31.171.155.9:443 4EB24590EE4731BD366E5C2446BDC1FF836FBE69 cert=CWIAYYveoSo8wHLmpyxQ4RiZbckkVyuGmzQHUV1w9LA+8ZjWotDFvJQ3nO9SqmzAhkP8FA iat-mode=0',
  'obfs4 31.171.241.104:443 9FDB72FB538B7976598CC479EE8B971542BA623C cert=6OvqdsPvPGuyassgGtwAnCMJDA2BvCN6d4gjJ80B/xCvt4MXqzgTuNLz1AybdwKZsnY5eA iat-mode=0',
  'obfs4 23.129.64.91:443 711E83753F1CDD3F28319CDA8833012F1275355A cert=LREbzThqRTC2GHtYLa33+cnRv/DwQT22QYb1iySrGjyh7aIUXwzEWMQSowkLrDgMFdNXeA iat-mode=0',
  'obfs4 5.2.73.218:443 C6F2C5ACF8AD409C6BF624DD6033CD33FEE26BF5 cert=Edm5DLOJhImfzPenR47+ojiuwYctdaluL4tW+HzXhnHWg75NttWrIn7Ew/oQhRjjPvw7Ag iat-mode=0',
  'obfs4 5.161.96.26:443 E10932B200D6B40BEE4A1657157270FC55478E52 cert=5I4q5bamAmqE+WgLOsmDqQbHEGowZFPx/k4nyP8dIE38/OylE2Ib48NE0sMkkMTW0kWAEg iat-mode=0',
  'obfs4 45.12.139.49:443 5832EF5DB63B5EAD555F3DC11D5E9B4199CCB51E cert=g7xEAnuQKnWwemHKgSZJT5Npio+JE4j36C0KApGZnqT4TMbbpGhKVDy1R91XRVn2HKF1bg iat-mode=0',
  'obfs4 20.213.236.250:443 4556C37DE0E85068789CBA33992CD56FCAADD306 cert=6tr6/nso3EZfuV2AG1Vn0di4z11EKVvnOORPJC5REviLpbToSkpqVeeDsuZ76UZAgD9nAA iat-mode=0',
  'obfs4 31.171.241.229:80 B39C11CFA14F2F44B2E12621C1A42F479763BD2E cert=CVI1m7c0793YMvqercb/e68C5oYYQktmeKsZ/Xp5w6eLw8lsxaOkZMxpvz/dGiwkahYiWA iat-mode=0',
  'obfs4 5.161.56.74:443 CF7C84294A07EEA972A999662D5C786DF96C7265 cert=IAwBU8e3yM7p8HUSabfngvSPrJoIlNxslMokzKkPYMc+IXxWIhdpIasACKEQ+4Q+wn+4dQ iat-mode=0',
  'obfs4 38.229.1.78:80 C8CBDB2464FC9804A69531437BCF2BE31FDD2EE4 cert=Hmyfd2ev46gGY7NoVxA9ngrPF2zCZtzskRTzoWXbxNkzeVnGFPWmrTtILRyqCTjHR+s9dg iat-mode=1',
  'obfs4 5.255.103.141:443 FC20BC796DCACF3F39413F5316F55D3DF4416FCD cert=F5JMei9agrZMB/QlIBdbY3RMZ0fioRyUOdTI7sBKucs7z73+1uh3gM4fKsYev2a48MOFLA iat-mode=0',
  'obfs4 8.25.228.205:80 5DE71AE5C8247CF7CF4A820489EFD013670ABA5E cert=srDN7PQHMGpoz6aVruW36C6ZPi/dIZBrtc9+iu72rE5Lg6flDROWPoiPp+3eW9Aq0zqEOQ iat-mode=0',
  'obfs4 24.211.116.166:443 1BACA82C3AC9752B01E149FD6E125DCB230F9B18 cert=NpDBe/K3F/r0Gh8zSH759+5E4XQ02PZ9BVWi+xmiyH7HSFmxsZ1ZYTyNzDQsm3AgWbRGRA iat-mode=0',
  'obfs4 14.201.215.82:443 7AE3A45F5A83B9AB91D5CF9B531104C6A3412611 cert=ztCfqQg1TKtEw96tdfr1ksniXtQV3r5JXNhyyAllS6wa/FDBl5zX+JMA7k/c1ZcuJjexKQ iat-mode=0',
  'obfs4 23.95.120.222:80 83F701FCF1454C248808D509F050F46B859AF615 cert=REQQPHuIfbiI13qDTDZJUY5QIJEEvDo2EhVuGYb4UNshy9P4jvlWPSXMnNWr57JKOl8YLA iat-mode=0',
  'obfs4 20.166.4.180:443 DE1B243F60524193CFEBC3B8FE6371DB849D3C95 cert=Akfq7/iWna9OVABEgIvsgc6pnWdv84JaCHKaYGvjHszMdeiDgoc98nwTFTU6uPTC6qdYLQ iat-mode=0',
  'obfs4 38.229.33.83:80 0BAC39417268B96B9F514E7F63FA6FBA1A788955 cert=VwEFpk9F/UN9JED7XpG1XOjm/O8ZCXK80oPecgWnNDZDv5pdkhq1OpbAH0wNqOT6H6BmRQ iat-mode=1',
  'obfs4 5.249.146.133:443 B96859D7A6DDE2F3E84BD27CAF6A2D127F4938DF cert=0Q8/DepkkPz0uy1U9oK1PvuHCmOBaYEl+WsOk5g/5+cT6M+aSsOrlOSugafGh5Yu0hzhaw iat-mode=0',
  'obfs4 45.14.112.56:80 0025551A19519A03E890D145F0A538481ED94192 cert=9hRY97T1Kx0RuE9aKjVKcOLn6QIjroBwgz35Im69HZnzkf3sARqHMf4zagmBWt7x3IVbFA iat-mode=0',
  'obfs4 23.129.64.95:443 069ACAC5ACA9B1575293B7840212875A70895366 cert=xRKDw2Ac6a1ngucPlIT3fszgeoBu1qzghe1G1bUAhFf3YBxK2Kfu5yc0sUX9Wc5YI6JUVw iat-mode=0',
  'obfs4 23.153.248.71:443 A21312A02C060D616877874B05F931A8EE5D8542 cert=Q2ffDjyHzdhBqKbCl9S6zY2mPepetLiinAK7mqdewLMZ/ZbufgJHhyizR586Y1jgPt8YJA iat-mode=0',
  'obfs4 38.186.106.55:443 A179CA6D23B2846DD287EF77D03A8698D5347409 cert=tpQGupPEp5Srscium13u174pzLrAuOLEKSOIUEsbwSvNiWHw8MuaBaRJwzV5W1yIaU9ZQA iat-mode=2',
  'obfs4 23.129.64.90:443 0DBE48B7218883A05E57237E756B622C1BCC1F7F cert=V33cEVShHItMHiT3a6AEGvYey7Jg7nc412XHzfdRX3j8lBUN94n2oFGSZ9hmM3r0jocTIA iat-mode=0',
  'obfs4 32.215.212.214:80 929DF026F1A9EE4149A649875F98A28B2D8115C3 cert=juxhRKvWW5KyT7wUAKZtCJFwcwwzQd8ERJNIWdBTgqVN/UpyXKMjJl5XXmaSaCgavaOvQg iat-mode=0',
  'obfs4 5.188.191.199:443 63A795C1B046C6DB85D8E4C09089AB2E39E26AB8 cert=6WblEDb7kwAhfzW3XLc9flbeWUGP1/vbVh9v3efiuZc0MiZf2zMfdFKPSEMnss+cKY8cJw iat-mode=0',
  'obfs4 31.25.239.133:443 AB1F924F90723494D7BFBEEB16B171F1436DD6F3 cert=ev13D685CfUEQXrhpxGqxYDV9u36UAKbRidWEls5G5jAhffVpDGQ4BmBpO2IGDfTxrYzXQ iat-mode=0',
  'obfs4 5.78.75.182:443 2C56F1C0B9022EFDE1EBEED61A8F97233004F42F cert=wd6cKO7/b5HSU4y1shwRwPiXZvhzbIYqOwFYxFuc4BbX1RoC92ctpAgf9UfqXNs4am+rGg iat-mode=0',
];

/**
 * Snowflake bridge lines — current Tor Browser built-in defaults (tor-browser-build
 * pt_config.json, Bug 41574, Oct 2025). Both bridges share the same CDN77 broker front;
 * they differ only in relay IP/fingerprint.
 *
 * The `ice=` list MUST carry multiple STUN servers: NAT traversal for the WebRTC rendezvous
 * needs several reachable STUN endpoints. A single STUN server (e.g. only Google's) makes
 * the rendezvous fail when that one is rate-limited or blocked — Tor then stalls at
 * "Bootstrapped 10% (conn_done)" because it connected to the PT but never found a proxy.
 */
const SNOWFLAKE_BROKER =
  'url=https://1098762253.rsc.cdn77.org/ ' +
  'fronts=www.cdn77.com,www.phpmyadmin.net ' +
  'ice=stun:stun.l.google.com:19302,stun:stun.antisip.com:3478,' +
  'stun:stun.bluesip.net:3478,stun:stun.dus.net:3478,stun:stun.epygi.com:3478,' +
  'stun:stun.sonetel.com:3478,stun:stun.uls.co.za:3478,stun:stun.voipgate.com:3478,' +
  'stun:stun.voys.nl:3478 utls-imitate=hellorandomizedalpn';

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
 * hardcoded set — it fetches live WebTunnel bridges from the moat API at startup
 * (bridgeFetch.ts). Provision private WebTunnel bridges out of band and paste them here only
 * if you want a zero-network bootstrap path. Format:
 *   webtunnel <ip>:443 <FINGERPRINT> url=https://<domain>/<path> ver=0.0.2
 */
export const DEFAULT_WEBTUNNEL_BRIDGES: readonly string[] = [];

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
    default:
      return [...DEFAULT_OBFS4_BRIDGES];
  }
}

/**
 * The torrc lines this module is responsible for: enable bridges and list them.
 * The native layer prepends the matching `ClientTransportPlugin <transport> exec <path>`.
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
    ...(opts?.onionAuthExtra && opts.onionAuthExtra.length > 0
      ? {onionAuthExtra: opts.onionAuthExtra}
      : {}),
    ...(opts?.dormancy ? {dormancy: true} : {}),
  };
}
