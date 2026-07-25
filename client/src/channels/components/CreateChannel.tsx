/**
 * CreateChannel — the redesigned "New channel" flow (Channels design handoff, Screen 6).
 *
 * A live preview card sits atop four shape-coded TYPE rows (the shape tells the community what
 * kind of space it is, matching the channel-list avatars), then the gradient maker, name/about, a
 * contextual hint box, and a full-width accent pill. Type → protocol mapping:
 *   Public          → NIP-53 channel, owner-voiced broadcasts          (kind='channel')
 *   Private         → NIP-29 group, closed + private + broadcast, E2E   (kind='group', closed, private, broadcast)
 *   Open community  → NIP-53 channel, admins post + author identity     (kind='channel', openCommunity)
 *   Group chat      → NIP-29 group, invite-only, everyone talks, E2E    (kind='group', closed, private)
 * Public + Open community are NIP-53 (always available, discoverable via the firehose). Private +
 * Group chat are NIP-29 managed groups — selectable only when the relay supports NIP-29.
 */
import React, {useState} from 'react';
import {Platform, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Press} from '../../ui/Press';
import type {ChannelMetadata} from '../channels';
import {GradientMaker} from '../../ui/GradientMaker';
import {randomGradient, type GradientSpec} from '../../media/gradient';
import {GradientAvatar, type AvatarShape} from '../../ui/GradientAvatar';
import {BackButton} from '../../ui/BackButton';
import {BACK_PRIORITY, useBackAction, useBackDismiss} from '../../ui/back';
import {ReactionSlots} from './ReactionPicker';
import {colors, radius, type as typeScale, weight} from '../../ui/theme';

export type NewSpaceKind = 'channel' | 'group';

type SpaceType = 'public' | 'private' | 'open' | 'group';

export interface CreateChannelProps {
  onCreate: (
    meta: ChannelMetadata,
    kind: NewSpaceKind,
    closed?: boolean,
    isPrivate?: boolean,
    broadcast?: boolean,
  ) => void;
  /** Whether the relay supports NIP-29 managed groups (unlocks Private + Group chat). */
  managedAvailable?: boolean;
  /** Optional back/cancel handler; when provided, a "‹ Channels" link is shown atop the form. */
  onBack?: () => void;
}

interface TypeSpec {
  type: SpaceType;
  shape: AvatarShape;
  title: string;
  /** "{label} channel" shown under the preview name. */
  label: string;
  desc: string;
  hintIcon: string;
  hint: string;
  /** Fixed swatch gradient for the TYPE-row icon (a stable per-type cue, independent of the chosen
   * channel colour — matches the design handoff's create screen). */
  iconGrad: GradientSpec;
}

const TYPES: TypeSpec[] = [
  {
    type: 'public', shape: 'square', title: 'Public', label: 'Public channel',
    desc: 'Anyone in the community can find and follow it. Tied to your account.',
    hintIcon: '🌐',
    hint: 'A public channel is owner-voiced: anyone can follow and read, and you post the broadcasts. Discoverable to everyone.',
    iconGrad: {type: 'linear', angle: 135, stops: ['#7cb2ff', '#b89aff']},
  },
  {
    type: 'private', shape: 'diamond', title: 'Private', label: 'Private channel',
    desc: 'Invite-only. Add co-admins to help you run it.',
    hintIcon: '🔒',
    hint: 'Only members can read and only admins can post — each post is signed. People join by admin invite or by requesting approval. End-to-end encrypted.',
    iconGrad: {type: 'linear', angle: 135, stops: ['#b89aff', '#7c6cff']},
  },
  {
    type: 'open', shape: 'octagon', title: 'Open community', label: 'Open community',
    desc: 'Runs like a private channel — you and your admins post, identity shown — but anyone can find and join.',
    hintIcon: '🌐',
    hint: 'An open community is a public channel with more than one voice: you and your admins broadcast and every post is signed, but it stays discoverable and anyone can join without an invite.',
    iconGrad: {type: 'linear', angle: 135, stops: ['#ffb088', '#ff8f6b']},
  },
  {
    type: 'group', shape: 'hexagon', title: 'Group chat', label: 'Group chat',
    desc: 'A small space where everyone you add can talk.',
    hintIcon: '💬',
    hint: 'Everyone you add can read and post, like a shared thread. Invite-only — an admin adds each member — and end-to-end encrypted. Best kept small.',
    iconGrad: {type: 'linear', angle: 135, stops: ['#34d399', '#3b82f6']},
  },
];

export function CreateChannel({onCreate, managedAvailable = false, onBack}: CreateChannelProps): React.JSX.Element {
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [spaceType, setSpaceType] = useState<SpaceType>('public');
  const [grad, setGrad] = useState<GradientSpec>(() => randomGradient());
  // Allowed one-tap reactions — CHANNELS only (public + private channel). Groups/DMs react with any
  // emoji from the ⋯ menu, so this set is not used for them. Starts empty — the admin fills the slots.
  const [reactions, setReactions] = useState<string[]>([]);

  // Hardware BACK leaves this form exactly as the ‹ Channels button does, and asks first once the
  // admin has typed something — a half-composed space is real work to lose to a stray gesture.
  // Registered at BACK_PRIORITY.host rather than left to MainScreen's ladder so the confirm lives
  // WITH the form that knows whether it is dirty (ui/back.tsx contract rules 2 and 5).
  const dismiss = useBackDismiss(
    name.trim().length > 0 || about.trim().length > 0,
    () => onBack?.(),
    {title: 'Discard this space?', message: 'The details you entered will not be kept.'},
  );
  useBackAction(() => { dismiss(); return true; }, {enabled: !!onBack, priority: BACK_PRIORITY.host});

  const selected = TYPES.find(t => t.type === spaceType) ?? TYPES[0]!;
  // Channels + the private channel carry an admin-configured one-tap reaction set; the group chat
  // reacts with any emoji from the ⋯ menu, so hide the field for it.
  const isChannelType = spaceType !== 'group';

  const create = (): void => {
    if (!name.trim()) return;
    const meta: ChannelMetadata = {
      name: name.trim(),
      about: about.trim() || undefined,
      gradient: grad,
      reactions: isChannelType && reactions.length > 0 ? reactions : undefined,
    };
    if (spaceType === 'public') {
      onCreate(meta, 'channel');
    } else if (spaceType === 'open') {
      // Open community = NIP-53 channel (discoverable) where admins post + posts carry author identity.
      onCreate({...meta, openCommunity: true}, 'channel');
    } else if (spaceType === 'private') {
      // private + broadcast (admins-only post) + closed (a request path exists; admins also invite). E2E.
      onCreate(meta, 'group', true, true, true);
    } else {
      // Group chat = private + closed (invite-only; everyone posts). E2E-encrypted, members managed.
      onCreate(meta, 'group', true, true, false);
    }
    setName('');
    setAbout('');
    setGrad(randomGradient());
    setReactions([]);
  };

  return (
    <View style={s.flex}>
      {onBack && (
        <View style={s.backBar}>
          <BackButton label="Channels" onPress={dismiss} size="sm" style={s.backNav} />
        </View>
      )}

      <ScrollView
        contentContainerStyle={s.root}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
        <Text style={s.title}>New channel</Text>
        <Text style={s.subtitle}>
          Anyone can start a channel. Pick how open it should be — its shape tells the community what kind it is.
        </Text>

        {/* Live preview */}
        <View style={s.preview}>
          <GradientAvatar gradient={grad} size={52} shape={selected.shape} radius={radius.md} />
          <View style={s.previewText}>
            <Text style={s.previewName} numberOfLines={1}>{name.trim() || 'Name'}</Text>
            <Text style={s.previewType}>{selected.label}</Text>
          </View>
        </View>

        {/* Type selector */}
        <Text style={s.eyebrow}>TYPE</Text>
        <View style={s.typeList}>
          {TYPES.map(t => {
            // Public + Open community are NIP-53 (always available); Private + Group chat need NIP-29.
            const disabled = t.type !== 'public' && t.type !== 'open' && !managedAvailable;
            const active = spaceType === t.type;
            return (
              <Press
                variant="row"
                key={t.type}
                style={[s.typeRow, active && s.typeRowActive, disabled && s.typeRowDisabled]}
                disabled={disabled}
                onPress={() => setSpaceType(t.type)}
                accessibilityLabel={`type-${t.type}`}>
                <GradientAvatar gradient={t.iconGrad} size={34} shape={t.shape} radius={radius.sm} />
                <View style={s.typeText}>
                  <Text style={s.typeTitle}>{t.title}{disabled ? ' · needs managed relay' : ''}</Text>
                  <Text style={s.typeDesc}>{t.desc}</Text>
                </View>
                {active && (
                  <View style={s.checkCircle}>
                    <Text style={s.checkMark}>✓</Text>
                  </View>
                )}
              </Press>
            );
          })}
        </View>

        {/* Colour */}
        <Text style={s.eyebrow}>COLOUR</Text>
        <View style={s.card}>
          <GradientMaker value={grad} onChange={setGrad} previewSize={84} />
        </View>

        {/* Reactions — CHANNELS only: the admin fills the emoji slots; members one-tap them on posts.
            Groups/DMs react with any emoji from the ⋯ menu, so no set is configured here. */}
        {isChannelType && (
          <>
            <Text style={s.eyebrow}>REACTIONS</Text>
            <View style={s.card}>
              <Text style={s.reactionHint}>
                Fill a slot with any emoji to offer it as a one-tap reaction on every post. Empty slots = no reactions.
              </Text>
              <ReactionSlots value={reactions} onChange={setReactions} />
            </View>
          </>
        )}

        {/* Name */}
        <Text style={s.eyebrow}>NAME</Text>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Garden share"
          placeholderTextColor={colors.textMuted}
        />

        {/* About */}
        <Text style={s.eyebrow}>ABOUT</Text>
        <TextInput
          style={[s.input, s.inputMultiline]}
          value={about}
          onChangeText={setAbout}
          placeholder="What's this channel for?"
          placeholderTextColor={colors.textMuted}
          multiline
        />

        {/* Contextual hint */}
        <View style={s.hintBox}>
          <Text style={s.hintIcon}>{selected.hintIcon}</Text>
          <Text style={s.hintText}>{selected.hint}</Text>
        </View>

        <Press
          style={s.button}
          onPress={create}
          disabled={!name.trim()}
          accessibilityLabel="create-channel">
          <Text style={s.buttonText}>Create {selected.label.toLowerCase()}</Text>
        </Press>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  flex: {flex: 1},
  backBar: {borderBottomWidth: 1, borderBottomColor: colors.border},
  backNav: {paddingVertical: 8, paddingHorizontal: 12},

  root: {padding: 16, paddingBottom: 28, gap: 0},
  title: {color: colors.textPrimary, fontSize: 21, fontWeight: weight.bold, marginBottom: 4},
  subtitle: {color: colors.textSecondary, fontSize: 14, lineHeight: 21, marginBottom: 18},

  // Live preview card
  preview: {
    flexDirection: 'row', alignItems: 'center', gap: 13,
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1, borderColor: colors.border,
    marginBottom: 18,
  },
  previewText: {flex: 1, minWidth: 0},
  previewName: {color: colors.textPrimary, fontSize: 17, fontWeight: weight.bold},
  previewType: {color: colors.textMuted, fontSize: 12.5, marginTop: 2},

  // Section eyebrows
  eyebrow: {color: colors.textMuted, fontSize: 11, fontWeight: weight.bold, letterSpacing: 0.88, marginBottom: 8},

  // Type rows
  typeList: {gap: 8, marginBottom: 20},
  typeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingVertical: 12, paddingHorizontal: 13,
    borderWidth: 1.5, borderColor: colors.border,
  },
  typeRowActive: {borderColor: colors.accent},
  typeRowDisabled: {opacity: 0.4},
  typeText: {flex: 1, minWidth: 0},
  typeTitle: {color: colors.textPrimary, fontSize: 15, fontWeight: weight.semibold},
  typeDesc: {color: colors.textSecondary, fontSize: 12.5, marginTop: 1, lineHeight: 17},
  checkCircle: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  checkMark: {color: colors.onAccent, fontSize: 13, fontWeight: weight.bold},

  // Broadcast toggle
  toggleRow: {flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, padding: 13, borderWidth: 1, borderColor: colors.border, marginBottom: 20},
  flex1: {flex: 1},
  toggleLabel: {color: colors.textPrimary, fontSize: typeScale.label, fontWeight: weight.semibold},
  toggleHint: {color: colors.textMuted, fontSize: typeScale.caption, marginTop: 2},

  // Colour / inputs
  card: {backgroundColor: colors.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.border, marginBottom: 20},
  reactionHint: {color: colors.textMuted, fontSize: 12.5, lineHeight: 18, marginBottom: 12},
  input: {color: colors.textPrimary, fontSize: 15, backgroundColor: colors.surface, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 13, borderWidth: 1, borderColor: colors.border, marginBottom: 16},
  inputMultiline: {minHeight: 64, textAlignVertical: 'top'},

  // Hint box
  hintBox: {flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: colors.surfaceAlt, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 13, borderWidth: 1, borderColor: colors.border, marginBottom: 20},
  hintIcon: {fontSize: 14},
  hintText: {flex: 1, color: colors.textSecondary, fontSize: 12.5, lineHeight: 19},

  // Create button
  button: {backgroundColor: colors.accent, borderRadius: radius.pill, paddingVertical: 13, alignItems: 'center'},
  buttonDisabled: {opacity: 0.4},
  buttonText: {color: colors.onAccent, fontWeight: weight.semibold, fontSize: 15},
});
