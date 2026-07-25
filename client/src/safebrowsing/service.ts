/**
 * App-wide link-reputation binding (mirrors [[../media/mediaService]]): a checker bound to the live
 * TorManager + the joined community's relay, which proxies the Google Safe Browsing prefix lookup.
 *
 * PARKED — nothing calls this today. Its only consumer was the in-app browser, which gated a page on
 * the verdict before rendering it; with links now handed straight to an external browser there is no
 * moment we control in which to show a threat interstitial. The relay endpoint is still live and this
 * client implementation (with its spec-vector tests) is kept intact deliberately, so the check can be
 * reinstated — e.g. inside the link dialog — without rebuilding it.
 */
import type {ThreatVerdict} from './check';

export type LinkChecker = (url: string) => Promise<ThreatVerdict>;

let current: LinkChecker | null = null;

export function setLinkChecker(checker: LinkChecker | null): void {
  current = checker;
}

export function getLinkChecker(): LinkChecker | null {
  return current;
}
