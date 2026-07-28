/**
 * ConnectionSheet — bottom sheet for choosing how the app connects to Tor.
 *
 * A vertical radio list of friendly presets (Automatic / Fastest / Censored network / Max
 * reachability / Custom) plus a collapsible Advanced area (exact transport, pasted bridge lines,
 * bootstrap timeout). Selecting a non-custom preset applies immediately (persist + reconnect);
 * Advanced edits are staged locally and committed with Apply, so a half-typed bridge line doesn't
 * reconnect on every keystroke. Structurally mirrors IdentitySwitcherSheet in SettingsScreen.
 *
 * The app stays Tor-only — there is no "off" option here; "Direct" is direct *Tor*.
 */
import React, {useEffect, useState} from 'react';
import {Linking, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import {DENSE_MAX_FONT_SCALE, radius, space, type as typeScale, weight, type Palette} from '../../ui/theme';
import {fonts} from '../../ui/typography';
import {describeConnection, type ConnectionState} from '../../connection';
import type {TransportType} from '../../tor/types';
import type {ConnectionPhase} from '../../tor/ladder';
import {GUIDED_AUTO_LADDER} from '../../config';
import {
  CONNECTION_MODES,
  parseBridgeLines,
  validateBridgeLines,
  type ConnectionMode,
  type TorConnectionPrefs,
} from '../../tor/torSettings';

/** Human labels + one-line descriptions for each preset. Single source of truth (also used by the
 *  Settings status row). */
export const MODE_LABEL: Record<ConnectionMode, string> = {
  auto: 'Automatic',
  fast: 'Fastest',
  bridges: 'Censored network',
  reach: 'Max reachability',
  custom: 'Custom',
};

export const MODE_DESC: Record<ConnectionMode, string> = {
  auto: 'Picks the best path automatically. Recommended.',
  fast: 'Direct Tor — quickest on an open network or behind a VPN.',
  bridges: 'Routes through bridges to get past blocking.',
  reach: 'Hardest to block. Slowest, but connects almost anywhere.',
  custom: 'Your exact transport and bridges.',
};

const TRANSPORTS: readonly TransportType[] = ['direct', 'webtunnel', 'obfs4', 'snowflake'];
const TRANSPORT_LABEL: Record<TransportType, string> = {
  direct: 'Direct',
  webtunnel: 'WebTunnel',
  obfs4: 'obfs4',
  snowflake: 'Snowflake',
};

/** Where a user can request their own fresh obfs4/webtunnel bridges to paste below. */
const BRIDGE_SOURCES: readonly {label: string; url: string}[] = [
  {label: 'Telegram — @GetBridgesBot  (send /obfs4 or /webtunnel)', url: 'https://t.me/GetBridgesBot'},
  {label: 'Web — bridges.torproject.org', url: 'https://bridges.torproject.org/'},
  {
    label: 'Email — bridges@torproject.org',
    url: 'mailto:bridges@torproject.org?subject=get%20transport%20obfs4&body=get%20transport%20obfs4',
  },
];

function openBridgeSource(url: string): void {
  void Linking.openURL(url).catch(() => undefined);
}

export interface ConnectionSheetProps {
  visible: boolean;
  onClose: () => void;
  c: Palette;
  /** Live Tor state for the header dot + status line. */
  connection: ConnectionState;
  /** Current persisted prefs, used to seed the sheet when it opens. */
  prefs: TorConnectionPrefs;
  /** Persist new prefs AND trigger a reconnect. The parent also closes the sheet. */
  onApply: (prefs: TorConnectionPrefs) => void;
  /**
   * Live guided-ladder phase (T2, GUIDED_AUTO_LADDER). When the flag is on, the sheet leads with an
   * "Automatic" status card that shows this stiq-authored plain-language line and demotes the preset
   * radios under Advanced. Null/absent (flag off) → today's preset-first layout, byte-identical.
   */
  phase?: ConnectionPhase | null;
}

function dotColor(state: ConnectionState, c: Palette): string {
  if (state === 'connected') {
    return c.success;
  }
  if (state === 'offline' || state === 'disconnected') {
    return c.danger;
  }
  return c.warning; // starting-tor / connecting-bridge
}

/** Parse a "seconds" text field into a millisecond timeout (undefined = automatic). */
function timeoutMsFrom(sec: string): number | undefined {
  const n = Number(sec.trim());
  return sec.trim() && Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined;
}

export function ConnectionSheet({
  visible,
  onClose,
  c,
  connection,
  prefs,
  onApply,
  phase,
}: ConnectionSheetProps): React.JSX.Element {
  const [mode, setMode] = useState<ConnectionMode>(prefs.mode);
  const [advancedOpen, setAdvancedOpen] = useState(prefs.mode === 'custom');
  const [transport, setTransport] = useState<TransportType | undefined>(prefs.preferredTransport);
  const [bridges, setBridges] = useState(prefs.customBridges.join('\n'));
  const [timeoutSec, setTimeoutSec] = useState(
    prefs.bootstrapTimeoutMs ? String(Math.round(prefs.bootstrapTimeoutMs / 1000)) : '',
  );

  // Re-seed working state each time the sheet opens (lazy idiom from IdentitySwitcherSheet).
  useEffect(() => {
    if (!visible) {
      return;
    }
    setMode(prefs.mode);
    setAdvancedOpen(prefs.mode === 'custom');
    setTransport(prefs.preferredTransport);
    setBridges(prefs.customBridges.join('\n'));
    setTimeoutSec(prefs.bootstrapTimeoutMs ? String(Math.round(prefs.bootstrapTimeoutMs / 1000)) : '');
  }, [visible, prefs]);

  const bv = validateBridgeLines(bridges);
  const bridgeHintColor =
    bv.kind === 'invalid'
      ? c.danger
      : bv.kind === 'empty'
        ? c.textSecondary
        : bv.kind === 'mixed'
          ? c.warning
          : c.success;

  // Build the prefs to persist from the current Advanced fields (used by both apply paths).
  // connectByMode() only reads preferredTransport/customBridges/bootstrapTimeoutMs for 'custom' — keep non-custom presets clean.
  const buildPrefs = (nextMode: ConnectionMode): TorConnectionPrefs =>
    nextMode === 'custom'
      ? {
          mode: nextMode,
          preferredTransport: transport,
          customBridges: parseBridgeLines(bridges),
          bootstrapTimeoutMs: timeoutMsFrom(timeoutSec),
        }
      : {mode: nextMode, customBridges: []};

  const selectPreset = (m: ConnectionMode): void => {
    setMode(m);
    if (m === 'custom') {
      setAdvancedOpen(true); // wait for an explicit Apply
      return;
    }
    onApply(buildPrefs(m)); // non-custom presets apply (and reconnect) immediately
  };

  const selectTransport = (t: TransportType): void => {
    setTransport(t);
    setMode('custom'); // picking an exact transport is a custom config
  };

  // The preset radio list. Primary surface when the guided ladder is OFF; demoted to an Advanced
  // escape hatch ("Choose a specific path") when it is ON. Selecting a preset behaves identically in
  // both layouts (persist + reconnect immediately for non-custom). GUIDED_AUTO_LADDER is a module
  // const, so exactly one placement renders — the element is instantiated once.
  const presetList = CONNECTION_MODES.map(m => {
    const active = mode === m;
    return (
      <Press
        variant="row"
        key={m}
        style={[
          s.presetRow,
          {
            borderColor: active ? c.accent : c.borderLight,
            backgroundColor: active ? c.accent : 'transparent',
          },
        ]}
        onPress={() => selectPreset(m)}>
        <View style={s.presetBody}>
          <Text
            style={[s.presetLabel, {color: active ? c.onAccent : c.textPrimary}]}
            maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {MODE_LABEL[m]}
          </Text>
          <Text
            style={[s.presetDesc, {color: active ? '#ffffffcc' : c.textSecondary}]}
            maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            {MODE_DESC[m]}
          </Text>
        </View>
        {active ? (
          <Text style={[s.presetCheck, {color: c.onAccent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            ✓
          </Text>
        ) : null}
      </Press>
    );
  });

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={[s.sheet, {backgroundColor: c.bg, borderColor: c.border}]}>
          <View style={[s.header, {borderBottomColor: c.border}]}>
            <View style={s.headerLeft}>
              <Text style={{color: dotColor(connection, c), fontSize: 12}} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>●</Text>
              <Text style={[s.title, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Connection
              </Text>
            </View>
            <Press onPress={onClose} hitSlop={10}>
              <Text style={[s.done, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Done
              </Text>
            </Press>
          </View>

          <ScrollView
            style={s.list}
            showsVerticalScrollIndicator={false}
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
            {GUIDED_AUTO_LADDER ? (
              // Guided ladder ON: a PRIMARY "Automatic" status card leads the sheet; the live phase
              // line narrates the real rung. The preset radios move under Advanced (escape hatch).
              <View style={[s.autoCard, {borderColor: c.accent, backgroundColor: c.accentSoft}]}>
                <Text
                  style={[s.autoTitle, {color: c.textPrimary}]}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Automatic — Stiq picks the best path
                </Text>
                <Text
                  style={[s.autoStatus, {color: c.textSecondary}]}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  {phase?.plainLabel ?? describeConnection(connection)}
                </Text>
              </View>
            ) : (
              // Guided ladder OFF: today's preset-first layout, byte-identical.
              <>
                <Text
                  style={[s.statusLine, {color: c.textSecondary}]}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  {describeConnection(connection)}
                </Text>
                {presetList}
              </>
            )}

            <Press style={s.advToggle} onPress={() => setAdvancedOpen(o => !o)}>
              <Text style={[s.advToggleText, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Advanced
              </Text>
              <Text style={[s.advChevron, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{advancedOpen ? '▾' : '▸'}</Text>
            </Press>

            {advancedOpen && (
              <View style={s.advBlock}>
                {GUIDED_AUTO_LADDER && (
                  <>
                    <Text style={[s.advLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      Choose a specific path
                    </Text>
                    <Text
                      style={[s.advSub, {color: c.textSecondary}]}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      Override the automatic ladder with a fixed preset.
                    </Text>
                    {presetList}
                  </>
                )}
                <Text style={[s.advLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Transport
                </Text>
                <View style={s.segmented}>
                  {TRANSPORTS.map(t => {
                    const on = transport === t;
                    return (
                      <Press
                        key={t}
                        style={[
                          s.segBtn,
                          {
                            borderColor: on ? c.accent : c.borderLight,
                            backgroundColor: on ? c.accent : 'transparent',
                          },
                        ]}
                        onPress={() => selectTransport(t)}>
                        <Text
                          style={[s.segText, {color: on ? c.onAccent : c.textSecondary}]}
                          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                          {TRANSPORT_LABEL[t]}
                        </Text>
                      </Press>
                    );
                  })}
                </View>

                <Text style={[s.advLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Custom bridges
                </Text>
                <Text
                  style={[s.advSub, {color: c.textSecondary}]}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Paste obfs4 or webtunnel bridge lines (e.g. from Tor’s Telegram/email
                  distributors). Used ahead of the built-in bridges.
                </Text>
                <TextInput
                  style={[
                    s.bridgeInput,
                    {
                      color: c.textPrimary,
                      backgroundColor: c.bg,
                      borderColor: bv.valid ? c.border : c.danger,
                    },
                  ]}
                  value={bridges}
                  onChangeText={setBridges}
                  placeholder={'obfs4 1.2.3.4:443 FINGERPRINT cert=… iat-mode=0\nwebtunnel 5.6.7.8:443 FINGERPRINT url=https://…'}
                  placeholderTextColor={c.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}
                />
                <Text style={[s.hint, {color: bridgeHintColor}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  {bv.message}
                </Text>

                <Text style={[s.advLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Where to get bridges
                </Text>
                <Text
                  style={[s.advSub, {color: c.textSecondary}]}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Request fresh obfs4 or webtunnel bridges from Tor, then paste them above. Opens
                  outside Stiq.
                </Text>
                {BRIDGE_SOURCES.map(src => (
                  <Press
                    variant="row"
                    key={src.url}
                    style={s.linkRow}
                    onPress={() => openBridgeSource(src.url)}>
                    <Text style={[s.link, {color: c.link}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      ↗ {src.label}
                    </Text>
                  </Press>
                ))}

                <Text style={[s.advLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Connection timeout
                </Text>
                <Text
                  style={[s.advSub, {color: c.textSecondary}]}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Seconds to wait before giving up on an attempt. Blank = automatic.
                </Text>
                <TextInput
                  style={[s.timeoutInput, {color: c.textPrimary, backgroundColor: c.bg, borderColor: c.border}]}
                  value={timeoutSec}
                  onChangeText={setTimeoutSec}
                  placeholder="auto"
                  placeholderTextColor={c.textMuted}
                  keyboardType="number-pad"
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}
                />

                <Press
                  style={[s.applyBtn, {backgroundColor: bv.valid ? c.accent : c.surface}]}
                  onPress={() => onApply(buildPrefs('custom'))}
                  disabled={!bv.valid}>
                  <Text
                    style={[s.applyText, {color: bv.valid ? c.onAccent : c.textMuted}]}
                    maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    Apply custom
                  </Text>
                </Press>
              </View>
            )}

            <View style={s.bottomPad} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end'},
  sheet: {
    maxHeight: '88%',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    paddingBottom: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  title: {fontSize: typeScale.subheading, fontWeight: weight.bold},
  done: {fontSize: typeScale.body, fontWeight: weight.semibold},
  list: {paddingHorizontal: space.md, paddingTop: space.md},
  statusLine: {fontSize: typeScale.caption, paddingHorizontal: 2, paddingBottom: space.sm},

  // Guided-ladder primary "Automatic" status card (GUIDED_AUTO_LADDER on).
  autoCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: space.sm,
  },
  autoTitle: {fontSize: typeScale.body, fontWeight: weight.semibold},
  autoStatus: {fontSize: typeScale.caption, marginTop: 4},

  // Preset radio rows (LayoutToggle palette, full-width row form)
  presetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: space.sm,
  },
  presetBody: {flex: 1},
  presetLabel: {fontSize: typeScale.body, fontWeight: weight.semibold},
  presetDesc: {fontSize: typeScale.caption, marginTop: 2},
  presetCheck: {fontSize: typeScale.body, fontWeight: weight.bold, marginLeft: space.sm},

  // Advanced disclosure + controls
  advToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 2,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  advToggleText: {fontSize: typeScale.label, fontWeight: weight.semibold},
  advChevron: {fontSize: 11},
  advBlock: {paddingHorizontal: 2, gap: space.xs},
  advLabel: {fontSize: typeScale.label, fontWeight: weight.semibold, marginTop: space.sm},
  advSub: {fontSize: typeScale.caption, lineHeight: 18, marginBottom: space.xs},
  segmented: {flexDirection: 'row', gap: 6, flexWrap: 'wrap'},
  segBtn: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  segText: {fontSize: typeScale.caption, fontWeight: weight.semibold},
  bridgeInput: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: typeScale.caption,
    fontFamily: fonts.mono,
    minHeight: 92,
  },
  hint: {fontSize: typeScale.caption, marginTop: 2},
  linkRow: {paddingVertical: 5},
  link: {fontSize: typeScale.label, fontWeight: weight.medium},
  timeoutInput: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: typeScale.label,
    alignSelf: 'flex-start',
    minWidth: 110,
  },
  applyBtn: {
    alignSelf: 'flex-start',
    marginTop: space.md,
    borderRadius: radius.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  applyText: {fontSize: typeScale.label, fontWeight: weight.semibold},
  disabled: {opacity: 0.6},
  bottomPad: {height: 32},
});
