/**
 * SyncDebugScreen — on-device sync diagnostics (Settings → Sync diagnostics, dev-gated).
 *
 * A strictly READ-ONLY view over the {@link getSyncStats} ring buffer that RelayClient fills via its
 * onReconciled callback (T10). It shows the most recent negentropy reconciliations newest-first —
 * round count, wall time, need/have deltas, bytes on the wire, and a FALLBACK badge when a round fell
 * back to the legacy window sync. It makes NO relay/network calls and publishes nothing; it renders
 * fine with zero stats. It is only reachable behind the Settings __DEV__ gate, so it never ships in a
 * normal member build (diagnostics, not a member-facing feature).
 *
 * TODO(T10-S3): '../../nostr/syncStats' is authored by T10-S3 in this same wave. Until it lands this
 * import will not resolve; this screen is coded against the planned API (getSyncStats /
 * subscribeSyncStats / clearSyncStats returning/consuming ReconcileStats). See the T10-S3 signatures.
 */
import React, {useEffect, useState} from 'react';
import {Modal, SafeAreaView, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {SwipeBackView} from '../../ui/SwipeBack';
import {radius, space, type as typeScale, weight, type Palette} from '../../ui/theme';
import {clearSyncStats, getSyncStats, subscribeSyncStats} from '../../nostr/syncStats';

/** One reconciliation record — derived from the buffer's element type so we don't couple to the name. */
type Stat = ReturnType<typeof getSyncStats>[number];

export interface SyncDebugScreenProps {
  visible: boolean;
  onClose: () => void;
  c: Palette;
}

/** Wall-clock HH:MM:SS for a ReconcileStats.at epoch-ms timestamp. */
function formatClock(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** frameBytesOut rendered as KiB (one decimal). */
function formatKiB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function SyncDebugScreen({visible, onClose, c}: SyncDebugScreenProps): React.JSX.Element {
  // Re-render on every recorded stat. The buffer itself is the source of truth (we read it fresh each
  // render); this tick just nudges React when a new entry lands or the buffer is cleared.
  const [, setTick] = useState(0);
  useEffect(() => subscribeSyncStats(() => setTick(t => t + 1)), []);

  // getSyncStats returns newest-last; show newest-first without mutating the frozen source.
  const stats: readonly Stat[] = getSyncStats();
  const rows = stats.slice().reverse();

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
            <Text style={[s.title, {color: c.textPrimary}]}>Sync diagnostics</Text>
            <Press
              onPress={() => {
                clearSyncStats();
                setTick(t => t + 1);
              }}
              hitSlop={10}
              style={s.clearBtn}>
              <Text style={[s.clearText, {color: c.accent}]}>Clear</Text>
            </Press>
          </View>

          {rows.length === 0 ? (
            <View style={s.center}>
              <Text style={[s.empty, {color: c.textMuted}]}>No reconciliations yet</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={s.listPad} showsVerticalScrollIndicator={false}>
              {rows.map((st, i) => (
                <View
                  key={`${st.at}-${i}`}
                  style={[s.row, {backgroundColor: c.surface, borderColor: c.border}]}>
                  <View style={s.rowTop}>
                    <Text style={[s.rowWhen, {color: c.textPrimary}]}>{formatClock(st.at)}</Text>
                    {st.fellBack ? (
                      <Text style={[s.badge, {color: c.warning, backgroundColor: c.warningBg}]}>
                        FALLBACK
                      </Text>
                    ) : null}
                  </View>
                  <Text style={[s.rowMeta, {color: c.textSecondary}]}>
                    {st.rounds} round{st.rounds === 1 ? '' : 's'} · {st.wallMs} ms
                  </Text>
                  <Text style={[s.rowMeta, {color: c.textSecondary}]}>
                    need {st.need} · have {st.have} · {formatKiB(st.frameBytesOut)}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}
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
  clearBtn: {minWidth: 36, alignItems: 'flex-end', paddingRight: 2},
  clearText: {fontSize: typeScale.label, fontWeight: weight.semibold},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl},
  empty: {fontSize: typeScale.body, textAlign: 'center'},
  listPad: {padding: space.md, gap: space.sm},
  row: {borderRadius: radius.md, borderWidth: 1, padding: space.md},
  rowTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  rowWhen: {fontSize: typeScale.label, fontWeight: weight.semibold},
  badge: {
    fontSize: typeScale.micro,
    fontWeight: weight.bold,
    letterSpacing: 0.6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  rowMeta: {fontSize: typeScale.caption, marginTop: 3},
});
