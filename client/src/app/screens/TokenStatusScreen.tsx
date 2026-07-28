/**
 * TokenStatusScreen — on-device token/economy diagnostics (Settings → Diagnostics → Token status,
 * `__DEV__`-gated). T5.1/F18.
 *
 * A strictly READ-ONLY view over {@link AppSnapshot.tokenStatus}: per-purpose wallet counts (posting
 * + the six TokenPool-pooled auxiliary purposes), the C5 per-domain provisioning/drift verdict, and
 * the most recent token-relevant diagnostic log entries. It makes NO relay/network calls, mints/spends
 * NO tokens, and mutates NO wallet — the only action available is "Refresh" (re-reads the current
 * wallet counts) and, implicitly, opening/closing. It is only reachable behind the Settings `__DEV__`
 * gate, so it never ships in a normal member build (diagnostics, not a member-facing feature) — mirrors
 * SyncDebugScreen's shape exactly.
 *
 * NO SECRETS: every value rendered here is a count, a PUBLIC issuer-key fingerprint (already
 * advertised by the relay / carried in the invite), a domain name, or a calm log message — never a
 * token, a blinding secret, or a private key. See tokenEconomyStatus.ts's module doc.
 */
import React from 'react';
import {Modal, SafeAreaView, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {SwipeBackView} from '../../ui/SwipeBack';
import {radius, space, type as typeScale, weight, type Palette} from '../../ui/theme';
import {
  EMPTY_TOKEN_STATUS,
  type ProvisioningVerdict,
  type TokenEconomyStatus,
  type TokenWalletRow,
} from '../tokenEconomyStatus';

export interface TokenStatusScreenProps {
  visible: boolean;
  onClose: () => void;
  /** Read-only status snapshot (AppSnapshot.tokenStatus). Defaults to the all-empty/all-zero shape
   *  when absent (e.g. a pre-init render) so this screen never needs its own loading state. */
  status?: TokenEconomyStatus;
  /** Re-read the per-purpose wallet counts (an async SecureStorage read) — wired to the "Refresh"
   *  header action. Optional so the screen still renders (read-only) without it. */
  onRefresh?: () => void;
  c: Palette;
}

const WALLET_LABELS: Record<TokenWalletRow['purpose'], string> = {
  post: 'Post',
  spaceWrite: 'Space write',
  read: 'Read',
  pictureWrite: 'Picture write',
  pictureRead: 'Picture read',
  audioWrite: 'Audio write',
  audioRead: 'Audio read',
};

/** Domain keys are the FingerprintKey (NIP-11) vocabulary — snake_case, distinct from the Purpose
 *  wire strings above (Appendix A: `posting` fingerprint key vs. `post` purpose). */
const DOMAIN_LABELS: Record<string, string> = {
  posting: 'Posting',
  space_write: 'Space write',
  picture: 'Picture',
  audio: 'Audio',
  read: 'Read',
};

function verdictStyle(v: ProvisioningVerdict, c: Palette): {fg: string; bg: string; label: string} {
  switch (v) {
    case 'ok':
      return {fg: c.success, bg: c.successBg, label: 'OK'};
    case 'stale':
      return {fg: c.danger, bg: c.dangerBg, label: 'STALE'};
    case 'unknown':
      return {fg: c.textMuted, bg: c.surfaceAlt, label: 'UNKNOWN'};
  }
}

/** Wall-clock HH:MM:SS for a RecentTokenFailure.ts epoch-ms timestamp (mirrors SyncDebugScreen). */
function formatClock(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function TokenStatusScreen({
  visible,
  onClose,
  status = EMPTY_TOKEN_STATUS,
  onRefresh,
  c,
}: TokenStatusScreenProps): React.JSX.Element {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* SafeAreaView (not View): a Modal renders outside the app's root SafeAreaView, so it
          re-applies the top inset — otherwise the header flanks the Dynamic Island. */}
      <SafeAreaView style={[s.root, {backgroundColor: c.bg}]}>
        {/* Opaque Modal: this SafeAreaView (c.bg) is the backdrop and stays put; SwipeBackView wraps
            its children so the drag translates the actual content, revealing this same bg beneath —
            no window transparency surgery needed. `onBack` is `onClose`, the SAME identifier the
            header ‹ below already calls. */}
        <SwipeBackView onBack={onClose}>
          <View style={[s.header, {borderBottomColor: c.border}]}>
            <Press onPress={onClose} hitSlop={10} style={s.back}>
              <Text style={[s.backText, {color: c.textSecondary}]}>‹</Text>
            </Press>
            <Text style={[s.title, {color: c.textPrimary}]}>Token status</Text>
            <Press onPress={() => onRefresh?.()} hitSlop={10} style={s.refreshBtn} disabled={!onRefresh}>
              <Text style={[s.refreshText, {color: onRefresh ? c.accent : c.textMuted}]}>Refresh</Text>
            </Press>
          </View>

          <ScrollView contentContainerStyle={s.listPad} showsVerticalScrollIndicator={false}>
            {status.communityKeyError && (
              <View style={[s.banner, {backgroundColor: c.dangerBg, borderColor: c.danger}]}>
                <Text style={[s.bannerText, {color: c.danger}]}>{status.communityKeyError}</Text>
              </View>
            )}

            <Text style={[s.sectionLabel, {color: c.textMuted}]}>WALLETS</Text>
            {status.walletRows.length === 0 ? (
              <Text style={[s.empty, {color: c.textMuted}]}>No wallet counts yet — tap Refresh</Text>
            ) : (
              status.walletRows.map(row => (
                <View key={row.purpose} style={[s.row, {backgroundColor: c.surface, borderColor: c.border}]}>
                  <Text style={[s.rowLabel, {color: c.textPrimary}]}>{WALLET_LABELS[row.purpose]}</Text>
                  <View style={s.rowRight}>
                    {!row.active && (
                      <Text style={[s.inactiveTag, {color: c.textMuted}]}>inactive</Text>
                    )}
                    <Text style={[s.count, {color: row.active ? c.textPrimary : c.textMuted}]}>{row.count}</Text>
                  </View>
                </View>
              ))
            )}

            <Text style={[s.sectionLabel, {color: c.textMuted, marginTop: space.lg}]}>PROVISIONING</Text>
            {status.domains.length === 0 ? (
              <Text style={[s.empty, {color: c.textMuted}]}>No domains negotiated yet</Text>
            ) : (
              status.domains.map(d => {
                const v = verdictStyle(d.verdict, c);
                return (
                  <View key={d.domain} style={[s.row, s.domainRow, {backgroundColor: c.surface, borderColor: c.border}]}>
                    <View style={s.domainTop}>
                      <Text style={[s.rowLabel, {color: c.textPrimary}]}>
                        {DOMAIN_LABELS[d.domain] ?? d.domain}
                      </Text>
                      <Text style={[s.badge, {color: v.fg, backgroundColor: v.bg}]}>{v.label}</Text>
                    </View>
                    <Text style={[s.rowMeta, {color: c.textSecondary}]}>
                      {d.advertised
                        ? `relay: ${d.relayKeyCount} key${d.relayKeyCount === 1 ? '' : 's'}`
                        : 'relay: not advertised'}
                      {d.walletFingerprint ? ` · wallet: ${d.walletFingerprint}` : ' · wallet: none'}
                    </Text>
                  </View>
                );
              })
            )}

            <Text style={[s.sectionLabel, {color: c.textMuted, marginTop: space.lg}]}>RECENT FAILURES</Text>
            {status.recentFailures.length === 0 ? (
              <Text style={[s.empty, {color: c.textMuted}]}>No recent token failures</Text>
            ) : (
              status.recentFailures.map((f, i) => (
                <View key={`${f.ts}-${i}`} style={[s.row, s.domainRow, {backgroundColor: c.surface, borderColor: c.border}]}>
                  <View style={s.domainTop}>
                    <Text style={[s.rowWhen, {color: c.textSecondary}]}>{formatClock(f.ts)}</Text>
                    <Text
                      style={[
                        s.badge,
                        f.level === 'error'
                          ? {color: c.danger, backgroundColor: c.dangerBg}
                          : {color: c.warning, backgroundColor: c.warningBg},
                      ]}>
                      {f.scope}
                    </Text>
                  </View>
                  <Text style={[s.rowMeta, {color: c.textSecondary}]}>{f.message}</Text>
                </View>
              ))
            )}
          </ScrollView>
        </SwipeBackView>
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: {flex: 1},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: {width: 36, height: 36, alignItems: 'center', justifyContent: 'center'},
  backText: {fontSize: 28, lineHeight: 30},
  title: {flex: 1, textAlign: 'center', fontSize: typeScale.subheading, fontWeight: weight.bold},
  refreshBtn: {minWidth: 60, alignItems: 'flex-end', paddingRight: 2},
  refreshText: {fontSize: typeScale.label, fontWeight: weight.semibold},
  listPad: {padding: space.md, gap: space.sm},
  sectionLabel: {fontSize: typeScale.caption, fontWeight: weight.semibold, letterSpacing: 0.6, marginBottom: 2},
  empty: {fontSize: typeScale.body, paddingVertical: space.sm},
  banner: {borderRadius: radius.md, borderWidth: 1, padding: space.md, marginBottom: space.sm},
  bannerText: {fontSize: typeScale.label, fontWeight: weight.semibold},
  row: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  domainRow: {flexDirection: 'column', alignItems: 'stretch', gap: 4},
  domainTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  rowLabel: {fontSize: typeScale.label, fontWeight: weight.semibold},
  rowRight: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  rowMeta: {fontSize: typeScale.caption},
  rowWhen: {fontSize: typeScale.label, fontWeight: weight.semibold},
  count: {fontSize: typeScale.label, fontWeight: weight.bold},
  inactiveTag: {fontSize: typeScale.micro, fontStyle: 'italic'},
  badge: {
    fontSize: typeScale.micro,
    fontWeight: weight.bold,
    letterSpacing: 0.6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
});
