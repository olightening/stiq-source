/**
 * Typography — the single source of truth for type in the app.
 *
 * Per the Stiq design system, the app ships NO bundled webfonts. UI text uses the platform
 * system font (San Francisco on iOS, Roboto on Android); the "Stiq." wordmark uses the
 * platform serif (Georgia on iOS, the generic serif / Noto Serif on Android); codes, npubs,
 * and keys use the platform monospace. Weight is expressed with `fontWeight` — the system
 * fonts carry every weight, so there is no per-weight family to pin.
 */
import React from 'react';
import {Platform, Text, TextInput, type TextStyle} from 'react-native';

export const fonts = {
  /** "Stiq." wordmark — platform serif. Pair with an explicit `fontWeight`. */
  serif: Platform.select({ios: 'Georgia', default: 'serif'}) as string,
  serifRegular: Platform.select({ios: 'Georgia', default: 'serif'}) as string,
  /** npub / url / invite-code mono runs. */
  mono: Platform.select({ios: 'Menlo', android: 'monospace', default: 'monospace'}) as string,
} as const;

/**
 * App-wide text default — `includeFontPadding: false` on every `<Text>`/`<TextInput>`.
 *
 * Android adds ascent/descent padding to text that CSS has no equivalent for, making line boxes
 * taller and pushing glyphs down relative to the design. Killing it globally makes vertical
 * rhythm match the CSS line-box model everywhere; explicit per-style props still win because the
 * base is appended first. It does NOT set a default `fontFamily`, leaving the system font in place.
 *
 * Best-effort and idempotent: guarded so a future RN that drops `.render` simply no-ops.
 */
export function installTextDefaults(): void {
  const base = {includeFontPadding: false} as const;
  for (const Comp of [Text, TextInput] as Array<{render?: (...a: unknown[]) => React.ReactElement; __stiqPatched?: boolean}>) {
    const orig = Comp.render;
    if (typeof orig !== 'function' || Comp.__stiqPatched) continue;
    Comp.render = function patched(this: unknown, ...args: unknown[]): React.ReactElement {
      const el = orig.apply(this, args);
      const prev = (el.props as {style?: unknown}).style;
      return React.cloneElement(el, {style: [base, prev]} as Partial<{style: unknown}>);
    };
    Comp.__stiqPatched = true;
  }
}

/** Convenience: `includeFontPadding: false` for one-off styles that bypass the global default. */
export const tight: TextStyle = {includeFontPadding: false};
