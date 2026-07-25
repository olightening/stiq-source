/**
 * Icon — renders an emoji as a crisp, colorful Twemoji SVG (via react-native-svg).
 *
 * The design uses emoji as functional icons. Instead of the OS emoji font (which differs per
 * device) or a bundled emoji font, we render the flat Twemoji SVG artwork as a true vector — sharp
 * at any size, identical on every device. Use for the color-emoji glyphs (💬 📌 🔗 🖼️ 📊 🔖 👁️ 🔕
 * 🚩 ✅ 🔍 …). Text symbols (✦ ⋯ › ↑ ↓ ← ▸ ▾ ✕ ✓) stay as plain <Text>.
 *
 * `name` is the emoji character itself (e.g. <Icon name="💬" />). Unknown glyphs render nothing.
 *
 * NOTE: an <Icon> is an <Svg> (a View), so — unlike a text glyph — it CANNOT be nested inside a
 * <Text>. Place it as a sibling of the label in a flex row, not inside the text run.
 */
import React from 'react';
import {SvgXml, Svg, Path, Rect, Circle} from 'react-native-svg';
import type {StyleProp, ViewStyle} from 'react-native';
import {TWEMOJI} from './twemojiData';

// Normalize to a VS16-insensitive lookup: '⚠' and '⚠️' (and 🖼️/👁️/🎙️/✏️ with or without the
// U+FE0F variation selector) all resolve to the same SVG, regardless of how the caller spells it.
const strip = (s: string): string => s.replace(/️/g, '');
const SVG: Record<string, string> = {};
for (const [k, v] of Object.entries(TWEMOJI)) SVG[strip(k)] = v;

interface PrecompiledIconProps {
  size: number;
  style?: StyleProp<ViewStyle>;
}

// Comment/ideas glyph (💬): the bundled Twemoji bubble (pale fill + three dots) reads busy and
// "off" at footer sizes, and the OS-native emoji renders differently on every device (Samsung's
// bubble ≠ the clean one in the mockup). So draw a single-tone speech balloon — the clean Microsoft
// Fluent silhouette (MIT-licensed), filled in the app's near-white (#f5f5f7, matching the adjacent
// "N ideas" count) — so it is crisp and pixel-identical on every phone. One override covers every
// <Icon name="💬"/> call site.
//
// Precompiled as native react-native-svg elements (not an SvgXml string) so there is no XML parse
// on every mount — same rendered vector, built once per call instead of parsed every time.
function CommentBubbleIcon({size, style}: PrecompiledIconProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" style={style}>
      <Path
        fill="#f5f5f7"
        d="M16.0278 4C8.16615 4 3.53108 9.75575 1.66714 12.7026C0.772247 14.1175 0.77225 15.8825 1.66714 17.2974C2.53549 18.6702 3.97262 20.6044 6.02779 22.3015V26.5017C6.02779 27.6235 7.214 28.3483 8.21217 27.8365L12.5619 25.6063C13.6426 25.8582 14.7979 26 16.0278 26C23.8894 26 28.5245 20.2442 30.3884 17.2974C31.2833 15.8825 31.2833 14.1175 30.3884 12.7026C28.5245 9.75575 23.8894 4 16.0278 4Z"
      />
    </Svg>
  );
}

// Clipboard (📋) — the paste affordance for the editor Insert bar. Twemoji doesn't bundle 1f4cb in
// our subset, so we draw a clean clipboard in Twemoji's own palette (board #99AAB5, paper #E1E8ED,
// clip #66757F) — crisp and pixel-identical on every device, matching the colourful chips beside it.
//
// Precompiled as native react-native-svg elements for the same reason as the comment bubble above.
function ClipboardIcon({size, style}: PrecompiledIconProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36" style={style}>
      <Rect x={6.5} y={6} width={23} height={27} rx={3} fill="#99AAB5" />
      <Rect x={9.5} y={11} width={17} height={19} rx={1.5} fill="#E1E8ED" />
      <Rect x={11.5} y={16} width={13} height={1.8} rx={0.9} fill="#AAB8C2" />
      <Rect x={11.5} y={20} width={13} height={1.8} rx={0.9} fill="#AAB8C2" />
      <Rect x={11.5} y={24} width={8} height={1.8} rx={0.9} fill="#AAB8C2" />
      <Rect x={11} y={4} width={14} height={6.5} rx={3.25} fill="#66757F" />
      <Circle cx={18} cy={5} r={2.3} fill="#66757F" />
      <Circle cx={18} cy={5} r={1} fill="#CCD6DD" />
    </Svg>
  );
}

// Notification-center type-badge glyphs (design: DM ✉️ · channel 📣 · public post ✍️). Rendered at
// ~10px inside a 20px badge circle, so — like the comment bubble above — each is a single-tone
// near-white silhouette (#f5f5f7): crisp at badge size and pixel-identical on every device, where
// the colorful Twemoji artwork would smear into noise. Flap/cut-out strokes use the badge's own
// surface color (#1c1c1e, colors.surface — the app is dark-only) so they read as negative space.
function EnvelopeIcon({size, style}: PrecompiledIconProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" style={style}>
      <Rect x={2} y={6} width={28} height={20} rx={3.5} fill="#f5f5f7" />
      <Path
        d="M4.5 9.5 L16 18.5 L27.5 9.5"
        stroke="#1c1c1e"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

function MegaphoneIcon({size, style}: PrecompiledIconProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" style={style}>
      <Path
        fill="#f5f5f7"
        d="M27.5 3.5c.8-.4 1.5.1 1.5 1v19c0 .9-.7 1.4-1.5 1.1C22 22.4 16.5 21 10 21V7c6.5 0 12-1.4 17.5-3.5z"
      />
      <Rect x={3} y={8} width={5.5} height={12} rx={2.4} fill="#f5f5f7" />
      <Path fill="#f5f5f7" d="M10.5 22.5h5.5v5c0 1.4-1.1 2.5-2.5 2.5h-.5c-1.4 0-2.5-1.1-2.5-2.5v-5z" />
    </Svg>
  );
}

function WritingIcon({size, style}: PrecompiledIconProps): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" style={style}>
      <Path
        fill="#f5f5f7"
        d="M23.6 4.3l4.1 4.1c1 1 1 2.6 0 3.5l-2 2-7.6-7.6 2-2c1-1 2.6-1 3.5 0z"
      />
      <Path
        fill="#f5f5f7"
        d="M16.6 7.8l7.6 7.6L10.9 28.7c-.3.3-.6.5-1 .6l-5.4 1.6c-.8.2-1.5-.5-1.3-1.3l1.6-5.4c.1-.4.3-.7.6-1L16.6 7.8z"
      />
    </Svg>
  );
}

// Glyphs rendered as precompiled native react-native-svg components rather than a parsed XML
// string — these take priority over the (still string-based) Twemoji lookup below.
const PRECOMPILED: Record<string, (props: PrecompiledIconProps) => React.JSX.Element> = {
  [strip('💬')]: CommentBubbleIcon,
  [strip('📋')]: ClipboardIcon,
  [strip('✉️')]: EnvelopeIcon,
  [strip('📣')]: MegaphoneIcon,
  [strip('✍️')]: WritingIcon,
};

export interface IconProps {
  /** The emoji character to render (e.g. "💬"). */
  name: string;
  /** Square size in px (default 16). */
  size?: number;
  style?: StyleProp<ViewStyle>;
}

export function Icon({name, size = 16, style}: IconProps): React.JSX.Element | null {
  const key = strip(name);
  const Precompiled = PRECOMPILED[key];
  if (Precompiled) return <Precompiled size={size} style={style} />;
  const xml = SVG[key];
  if (!xml) return null;
  return <SvgXml xml={xml} width={size} height={size} style={style} />;
}

/** True when we have a Twemoji SVG (or a precompiled override) for this glyph — lets callers
 *  decide row-vs-inline. */
export function hasIcon(name: string): boolean {
  const key = strip(name);
  return Boolean(SVG[key]) || Boolean(PRECOMPILED[key]);
}
