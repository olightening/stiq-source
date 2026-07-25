/**
 * What the link dialog offers, and which option carries the emphasis.
 *
 * STIQ has no in-app browser — a link leaves the app or it does not open — so the dialog's whole job
 * is to make one thing obvious: whether the browser this tap lands in keeps the visit inside Tor.
 *
 * The rule is keyed on the user's CHOSEN default (Settings → Browser), never on what happens to be
 * installed. A Tor browser sitting unused on the device does not make the next tap anonymous, so it
 * must not silence the recommendation; only actually choosing one does. Once chosen, the secure
 * option has nothing left to say and disappears, leaving "Open in my browser" alone and emphasized.
 */
import {isTorBrowserId} from './browserData';
import {classifyUrl} from '../util/url';

export interface LinkOpenPlan {
  /** Launch id for "Open in my browser"; '' hands the URL to the OS default handler instead. */
  targetId: string;
  /** Whether that target keeps the visit inside Tor. */
  targetIsSecure: boolean;
  /** Whether to offer "Open in a secure browser" at all. */
  showSecure: boolean;
  /** Which button gets the accent. */
  emphasis: 'secure' | 'mine';
  /**
   * An onion address about to be handed to a browser that cannot resolve it. Not a privacy warning —
   * a plain "this will not work", which is the more useful thing to say at that moment.
   */
  onionNeedsTor: boolean;
}

export function resolveLinkOpen(url: string, preferred: string): LinkOpenPlan {
  const targetId = preferred.trim();
  const targetIsSecure = targetId !== '' && isTorBrowserId(targetId);
  const onion = classifyUrl(url).kind === 'onion';
  return {
    targetId,
    targetIsSecure,
    showSecure: !targetIsSecure,
    emphasis: targetIsSecure ? 'mine' : 'secure',
    onionNeedsTor: onion && !targetIsSecure,
  };
}
