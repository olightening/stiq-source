/**
 * LinkDialog — the interstitial that replaced the in-app browser.
 *
 * Since STIQ no longer renders web content itself, this dialog is the last thing standing between a
 * tap and a stranger's server learning the reader's IP. These tests hold it to the promises in its
 * header: that the secure-browser option is offered until a secure browser is actually chosen as the
 * default and not a moment longer, that "Open in my browser" launches the CHOSEN browser (falling
 * back to the OS handler when there is none), and that a refused launch says so instead of failing
 * silently — the exact way this feature broke before.
 *
 * `LinkDialogBody` isn't exported: it is reachable only through the always-mounted `<LinkDialogHost/>`
 * + `openLinkDialog()`, exactly as the real app wires it.
 */
import 'react-native';
import React from 'react';
import {Linking, Platform} from 'react-native';
import renderer, {act} from 'react-test-renderer';

// The browser natives (package enumeration + launching) don't exist under Jest; drive them here.
jest.mock('../browser/browserData', () => ({
  ...jest.requireActual('../browser/browserData'),
  isBrowserInstalled: jest.fn(async () => false),
  listInstalledBrowsers: jest.fn(async () => []),
  openInBrowser: jest.fn(async () => true),
}));

import {isBrowserInstalled, listInstalledBrowsers, openInBrowser} from '../browser/browserData';
import {getPreferredBrowser, setPreferredBrowserRuntime} from '../browser/browserSettings';
import {LinkDialogHost} from './LinkDialog';
import {openLinkDialog} from './openLink';

const mockInstalled = isBrowserInstalled as jest.Mock;
const mockList = listInstalledBrowsers as jest.Mock;
const mockOpen = openInBrowser as jest.Mock;

const TOR = 'org.torproject.torbrowser';
const CHROME = 'com.android.chrome';

// The first test pays a one-time cold Babel/transform cost for react-native + react-test-renderer
// that can exceed Jest's 5s default on a cold cache.
jest.setTimeout(20000);

/** Concatenated text under a node (react-test-renderer), numbers included. */
function textOf(node: renderer.ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c: unknown): c is string | number => typeof c === 'string' || typeof c === 'number')
    .map(String)
    .join('');
}

function pressables(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance[] {
  return tree.root.findAll(n => typeof n.props?.onPress === 'function');
}

/** Press the TIGHTEST pressable containing `label` — the backdrop/card wrappers are pressable too. */
function press(tree: renderer.ReactTestRenderer, label: string): void {
  const matches = pressables(tree).filter(n => textOf(n).includes(label));
  if (matches.length === 0) throw new Error(`no pressable containing "${label}"`);
  const target = matches.reduce((a, b) => (textOf(a).length <= textOf(b).length ? a : b));
  act(() => {
    target.props.onPress();
  });
}

async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function open(url: string, title?: string): Promise<renderer.ReactTestRenderer> {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<LinkDialogHost />);
  });
  act(() => {
    openLinkDialog({url, title});
  });
  await flush();
  return tree!;
}

describe('LinkDialog (via LinkDialogHost)', () => {
  let openURL: jest.SpyInstance;

  beforeEach(() => {
    Platform.OS = 'android';
    setPreferredBrowserRuntime('');
    mockInstalled.mockReset().mockResolvedValue(false);
    mockList.mockReset().mockResolvedValue([]);
    mockOpen.mockReset().mockResolvedValue(true);
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });

  afterEach(() => {
    openURL.mockRestore();
    setPreferredBrowserRuntime('');
  });

  it('shows the destination and both ways out when no default is chosen', async () => {
    const tree = await open('https://example.com/a', 'An article');
    const text = textOf(tree.root);

    expect(text).toContain('EXTERNAL LINK');
    expect(text).toContain('An article');
    expect(text).toContain('https://example.com/a');
    expect(text).toContain('Open in a secure browser');
    expect(text).toContain('Open in my browser');
  });

  it('strips tracking parameters and says so, and opens the CLEANED url', async () => {
    const tree = await open('https://example.com/a?utm_source=stiq&id=7');
    expect(textOf(tree.root)).toContain('Tracking parameters removed.');

    press(tree, 'Open in my browser');
    await flush();
    expect(openURL).toHaveBeenCalledWith('https://example.com/a?id=7');
  });

  it('with no default set, hands the link to the OS handler', async () => {
    const tree = await open('https://example.com/a');
    press(tree, 'Open in my browser');
    await flush();

    expect(openURL).toHaveBeenCalledWith('https://example.com/a');
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('with a default set, launches THAT browser rather than the OS handler', async () => {
    setPreferredBrowserRuntime(CHROME);
    const tree = await open('https://example.com/a');
    press(tree, 'Open in my browser');
    await flush();

    expect(mockOpen).toHaveBeenCalledWith('https://example.com/a', CHROME);
    expect(openURL).not.toHaveBeenCalled();
  });

  it('keeps offering a secure browser when the default is an ordinary one', async () => {
    setPreferredBrowserRuntime(CHROME);
    mockList.mockResolvedValue([{id: CHROME, label: 'Chrome'}]);
    const tree = await open('https://example.com/a');
    const text = textOf(tree.root);

    expect(text).toContain('Open in a secure browser');
    // …and names where the link would land.
    expect(text).toContain('Chrome');
  });

  it('drops the secure option once a Tor browser is the default, leaving one way out', async () => {
    setPreferredBrowserRuntime(TOR);
    const tree = await open('https://example.com/a');
    const text = textOf(tree.root);

    expect(text).not.toContain('Open in a secure browser');
    expect(text).toContain('Open in my browser');
    expect(text).toContain('Tor Browser');
  });

  it('says a refused launch failed instead of doing nothing', async () => {
    setPreferredBrowserRuntime(CHROME);
    mockOpen.mockResolvedValue(false);
    const tree = await open('https://example.com/a');
    press(tree, 'Open in my browser');
    await flush();

    expect(textOf(tree.root)).toContain('Couldn’t open that browser');
  });

  it('warns that an onion address needs Tor, and stops warning once Tor is the default', async () => {
    const tree = await open('http://expyuzz4wqqyqhjn.onion/');
    expect(textOf(tree.root)).toContain('Onion address');

    setPreferredBrowserRuntime(TOR);
    const withTor = await open('http://expyuzz4wqqyqhjn.onion/');
    expect(textOf(withTor.root)).not.toContain('Onion address');
  });

  it('flags a lookalike (punycode) domain', async () => {
    const tree = await open('https://xn--80ak6aa92e.com/login');
    expect(textOf(tree.root)).toContain('Lookalike domain');
  });

  describe('the secure-browser sheet', () => {
    it('offers a download for a Tor browser that is not installed', async () => {
      const tree = await open('https://example.com/a');
      press(tree, 'Open in a secure browser');
      await flush();

      expect(textOf(tree.root)).toContain('Download Tor Browser');

      press(tree, 'Download Tor Browser');
      expect(openURL).toHaveBeenCalledWith('market://details?id=org.torproject.torbrowser');
    });

    it('falls back to the download page when no store handles the deep link', async () => {
      openURL.mockRejectedValue(new Error('no activity'));
      const tree = await open('https://example.com/a');
      press(tree, 'Open in a secure browser');
      await flush();
      press(tree, 'Download Tor Browser');
      await flush();

      expect(openURL).toHaveBeenCalledWith('https://www.torproject.org/download/');
    });

    it('opens an installed Tor browser directly, without changing the default', async () => {
      mockInstalled.mockImplementation(async (id: string) => id === TOR);
      const tree = await open('https://example.com/a');
      press(tree, 'Open in a secure browser');
      await flush();

      press(tree, 'Open here');
      await flush();
      expect(mockOpen).toHaveBeenCalledWith('https://example.com/a', TOR);
      expect(getPreferredBrowser()).toBe('');
    });

    it('"Make default" persists the choice and retires the secure option on the spot', async () => {
      mockInstalled.mockImplementation(async (id: string) => id === TOR);
      const tree = await open('https://example.com/a');
      press(tree, 'Open in a secure browser');
      await flush();

      press(tree, 'Make default');
      await flush();

      expect(getPreferredBrowser()).toBe(TOR);
      expect(textOf(tree.root)).not.toContain('Open in a secure browser');
    });

    it('offers only browsers installable on this platform', async () => {
      Platform.OS = 'ios';
      const tree = await open('https://example.com/a');
      press(tree, 'Open in a secure browser');
      await flush();
      const text = textOf(tree.root);

      expect(text).toContain('Onion Browser');
      expect(text).not.toContain('Tor Browser (Alpha)');
    });
  });
});
