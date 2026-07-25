/**
 * The rule that decides what the link dialog offers.
 *
 * The load-bearing claim is the one in the module header: the secure-browser recommendation retires
 * on the user's CHOICE, never on what is merely installed. These tests pin that distinction, because
 * the old in-app browser got it the other way round — it forced Tor whenever Tor Browser was present
 * — and quietly reintroducing that behavior would make the recommendation impossible to dismiss.
 */
import {resolveLinkOpen} from './linkOpen';

const HTTPS = 'https://example.com/article';
const ONION = 'http://expyuzz4wqqyqhjn.onion/about';
const TOR = 'org.torproject.torbrowser';
const CHROME = 'com.android.chrome';

describe('resolveLinkOpen', () => {
  it('with no default chosen: offers the secure browser, emphasizes it, hands off to the OS', () => {
    const plan = resolveLinkOpen(HTTPS, '');
    expect(plan.targetId).toBe('');
    expect(plan.targetIsSecure).toBe(false);
    expect(plan.showSecure).toBe(true);
    expect(plan.emphasis).toBe('secure');
  });

  it('keeps recommending a secure browser when the chosen default is not one', () => {
    const plan = resolveLinkOpen(HTTPS, CHROME);
    expect(plan.targetId).toBe(CHROME);
    expect(plan.showSecure).toBe(true);
    expect(plan.emphasis).toBe('secure');
  });

  it('retires the secure option once a Tor browser IS the default, and moves the emphasis', () => {
    const plan = resolveLinkOpen(HTTPS, TOR);
    expect(plan.targetIsSecure).toBe(true);
    expect(plan.showSecure).toBe(false);
    expect(plan.emphasis).toBe('mine');
  });

  it('treats every browser in the catalogue as secure, not just the stable channel', () => {
    expect(resolveLinkOpen(HTTPS, 'org.torproject.torbrowser_alpha').showSecure).toBe(false);
    expect(resolveLinkOpen(HTTPS, 'onionbrowser').showSecure).toBe(false);
  });

  it('warns that an onion address is about to go to a browser that cannot resolve it', () => {
    expect(resolveLinkOpen(ONION, CHROME).onionNeedsTor).toBe(true);
    expect(resolveLinkOpen(ONION, '').onionNeedsTor).toBe(true);
  });

  it('says nothing about onion when the default can actually open it', () => {
    expect(resolveLinkOpen(ONION, TOR).onionNeedsTor).toBe(false);
  });

  it('never flags an ordinary https link as needing Tor', () => {
    expect(resolveLinkOpen(HTTPS, CHROME).onionNeedsTor).toBe(false);
  });

  it('tolerates a padded stored preference', () => {
    const plan = resolveLinkOpen(HTTPS, `  ${TOR}  `);
    expect(plan.targetId).toBe(TOR);
    expect(plan.showSecure).toBe(false);
  });

  it('treats a whitespace-only preference as unset', () => {
    expect(resolveLinkOpen(HTTPS, '   ').targetId).toBe('');
  });
});
