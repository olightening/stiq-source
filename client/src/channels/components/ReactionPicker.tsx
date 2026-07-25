/**
 * Reaction controls.
 *
 * CHANNELS (public + private channel) configure their one-tap reaction set via {@link ReactionSlots}
 * — a row of blank slots the admin fills with any emoji they like (one per slot). The filled slots
 * become the channel's reactions (rendered as one-tap chips on every post card).
 *
 * GROUPS + DMs don't configure a set — members react with ANY emoji from the ⋯ message menu (see
 * {@link ReactionBar}). {@link ReactionField} (free-text emoji entry) remains available too.
 */
import React, {useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors, radius, weight} from '../../ui/theme';
import {DEFAULT_SPACE_REACTIONS} from '../spaceRules';

/** The default palette offered when configuring a space's reactions. Single source of truth lives in
 * spaceRules (model layer) so the create/edit UI and the group fallback all agree. */
export const DEFAULT_REACTION_PALETTE: string[] = [...DEFAULT_SPACE_REACTIONS];

/**
 * Split a string of emojis into individual reactions. Prefers grapheme segmentation (keeps
 * multi-codepoint emoji like ❤️ and ZWJ sequences intact); falls back to code-point splitting on
 * runtimes without Intl.Segmenter. Accepts both packed ("👍🔥🙏") and space-separated input.
 */
export function splitEmojis(input: string): string[] {
  const trimmed = input.replace(/\s+/g, ' ').trim();
  if (!trimmed) return [];
  const Seg = (Intl as unknown as {Segmenter?: new (l?: string, o?: {granularity: string}) => {segment: (s: string) => Iterable<{segment: string}>}}).Segmenter;
  if (Seg) {
    return [...new Seg(undefined, {granularity: 'grapheme'}).segment(trimmed)]
      .map(x => x.segment)
      .filter(g => g.trim());
  }
  return Array.from(trimmed).filter(g => g.trim());
}

/**
 * ReactionField — the channel reaction control: a text field where the admin types the emojis they
 * want as one-tap reactions. Whatever they enter (packed or spaced) becomes the channel's set.
 */
export function ReactionField({
  value,
  onChange,
  placeholder = 'Type emoji — e.g. 👍 ❤️ 🎉',
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}): React.JSX.Element {
  const [text, setText] = useState(value.join(' '));
  const handle = (t: string): void => {
    setText(t);
    onChange(splitEmojis(t));
  };
  return (
    <TextInput
      style={s.field}
      value={text}
      onChangeText={handle}
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      autoCapitalize="none"
      autoCorrect={false}
      accessibilityLabel="reaction-emoji-field"
    />
  );
}

/**
 * ReactionBar — the ⋯ message-reaction picker for GROUPS + DMs: a horizontal, scrollable row of
 * common emojis plus a text field to enter ANY emoji. Tapping/entering one calls `onPick`.
 */
export function ReactionBar({
  onPick,
  palette = DEFAULT_REACTION_PALETTE,
}: {
  onPick: (emoji: string) => void;
  palette?: string[];
}): React.JSX.Element {
  const [custom, setCustom] = useState('');
  const submitCustom = (t: string): void => {
    const first = splitEmojis(t)[0];
    setCustom('');
    if (first) onPick(first);
  };
  return (
    <View style={s.barWrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.bar} keyboardShouldPersistTaps="handled">
        {palette.map(emoji => (
          <Press key={emoji} style={s.barChip} onPress={() => onPick(emoji)} accessibilityLabel={`react-${emoji}`}>
            <Text style={s.emoji}>{emoji}</Text>
          </Press>
        ))}
      </ScrollView>
      <TextInput
        style={s.barCustom}
        value={custom}
        onChangeText={setCustom}
        onSubmitEditing={e => submitCustom(e.nativeEvent.text)}
        placeholder="＋"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        accessibilityLabel="react-custom-emoji"
      />
    </View>
  );
}

/**
 * ReactionSlots — the channel reaction control: a fixed row of blank slots, each holding EXACTLY one
 * emoji. The admin types whatever emoji they want into each slot (any emoji — not a fixed palette to
 * pick from); the filled slots become the channel's one-tap reaction set. Empty slots are ignored.
 */
export function ReactionSlots({
  value,
  onChange,
  count = 4,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** How many slots to offer (default 4). */
  count?: number;
}): React.JSX.Element {
  // Positional slots, seeded once from the incoming value (any extras beyond `count` are dropped).
  // The slots own their layout so an emoji typed into slot 3 STAYS in slot 3 — we only compact to a
  // dense array when reporting the value upward.
  const [slots, setSlots] = useState<string[]>(() =>
    Array.from({length: count}, (_, i) => value[i] ?? ''),
  );
  const update = (i: number, raw: string): void => {
    const emoji = splitEmojis(raw)[0] ?? ''; // clamp to a single grapheme
    const next = slots.slice();
    next[i] = emoji;
    setSlots(next);
    // Compact + de-dupe so empty slots don't leak through and downstream keys stay unique.
    const out: string[] = [];
    for (const e of next) if (e && !out.includes(e)) out.push(e);
    onChange(out);
  };
  return (
    <View style={s.slots}>
      {slots.map((emoji, i) => (
        <TextInput
          key={i}
          style={[s.slot, emoji ? s.slotFilled : null]}
          value={emoji}
          onChangeText={t => update(i, t)}
          placeholder="＋"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          textAlign="center"
          accessibilityLabel={`reaction-slot-${i + 1}`}
        />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  // ReactionSlots (channel one-tap reaction slots) — four blank single-emoji fields.
  slots: {flexDirection: 'row', flexWrap: 'wrap', gap: 10},
  slot: {
    width: 54,
    height: 54,
    textAlign: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.textPrimary,
    fontSize: 24,
    padding: 0,
  },
  slotFilled: {borderColor: colors.accent, backgroundColor: colors.accentSoft},
  emoji: {fontSize: 20, fontWeight: weight.regular},
  // ReactionField (channel reaction text entry)
  field: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: colors.textPrimary,
    fontSize: 18,
  },
  // ReactionBar (⋯ any-emoji picker for groups/DMs)
  barWrap: {flexDirection: 'row', alignItems: 'center', gap: 8},
  bar: {flexDirection: 'row', gap: 6, alignItems: 'center', paddingRight: 4},
  barChip: {
    minWidth: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  barCustom: {
    width: 44,
    textAlign: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    paddingVertical: 6,
    color: colors.textPrimary,
    fontSize: 18,
  },
});
