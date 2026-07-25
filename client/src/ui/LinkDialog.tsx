/**
 * LinkDialog — the one thing that happens when you tap a link.
 *
 * STIQ used to render links itself, in an in-app WebView routed through Tor. That browser is gone:
 * a link now leaves the app or it does not open at all. Which makes this dialog the whole feature —
 * it is the last screen the reader sees before their real IP is (or isn't) handed to a stranger's
 * site, so it says where the link goes, and offers exactly two ways to go there:
 *
 *   • "Open in a secure browser" — a Tor browser, where the visit stays anonymous. Emphasized while
 *     it is still the better choice, and it disappears entirely once the reader's default browser IS
 *     one of them, because at that point it has nothing left to recommend.
 *   • "Open in my browser" — the reader's chosen default, or the OS handler when they have none.
 *     Alone and emphasized once the secure option retires.
 *
 * Every link surface in the app (LinkChip, RichText, event sources) routes here via openLinkDialog(),
 * so there is ONE interstitial to reason about rather than a copy per caller.
 *
 * The sheet is an absolute-fill View, NOT a nested <Modal> — Android drops a Modal mounted inside
 * another Modal's Dialog window — so BACK has to be declared for it explicitly (useBackAction).
 */
import React, {useEffect, useState} from 'react';
import {Linking, Platform, StyleSheet, Text, View} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {BACK_PRIORITY, BackModal, useBackAction} from './back';
import {Press} from './Press';
import {Icon} from './icons';
import {colors, radius, space, type as typeScale, weight, DENSE_MAX_FONT_SCALE} from './theme';
import {fonts} from './typography';
import {classifyUrl, detectHomograph, prettyDomain, stripTrackingParams} from '../util/url';
import {registerLinkDialogHost, type LinkRequest} from './openLink';
import {choosePreferredBrowser, getPreferredBrowser} from '../browser/browserSettings';
import {resolveLinkOpen} from '../browser/linkOpen';
import {
  SECURE_BROWSERS,
  isBrowserInstalled,
  listInstalledBrowsers,
  openInBrowser,
  type SecureBrowser,
} from '../browser/browserData';

function LinkDialogBody({req, onClose}: {req: LinkRequest; onClose: () => void}): React.JSX.Element {
  // Open the cleaned URL (tracking params stripped — a per-recipient token would otherwise tell the
  // poster exactly who clicked).
  const cleaned = stripTrackingParams(req.url);
  const trackersRemoved = cleaned !== req.url;
  const info = classifyUrl(cleaned);
  const homograph = detectHomograph(info.host);
  const title = req.title?.trim() || prettyDomain(cleaned);

  // The chosen default is module state (it can change from inside this dialog), so mirror it into
  // component state and update on choose — that is what makes the secure option disappear live.
  const [preferred, setPreferred] = useState(getPreferredBrowser);
  const [copied, setCopied] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [targetLabel, setTargetLabel] = useState('');

  const plan = resolveLinkOpen(cleaned, preferred);
  const invalid = info.kind === 'invalid';

  // Name the browser the link is about to land in. Free for a browser we already know; otherwise ask
  // the device once per open. A failure just leaves the button unsubtitled.
  useEffect(() => {
    let live = true;
    const id = plan.targetId;
    const known = SECURE_BROWSERS.find(b => b.id === id);
    if (!id || known) {
      setTargetLabel(known?.label ?? '');
    } else {
      void listInstalledBrowsers().then(list => {
        if (live) setTargetLabel(list.find(b => b.id === id)?.label ?? '');
      });
    }
    return () => {
      live = false;
    };
  }, [plan.targetId]);

  useBackAction(() => { setSheetOpen(false); return true; },
    {enabled: sheetOpen, priority: BACK_PRIORITY.sheet});

  // Hand off to the reader's default. With no default set, the OS gets the URL and picks (or asks).
  // A refused launch says so inline rather than doing nothing — the failure mode this whole dialog
  // was once famous for.
  const openMine = (): void => {
    setFailed(false);
    const done = (ok: boolean): void => {
      if (ok) onClose();
      else setFailed(true);
    };
    if (!plan.targetId) {
      void Linking.openURL(cleaned).then(() => done(true)).catch(() => done(false));
      return;
    }
    void openInBrowser(cleaned, plan.targetId).then(done);
  };

  return (
    <Press variant="bare" style={s.backdrop} onPress={onClose} accessibilityRole="none">
      <Press variant="bare" style={s.dialog} onPress={() => {}} accessibilityRole="none">
        <Text style={s.eyebrow} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>EXTERNAL LINK</Text>
        <Text style={s.title} numberOfLines={2} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{title}</Text>

        <View style={s.domainRow}>
          <Icon name="🔗" size={typeScale.body} />
          <Text style={s.domain} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {prettyDomain(cleaned)}
          </Text>
        </View>
        <Text style={s.url} selectable numberOfLines={4}>{cleaned}</Text>

        {homograph.suspicious && (
          <Text style={s.warn}>
            ⚠ Lookalike domain — this uses{' '}
            {homograph.reason === 'punycode' ? 'punycode (xn--)' : 'non-Latin'} characters and may
            impersonate another site.
          </Text>
        )}
        {plan.onionNeedsTor && (
          <Text style={s.note} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            Onion address — an ordinary browser can’t open this.
          </Text>
        )}
        {trackersRemoved && (
          <Text style={s.note} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Tracking parameters removed.</Text>
        )}
        {failed && (
          <Text style={s.fail} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            Couldn’t open that browser — copy the link instead.
          </Text>
        )}

        {plan.showSecure && (
          <Press
            style={[s.wideBtn, s.primary]}
            disabled={invalid}
            onPress={() => setSheetOpen(true)}
            accessibilityLabel="open in a secure browser">
            <Text style={s.primaryText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Open in a secure browser</Text>
            <Text style={s.primarySub} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Keeps your address hidden</Text>
          </Press>
        )}

        <View style={s.actions}>
          <Press
            style={[s.btn, s.secondary]}
            onPress={() => { Clipboard.setString(cleaned); setCopied(true); }}>
            <Text style={s.secondaryText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              {copied ? 'Copied ✓' : trackersRemoved ? 'Copy clean' : 'Copy'}
            </Text>
          </Press>
          <Press
            style={[s.btn, plan.emphasis === 'mine' ? s.primary : s.secondary]}
            disabled={invalid}
            onPress={openMine}
            accessibilityLabel="open in my browser">
            <Text
              style={plan.emphasis === 'mine' ? s.primaryText : s.secondaryText}
              maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              Open in my browser
            </Text>
            {targetLabel ? (
              <Text
                style={plan.emphasis === 'mine' ? s.primarySub : s.secondarySub}
                numberOfLines={1}
                maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {targetLabel}
              </Text>
            ) : null}
          </Press>
        </View>

        {sheetOpen && (
          <SecureBrowserSheet
            url={cleaned}
            onClose={() => setSheetOpen(false)}
            onOpened={onClose}
            onChoose={id => {
              choosePreferredBrowser(id);
              setPreferred(id);
              setSheetOpen(false);
            }}
          />
        )}
      </Press>
    </Press>
  );
}

/**
 * The secure-browser list: install what you don't have, open in what you do, or make it the default
 * so this sheet stops appearing. Entries are filtered to the platform — an Android package is not
 * something an iPhone can install.
 */
function SecureBrowserSheet({
  url,
  onClose,
  onOpened,
  onChoose,
}: {
  url: string;
  onClose: () => void;
  onOpened: () => void;
  onChoose: (id: string) => void;
}): React.JSX.Element {
  const entries = SECURE_BROWSERS.filter(b => b.platform === Platform.OS);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let live = true;
    void Promise.all(
      entries.map(async b => ({id: b.id, ok: await isBrowserInstalled(b.id)})),
    ).then(results => {
      if (!live) return;
      const next: Record<string, boolean> = {};
      for (const r of results) next[r.id] = r.ok;
      setInstalled(next);
    });
    return () => {
      live = false;
    };
    // The catalogue is a module constant — this runs once per sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Store deep link first (installs in place); fall back to the download page when no store handles
  // it — a de-Googled phone has no Play Store, and Tor Browser is downloadable directly.
  const install = (b: SecureBrowser): void => {
    const site = (): void => {
      void Linking.openURL(b.siteUrl).catch(() => undefined);
    };
    if (!b.storeUrl) {
      site();
      return;
    }
    void Linking.openURL(b.storeUrl).catch(site);
  };

  return (
    <View style={s.sheetOverlay}>
      <View style={s.sheetCard}>
        <Text style={s.sheetTitle} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Open in a secure browser</Text>
        <Text style={s.sheetBody} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          These browsers route the page through Tor, so the site never sees your real address.
        </Text>

        {entries.map(b => (
          <View key={b.id} style={s.entry}>
            <Text style={s.entryTitle} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{b.label}</Text>
            <Text style={s.entrySub} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{b.blurb}</Text>
            {installed[b.id] ? (
              <View style={s.entryActions}>
                <Press
                  style={[s.btn, s.primary]}
                  onPress={() => { void openInBrowser(url, b.id).then(ok => { if (ok) onOpened(); }); }}
                  accessibilityLabel={`open in ${b.label}`}>
                  <Text style={s.primaryText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Open here</Text>
                </Press>
                <Press
                  style={[s.btn, s.secondary]}
                  onPress={() => onChoose(b.id)}
                  accessibilityLabel={`make ${b.label} my default browser`}>
                  <Text style={s.secondaryText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Make default</Text>
                </Press>
              </View>
            ) : (
              <Press
                style={[s.wideBtn, s.secondary]}
                onPress={() => install(b)}
                accessibilityLabel={`install ${b.label}`}>
                <Text style={s.secondaryText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Download {b.label}</Text>
              </Press>
            )}
          </View>
        ))}

        <Text style={s.sheetFoot} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          Settings → Browser changes your default later.
        </Text>
        <Press style={[s.wideBtn, s.secondary]} onPress={onClose}>
          <Text style={s.secondaryText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Cancel</Text>
        </Press>
      </View>
    </View>
  );
}

/**
 * The single app-root host. Mounted once in App.tsx (a sibling of AppShell) and driven by
 * openLinkDialog() from anywhere in the tree — including from inside another screen's Modal, which
 * is why it cannot live in a screen.
 *
 * CRITICAL (Android/Paper): the <Modal> stays PERMANENTLY MOUNTED and only `visible` toggles. Each
 * <Modal> is a separate Android Dialog window whose native show fires only on a false→true `visible`
 * transition observed after the host view is attached; mounting the element already-visible drops
 * that show, which is exactly how "Open link" once became a no-op. The body is keyed by url so its
 * per-open state resets cleanly.
 */
export function LinkDialogHost(): React.JSX.Element {
  const [req, setReq] = useState<LinkRequest | null>(null);
  useEffect(() => {
    registerLinkDialogHost(setReq);
    return () => registerLinkDialogHost(null);
  }, []);
  const close = (): void => setReq(null);
  return (
    <BackModal visible={req != null} transparent animationType="fade" onClose={close}>
      {req != null ? <LinkDialogBody key={req.url} req={req} onClose={close} /> : null}
    </BackModal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: 6,
  },
  eyebrow: {
    fontSize: typeScale.micro,
    letterSpacing: 0.8,
    color: colors.textMuted,
    fontWeight: weight.semibold,
  },
  title: {fontSize: typeScale.subheading, color: colors.textPrimary, fontWeight: weight.bold},
  domainRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2},
  domain: {flexShrink: 1, fontSize: typeScale.body, color: colors.link, fontWeight: weight.semibold},
  url: {fontSize: typeScale.caption, color: colors.textSecondary, fontWeight: '400', fontFamily: fonts.mono},
  warn: {fontSize: typeScale.caption, color: '#ffb4b4', fontWeight: '400', marginTop: 2},
  note: {fontSize: typeScale.micro, color: colors.textMuted, fontWeight: '400'},
  fail: {fontSize: typeScale.micro, color: colors.danger, fontWeight: weight.semibold},

  actions: {flexDirection: 'row', gap: space.sm, marginTop: space.sm},
  btn: {flex: 1, borderRadius: radius.pill, paddingVertical: 10, alignItems: 'center', justifyContent: 'center'},
  wideBtn: {
    width: '100%',
    borderRadius: radius.pill,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.sm,
  },
  primary: {backgroundColor: colors.accent},
  primaryText: {color: colors.onAccent, fontSize: typeScale.caption, fontWeight: weight.bold},
  primarySub: {color: colors.onAccent, fontSize: typeScale.micro, opacity: 0.85, marginTop: 1},
  secondary: {backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border},
  secondaryText: {color: colors.textPrimary, fontSize: typeScale.caption, fontWeight: weight.semibold},
  secondarySub: {color: colors.textMuted, fontSize: typeScale.micro, marginTop: 1},

  sheetOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.md,
    zIndex: 20,
  },
  sheetCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
  },
  sheetTitle: {fontSize: typeScale.subheading, color: colors.textPrimary, fontWeight: weight.bold},
  sheetBody: {fontSize: typeScale.caption, color: colors.textSecondary, fontWeight: '400', marginTop: 4},
  sheetFoot: {fontSize: typeScale.micro, color: colors.textMuted, fontWeight: '400', marginTop: space.md},
  entry: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    padding: space.md,
    marginTop: space.sm,
  },
  entryTitle: {fontSize: typeScale.body, color: colors.textPrimary, fontWeight: weight.semibold},
  entrySub: {fontSize: typeScale.caption, color: colors.textMuted, fontWeight: '400', marginTop: 2},
  entryActions: {flexDirection: 'row', gap: space.sm, marginTop: space.sm},
});
