/**
 * MessageComposer — the ONE message input used everywhere in Stiq: channels, group chat, private
 * chats (DMs), and comments/replies. It is a single rounded bubble (Telegram-style): a leading `+`
 * button, the text input, and a trailing accent round button, all inside one pill — nothing floats
 * outside it. Because every surface renders this same component, a change here updates the editor on
 * all of them at once.
 *
 * The `+` popover carries the standard attach actions: **Embed a post · Add a link · Add picture ·
 * Record voice · Expand to editor** (each shown only when the caller wires it, except "Add a link"
 * which is always available since it just appends a URL to the draft). Where every action is enabled
 * the menu is identical on all surfaces.
 *
 * The trailing accent button is ALWAYS the ↑ send arrow — it never morphs into a mic. Voice has a
 * single home: **Record voice** in the `+` menu (shown whenever the caller passes `onRecordVoice`),
 * so the send button's meaning is unambiguous and the mic lives with the other attach actions.
 *
 * Wrapped in `React.forwardRef` exposing the internal `TextInput` — callers that need to
 * imperatively focus the input (e.g. swipe-to-reply) can attach a ref; existing ref-less callers
 * are unaffected.
 */
import React, {useState} from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import {Press} from '../../ui/Press';
import {hasBlockMarkdown} from '../plainText';
import {colors} from '../../ui/theme';
import {Icon, hasIcon} from '../../ui/icons';
import {dirAlign, firstStrongDir, splitParagraphs} from '../../ui/textDirection';

/** Accent trailing round-button metrics (＋ and send/mic), matching the Channels mockup. */
const SEND = {size: 36, radius: 18} as const;

/** Prefix a bare host with https:// so a pasted "example.com" still renders as a link card. */
function normalizeLink(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith('nostr:') ? t : `https://${t}`;
}

export interface MessageComposerProps {
  value: string;
  onChangeText: (t: string) => void;
  onSelectionChange?: (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => void;
  placeholder: string;
  /** Send the current draft (the parent guards empty). */
  onSend: () => void;
  /** `+` → "Embed a post": open the saved-post picker. Omit to hide the action. */
  onEmbed?: () => void;
  /** `+` → "Expand to editor": open the full WYSIWYG editor. Omit to hide the action. */
  onExpand?: () => void;
  /** `+` → "Add picture": open the pixel-picture composer and embed it inline. Omit to hide. */
  onAddPicture?: () => void;
  /**
   * Record a voice note. When provided, a **Record voice** action appears in the `+` menu. Omit for
   * no voice. (The trailing send button is always ↑ — it never becomes a mic.)
   */
  onRecordVoice?: () => void;
  accessibilityInput?: string;
  accessibilitySend?: string;
}

export const MessageComposer = React.forwardRef<TextInput, MessageComposerProps>(function MessageComposer({
  value,
  onChangeText,
  onSelectionChange,
  placeholder,
  onSend,
  onEmbed,
  onExpand,
  onAddPicture,
  onRecordVoice,
  accessibilityInput,
  accessibilitySend = 'send',
}: MessageComposerProps, ref): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');

  // Auto-flip the input to its FIRST paragraph's direction (per-paragraph, first strong char). RN
  // can't align individual paragraphs differently within one TextInput, so it follows paragraph 1.
  const inputDir = dirAlign(firstStrongDir(splitParagraphs(value)[0] ?? value));

  // Standard `+` actions. "Add a link" is always offered (it just appends a URL to the draft); the
  // rest appear only when the caller wires them, so the menu matches everywhere they're all enabled.
  // "Record voice" is the ONLY entry point for voice (the trailing send button never becomes a mic).
  const items: {icon: string; label: string; onPress: () => void}[] = [];
  if (onEmbed) items.push({icon: '🚀', label: 'Embed a post', onPress: onEmbed});
  items.push({icon: '🔗', label: 'Add a link', onPress: () => { setLinkDraft(''); setLinkOpen(true); }});
  if (onAddPicture) items.push({icon: '🖼️', label: 'Add picture', onPress: onAddPicture});
  if (onRecordVoice) items.push({icon: '🎙️', label: 'Record voice', onPress: onRecordVoice});
  if (onExpand) items.push({icon: '✏️', label: 'Expand to editor', onPress: onExpand});

  const attachLink = (): void => {
    const url = normalizeLink(linkDraft);
    setLinkOpen(false);
    if (!url) return;
    onChangeText(value.trim() ? `${value.trimEnd()}\n${url}` : url);
  };

  // A draft written in the expanded editor comes BACK here as markdown (Done syncs the body; the ↑
  // below is what sends it), so a table or a collapsible block sits in this compact input as raw
  // pipes and colons. Rather than hide it — hiding would mean the writer can no longer see or edit
  // what they are about to send — say what it is and offer the way back to the editor that can
  // actually render it. Only shown when the caller wired `onExpand`, since otherwise there is
  // nowhere to go.
  const richDraft = !!onExpand && hasBlockMarkdown(value);

  return (
    <View style={s.wrap}>
      {richDraft && (
        <Press style={s.richChip} onPress={onExpand} accessibilityLabel="composer-rich-draft">
          <Text style={s.richGlyph}>▦</Text>
          <Text style={s.richLabel} numberOfLines={1}>
            Formatted draft — tap to open the editor
          </Text>
        </Press>
      )}
      <View style={s.bubble}>
        <Press
          style={s.roundBtn}
          onPress={() => { Keyboard.dismiss(); setMenuOpen(true); }}
          accessibilityLabel="composer-add">
          <Text style={s.plusIcon}>＋</Text>
        </Press>
        <TextInput
          ref={ref}
          style={[s.input, inputDir]}
          value={value}
          onChangeText={onChangeText}
          onSelectionChange={onSelectionChange}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          multiline
          blurOnSubmit={false}
          accessibilityLabel={accessibilityInput}
        />
        <Press
          style={[s.roundBtn, s.sendBtn]}
          onPress={onSend}
          accessibilityLabel={accessibilitySend}>
          {/* Always the ↑ send arrow — geometric (stem + rotated chevron) rather than a font glyph,
              so it's provably centered in the accent circle regardless of font metrics (verified: ink
              center is within 0.01px of the circle center on both axes). */}
          <View style={s.arrow}>
            <View style={s.arrowStem} />
            <View style={s.arrowHead} />
          </View>
        </Press>
      </View>

      {/* `+` popover — anchored just above the composer bar (bottom-left), dark scrim to dismiss. */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Press variant="bare" style={s.menuBackdrop} onPress={() => setMenuOpen(false)} accessibilityRole="none" />
        <View style={s.menuCard}>
          {items.map((it, i) => (
            <Press
              key={it.label}
              variant="row"
              style={[s.menuRow, i === items.length - 1 && s.menuRowLast]}
              accessibilityLabel={`composer-add-${it.label}`}
              onPress={() => { setMenuOpen(false); it.onPress(); }}>
              {/* Functional emoji render as flat Twemoji SVG via <Icon> (identical on every device,
                  matching the Expand editor's insert bar); a glyph with no Twemoji falls back to text. */}
              <View style={s.menuIcon}>
                {hasIcon(it.icon) ? <Icon name={it.icon} size={16} /> : <Text style={s.menuIconTxt}>{it.icon}</Text>}
              </View>
              <Text style={s.menuLabel}>{it.label}</Text>
            </Press>
          ))}
        </View>
      </Modal>

      {/* "Add a link" — a minimal URL prompt (Android-safe; RN Alert.prompt is iOS-only). */}
      <Modal visible={linkOpen} transparent animationType="fade" onRequestClose={() => setLinkOpen(false)}>
        <Press variant="bare" style={s.linkBackdrop} onPress={() => setLinkOpen(false)} accessibilityRole="none" />
        {/* iOS lifts the card above the keyboard (autoFocus pops it immediately); the box-none KAV
            lets taps outside the card fall through to the backdrop to dismiss. On Android the OS
            resizes the window (adjustResize), so the KAV is inert and the card keeps its position. */}
        <KeyboardAvoidingView
          style={[s.linkKav, Platform.OS === 'ios' && s.linkKavIos]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}
          pointerEvents="box-none">
        <View style={[s.linkCard, Platform.OS === 'android' && s.linkCardAndroid]}>
          <Text style={s.linkTitle}>Add a link</Text>
          <TextInput
            style={s.linkInput}
            value={linkDraft}
            onChangeText={setLinkDraft}
            placeholder="https://…"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            autoFocus
            accessibilityLabel="composer-link-input"
          />
          <View style={s.linkActions}>
            <Press onPress={() => setLinkOpen(false)}>
              <Text style={s.linkCancel}>Cancel</Text>
            </Press>
            <Press onPress={attachLink} accessibilityLabel="composer-link-attach">
              <Text style={s.linkAttach}>Attach</Text>
            </Press>
          </View>
        </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
});
MessageComposer.displayName = 'MessageComposer';

const s = StyleSheet.create({
  wrap: {paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border},
  // The whole composer is ONE pill: `+`, input, and the trailing button sit inside a single bordered
  // surface. A modest 22px radius keeps a clean rounded-rect as the input grows (never an ellipse).
  bubble: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 22,
    paddingHorizontal: 5,
    paddingVertical: 5,
  },
  roundBtn: {
    width: SEND.size,
    height: SEND.size,
    borderRadius: SEND.radius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusIcon: {fontSize: 20, color: colors.textSecondary, marginTop: -1},
  // "Formatted draft" affordance — a quiet strip above the bubble, not a badge on it: it belongs to
  // the draft, not to the send action.
  richChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  richGlyph: {fontSize: 12, color: colors.accent},
  richLabel: {flexShrink: 1, fontSize: 12, color: colors.textSecondary},
  input: {
    flex: 1,
    paddingHorizontal: 6,
    paddingVertical: 7,
    color: colors.textPrimary,
    fontSize: 15,
    // Grow with the message to a modest height, then scroll internally; `+` → Expand for anything longer.
    maxHeight: 132,
    textAlignVertical: 'top',
  },
  sendBtn: {backgroundColor: colors.accent},
  // A crisp ↑ drawn from Views (a stem + a rotated chevron head) instead of a font glyph. Geometry is
  // font-independent, so it's dead-centered in the 36px accent circle: measured ink center sits within
  // 0.01px of the circle center on both axes. The 22×22 wrap is centered by the button's flexbox; the
  // stem/head offsets below place the arrow's ink center exactly at the wrap center (11,11).
  arrow: {width: 22, height: 22},
  arrowStem: {
    position: 'absolute', left: 9.7, top: 6.3, width: 2.6, height: 13,
    borderRadius: 2, backgroundColor: colors.onAccent,
  },
  arrowHead: {
    position: 'absolute', left: 6, top: 4.8, width: 10, height: 10,
    borderTopWidth: 2.6, borderRightWidth: 2.6, borderColor: colors.onAccent,
    transform: [{rotate: '-45deg'}],
  },

  // `+` popover
  menuBackdrop: {...StyleSheet.absoluteFillObject},
  menuCard: {
    position: 'absolute',
    left: 12,
    bottom: 74,
    minWidth: 190,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: {width: 0, height: 4},
    elevation: 8,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 15,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  menuRowLast: {borderBottomWidth: 0},
  menuIcon: {width: 22, alignItems: 'center', justifyContent: 'center'},
  menuIconTxt: {fontSize: 15, textAlign: 'center'},
  menuLabel: {fontSize: 15, color: colors.textPrimary},

  // "Add a link" prompt (centered card)
  linkBackdrop: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)'},
  // Full-screen positioning layer for the "Add a link" card. On iOS it anchors the card to the
  // bottom and, together with the KAV's `padding` behavior, rides it up above the keyboard; on
  // Android the card keeps its original absolute placement (the OS resizes the window). linkKavIos /
  // linkCardAndroid are layered in per-platform from the JSX so each platform is byte-identical.
  linkKav: {...StyleSheet.absoluteFillObject},
  linkKavIos: {justifyContent: 'flex-end', paddingHorizontal: 24, paddingBottom: 24},
  linkCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 16,
  },
  linkCardAndroid: {position: 'absolute', left: 24, right: 24, top: '38%'},
  linkTitle: {fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginBottom: 12},
  linkInput: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.textPrimary,
    fontSize: 15,
  },
  linkActions: {flexDirection: 'row', justifyContent: 'flex-end', gap: 22, marginTop: 14},
  linkCancel: {fontSize: 15, color: colors.textSecondary, fontWeight: '600'},
  linkAttach: {fontSize: 15, color: colors.accent, fontWeight: '700'},
});
