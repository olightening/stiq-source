/**
 * RelaysSheet — bottom sheet for managing which relays this device receives the community from.
 *
 * A community's posts ride over a PRIMARY relay plus up to four mirrors. The organizer can publish a
 * signed mirror list (auto-trusted), and the member can add their own relays or CLOSE (mute) ones
 * they don't want. This sheet is the producer for the `mirrorsUser` / `mirrorsBlocked` tiers that the
 * transport already reads — see communities/communityStore `effectiveMirrors` + app/AppRuntime.
 *
 * Structurally mirrors ConnectionSheet: a Modal bottom sheet with a header, a scrolling body, and
 * immediate-apply actions. It owns its own snapshot state (seeded from `getSnapshot` when it opens,
 * re-read after every mutation) so the parent only has to hand it the runtime handlers.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import {DENSE_MAX_FONT_SCALE, radius, space, type as typeScale, weight, type Palette} from '../../ui/theme';
import {fonts} from '../../ui/typography';
import {onionHostOf} from '../../tor/onionAuth';
import type {RelaySource, RelayView, RelaysSnapshot} from '../../communities/communityStore';

/** Friendly label for each trust tier shown as a small badge on a relay row. */
const SOURCE_LABEL: Record<RelaySource, string> = {
  primary: 'Primary',
  user: 'Added by you',
  'known-good': 'Verified',
  seed: 'Seed',
  organizer: 'Organizer',
};

export interface RelaysSheetProps {
  visible: boolean;
  onClose: () => void;
  c: Palette;
  /** Read the current relay snapshot for the active community (null before one resolves). */
  getSnapshot: () => RelaysSnapshot | null;
  /** Add a member relay. `url` is a normalized ws onion; `onionAuthKey` is null for a public onion. */
  onAdd: (url: string, onionAuthKey: string | null) => Promise<void>;
  /** Remove a member-added relay by onion host. */
  onRemove: (host: string) => Promise<void>;
  /** Mute ("close from") a relay — the full spec so it can still be named once muted. */
  onMute: (spec: {url: string; onionAuthKey?: string | null}) => Promise<void>;
  /** Un-mute a relay by onion host. */
  onUnmute: (host: string) => Promise<void>;
}

/** A short, middle-elided form of a 56-char onion host for display. */
function shortHost(host: string): string {
  return host.length > 20 ? `${host.slice(0, 8)}…${host.slice(-6)}.onion` : host;
}

/**
 * Normalize a pasted relay address to a `ws://<host>.onion` URL, or null if it isn't a v3 onion.
 * Accepts `ws(s)://host.onion[/…]`, or a bare `host.onion`. A bare 56-char host WITHOUT `.onion` is
 * rejected (onionHostOf requires the suffix) so a half-pasted address never becomes a relay attempt.
 */
function normalizeRelayInput(raw: string): string | null {
  const host = onionHostOf(raw.trim());
  return host ? `ws://${host}.onion` : null;
}

export function RelaysSheet({
  visible,
  onClose,
  c,
  getSnapshot,
  onAdd,
  onRemove,
  onMute,
  onUnmute,
}: RelaysSheetProps): React.JSX.Element {
  const [snap, setSnap] = useState<RelaysSnapshot | null>(null);
  const [url, setUrl] = useState('');
  const [authKey, setAuthKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => setSnap(getSnapshot()), [getSnapshot]);

  // Re-seed each time the sheet opens (lazy idiom from ConnectionSheet/IdentitySwitcherSheet).
  useEffect(() => {
    if (!visible) {
      return;
    }
    refresh();
    setUrl('');
    setAuthKey('');
    setError(null);
  }, [visible, refresh]);

  // Run one mutation, then re-read the snapshot so the list reflects it. Serialized via `busy`;
  // resolves true on success so a caller (add) can clear its inputs only when it actually applied.
  const run = async (op: () => Promise<void>): Promise<boolean> => {
    if (busy) {
      return false;
    }
    setBusy(true);
    setError(null);
    let ok = true;
    try {
      await op();
    } catch {
      ok = false;
      setError('Could not apply that change. Try again.');
    } finally {
      setBusy(false);
      refresh();
    }
    return ok;
  };

  const normalized = normalizeRelayInput(url);
  const atCap = snap?.atCap ?? false;
  const canAdd = !busy && !!normalized && !atCap;

  const submitAdd = (): void => {
    if (!normalized) {
      setError('Enter a valid .onion relay address.');
      return;
    }
    const key = authKey.trim();
    void run(() => onAdd(normalized, key || null)).then(ok => {
      if (ok) {
        setUrl('');
        setAuthKey('');
      }
    });
  };

  const badge = (source: RelaySource): React.JSX.Element => (
    <View style={[s.badge, {borderColor: c.borderLight}]}>
      <Text style={[s.badgeText, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        {SOURCE_LABEL[source]}
      </Text>
    </View>
  );

  const actionBtn = (label: string, onPress: () => void, danger?: boolean): React.JSX.Element => (
    <Press
      style={[s.rowBtn, {borderColor: danger ? c.danger : c.borderLight}]}
      onPress={onPress}
      disabled={busy}>
      <Text
        style={[s.rowBtnText, {color: danger ? c.danger : c.textPrimary}]}
        maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
        {label}
      </Text>
    </Press>
  );

  const activeRow = (r: RelayView): React.JSX.Element => (
    <View key={r.host} style={[s.row, {borderColor: c.borderLight}]}>
      <View style={s.rowMain}>
        <Text
          style={[s.rowHost, {color: c.textPrimary}]}
          numberOfLines={1}
          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          {shortHost(r.host)}
        </Text>
        <View style={s.rowMeta}>
          {badge(r.source)}
          {r.onionAuthKey ? (
            <Text style={[s.rowLock, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              🔒 members-only
            </Text>
          ) : null}
        </View>
      </View>
      <View style={s.rowActions}>
        {r.source === 'primary' ? (
          <Text style={[s.rowStatic, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
            Always on
          </Text>
        ) : (
          <>
            {actionBtn('Mute', () => void run(() => onMute({url: r.url, onionAuthKey: r.onionAuthKey})))}
            {r.source === 'user'
              ? actionBtn('Remove', () => void run(() => onRemove(r.host)), true)
              : null}
          </>
        )}
      </View>
    </View>
  );

  const mutedRow = (r: RelayView): React.JSX.Element => (
    <View key={r.host} style={[s.row, {borderColor: c.borderLight, opacity: 0.7}]}>
      <View style={s.rowMain}>
        <Text
          style={[s.rowHost, {color: c.textSecondary}]}
          numberOfLines={1}
          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          {shortHost(r.host)}
        </Text>
        <View style={s.rowMeta}>{badge(r.source)}</View>
      </View>
      <View style={s.rowActions}>
        {actionBtn('Unmute', () => void run(() => onUnmute(r.host)))}
        {r.source === 'user'
          ? actionBtn('Remove', () => void run(() => onRemove(r.host)), true)
          : null}
      </View>
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={[s.sheet, {backgroundColor: c.bg, borderColor: c.border}]}>
          <View style={[s.header, {borderBottomColor: c.border}]}>
            <Text style={[s.title, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              Relays
            </Text>
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
            <Text style={[s.intro, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              Relays carry this community’s posts. You receive from all of them at once. Your organizer
              can publish trusted relays, and you can add your own or close ones you don’t want.
            </Text>

            <Text style={[s.sectionLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              Receiving from
            </Text>
            {snap && snap.active.length > 0 ? (
              snap.active.map(activeRow)
            ) : (
              <Text style={[s.empty, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                No community relay yet.
              </Text>
            )}

            {snap && snap.muted.length > 0 ? (
              <>
                <Text
                  style={[s.sectionLabel, {color: c.textPrimary}]}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Closed (muted)
                </Text>
                <Text
                  style={[s.sectionSub, {color: c.textSecondary}]}
                  maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  You won’t receive from these. Un-mute to turn one back on.
                </Text>
                {snap.muted.map(mutedRow)}
              </>
            ) : null}

            <Text style={[s.sectionLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              Add a relay
            </Text>
            <Text style={[s.sectionSub, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              Paste a relay’s .onion address to also receive this community from it. Add its
              members-only key below only if the operator gave you one.
            </Text>
            <TextInput
              style={[s.input, {color: c.textPrimary, backgroundColor: c.bg, borderColor: normalized || !url ? c.border : c.danger}]}
              value={url}
              onChangeText={t => {
                setUrl(t);
                setError(null);
              }}
              placeholder="abcd…wxyz.onion"
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}
            />
            <TextInput
              style={[s.input, {color: c.textPrimary, backgroundColor: c.bg, borderColor: c.border}]}
              value={authKey}
              onChangeText={setAuthKey}
              placeholder="members-only key (optional)"
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}
            />
            {error ? (
              <Text style={[s.hint, {color: c.danger}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                {error}
              </Text>
            ) : null}
            {atCap ? (
              <Text style={[s.hint, {color: c.warning}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Relay list is full ({snap?.cap}). Mute or remove one to add another.
              </Text>
            ) : null}
            <Press
              style={[s.addBtn, {backgroundColor: canAdd ? c.accent : c.surface}]}
              onPress={submitAdd}
              disabled={!canAdd}>
              <Text
                style={[s.addText, {color: canAdd ? c.onAccent : c.textMuted}]}
                maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Add relay
              </Text>
            </Press>

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
  title: {fontSize: typeScale.subheading, fontWeight: weight.bold},
  done: {fontSize: typeScale.body, fontWeight: weight.semibold},
  list: {paddingHorizontal: space.md, paddingTop: space.md},
  intro: {fontSize: typeScale.caption, lineHeight: 18, paddingHorizontal: 2, marginBottom: space.sm},
  sectionLabel: {fontSize: typeScale.label, fontWeight: weight.semibold, marginTop: space.md, paddingHorizontal: 2},
  sectionSub: {fontSize: typeScale.caption, lineHeight: 18, marginTop: 2, marginBottom: space.xs, paddingHorizontal: 2},
  empty: {fontSize: typeScale.caption, paddingHorizontal: 2, paddingVertical: space.sm},

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: space.sm,
    gap: space.sm,
  },
  rowMain: {flex: 1, minWidth: 0},
  rowHost: {fontSize: typeScale.caption, fontFamily: fonts.mono},
  rowMeta: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap'},
  rowLock: {fontSize: typeScale.caption},
  rowActions: {flexDirection: 'row', alignItems: 'center', gap: 6},
  rowBtn: {borderRadius: radius.pill, borderWidth: 1, paddingVertical: 4, paddingHorizontal: 10},
  rowBtnText: {fontSize: typeScale.caption, fontWeight: weight.semibold},
  rowStatic: {fontSize: typeScale.caption, fontStyle: 'italic'},

  badge: {borderRadius: radius.pill, borderWidth: 1, paddingVertical: 1, paddingHorizontal: 7},
  badgeText: {fontSize: typeScale.caption, fontWeight: weight.medium},

  input: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: typeScale.caption,
    fontFamily: fonts.mono,
    marginTop: space.xs,
  },
  hint: {fontSize: typeScale.caption, marginTop: 4, paddingHorizontal: 2},
  addBtn: {
    alignSelf: 'flex-start',
    marginTop: space.md,
    borderRadius: radius.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  addText: {fontSize: typeScale.label, fontWeight: weight.semibold},
  disabled: {opacity: 0.6},
  bottomPad: {height: 32},
});
