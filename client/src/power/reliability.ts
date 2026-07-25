/**
 * Battery-optimization exemption + OEM reliability guidance (W3, Tor stability+speed).
 *
 * Android's Doze/App-Standby battery optimizer — and, on top of it, OEM-specific background-task
 * killers (MIUI, Huawei EMUI/Magic UI, ColorOS, Funtouch/OriginOS, OnePlus OxygenOS, Flyme, ASUS) —
 * is a leading cause of the background Tor daemon getting frozen or killed, which the rest of the
 * W1/W2 dormancy+reattach work depends on. This module is the JS half:
 *
 *  1. A thin, absent-safe wrapper over the native `StiqPower` module (isIgnoringBatteryOptimizations /
 *     requestIgnoreBatteryOptimizations / getDeviceVendorInfo) — mirrors the duck-typed,
 *     never-throws idiom used by tor/dormancy.ts and push/unifiedPush.ts. Every wrapper degrades to a
 *     harmless, optimistic fallback when the native module is absent (iOS, jest, an older build), so
 *     callers never null-check `NativeModules.StiqPower` themselves.
 *
 *  2. `classifyOem()` — a pure, case-insensitive manufacturer/brand → reliability tier classifier.
 *     "aggressive" OEMs are documented (dontkillmyapp.com-style) to kill/throttle background apps far
 *     more readily than stock Android; "moderate" (Samsung) is less aggressive but still has its own
 *     battery-optimization UI; everything else is treated as "clean" (stock-ish AOSP behavior).
 *
 *  3. `RELIABILITY_COPY` — every user-facing string in ONE exported object (title, button labels, the
 *     recents-lock tip, and the per-vendor step lists) so a future i18n pass has a single place to
 *     translate from. ReliabilitySheet.tsx reads from this object; it holds no copy of its own.
 *
 *  4. `maybePromptReliability()` — the single decision function Phase C's App.tsx nudge will call
 *     (contract C3 — NOT wired up here). Returns true when the device is worth nagging about
 *     (aggressive OEM, or the exemption genuinely isn't granted) and the user hasn't already dismissed
 *     the one-time prompt. The dismissal flag is persisted in AsyncStorage — the same storage every
 *     other settings flag in this app uses (see lock/pinPrefs.ts, notifications/prefs.ts) — not a new
 *     mechanism.
 */
import {NativeModules} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Native module wrapper (absent-safe) ────────────────────────────────────────────────────────

/** The subset of the native `StiqPower` module this wrapper duck-types onto. */
export interface StiqPowerNative {
  isIgnoringBatteryOptimizations?: () => Promise<boolean>;
  requestIgnoreBatteryOptimizations?: () => void;
  getDeviceVendorInfo?: () => Promise<DeviceVendorInfo>;
}

export interface DeviceVendorInfo {
  manufacturer: string;
  brand: string;
  model: string;
}

const EMPTY_VENDOR_INFO: DeviceVendorInfo = {manufacturer: '', brand: '', model: ''};

function nativeModule(): StiqPowerNative | undefined {
  return (NativeModules as {StiqPower?: StiqPowerNative}).StiqPower;
}

/** Whether the native StiqPower module is compiled into this build. */
export function hasPowerModule(): boolean {
  return !!nativeModule();
}

/**
 * Whether Stiq is currently exempt from battery optimization. Resolves `true` (optimistic — "assume
 * no problem") when the native module or method is absent (iOS, jest, an older build) or the call
 * throws, so a build without this module never blocks or mis-nags on a question it can't answer.
 */
export async function isIgnoringBatteryOptimizations(
  native: StiqPowerNative | undefined = nativeModule(),
): Promise<boolean> {
  try {
    if (!native?.isIgnoringBatteryOptimizations) return true;
    return await native.isIgnoringBatteryOptimizations();
  } catch {
    return true;
  }
}

/** Fire the OS "ignore battery optimizations" request dialog for this app. No-op (never throws)
 *  when the native module or method is absent. */
export function requestIgnoreBatteryOptimizations(
  native: StiqPowerNative | undefined = nativeModule(),
): void {
  try {
    native?.requestIgnoreBatteryOptimizations?.();
  } catch {
    // native module absent or the call failed — ignore
  }
}

/** Device manufacturer/brand/model. Resolves empty strings (→ classifyOem 'clean') when the native
 *  module or method is absent or the call throws. */
export async function getDeviceVendorInfo(
  native: StiqPowerNative | undefined = nativeModule(),
): Promise<DeviceVendorInfo> {
  try {
    if (!native?.getDeviceVendorInfo) return EMPTY_VENDOR_INFO;
    return await native.getDeviceVendorInfo();
  } catch {
    return EMPTY_VENDOR_INFO;
  }
}

// ─── OEM classification ──────────────────────────────────────────────────────────────────────────

export type OemTier = 'aggressive' | 'moderate' | 'clean';

/** Guidance-copy lookup key (`RELIABILITY_COPY.oem`). One entry per vendor family; unrecognized or
 *  'clean'-tier devices fall back to 'generic'. */
export type OemVendorKey =
  | 'xiaomi'
  | 'huawei'
  | 'oppo'
  | 'vivo'
  | 'oneplus'
  | 'meizu'
  | 'asus'
  | 'samsung'
  | 'generic';

interface VendorMatch {
  key: OemVendorKey;
  tier: OemTier;
  /** Lowercase substrings matched against "manufacturer brand". */
  needles: readonly string[];
}

// Order matters only in that the first match wins; families don't overlap so it's not load-bearing.
// dontkillmyapp.com-documented "aggressive" families first, then Samsung ("moderate").
const VENDOR_MATCHES: readonly VendorMatch[] = [
  {key: 'xiaomi', tier: 'aggressive', needles: ['xiaomi', 'redmi', 'poco']},
  {key: 'huawei', tier: 'aggressive', needles: ['huawei', 'honor']},
  {key: 'oppo', tier: 'aggressive', needles: ['oppo', 'realme']},
  {key: 'vivo', tier: 'aggressive', needles: ['vivo', 'iqoo']},
  {key: 'oneplus', tier: 'aggressive', needles: ['oneplus']},
  {key: 'meizu', tier: 'aggressive', needles: ['meizu']},
  {key: 'asus', tier: 'aggressive', needles: ['asus']},
  {key: 'samsung', tier: 'moderate', needles: ['samsung']},
];

function matchVendor(manufacturer: string, brand: string): VendorMatch | undefined {
  const hay = `${manufacturer} ${brand}`.toLowerCase();
  return VENDOR_MATCHES.find(v => v.needles.some(n => hay.includes(n)));
}

/** Case-insensitive manufacturer/brand → reliability tier. Unknown vendors default to 'clean'. */
export function classifyOem(manufacturer: string, brand: string): OemTier {
  return matchVendor(manufacturer, brand)?.tier ?? 'clean';
}

/** Which `RELIABILITY_COPY.oem` entry to show for this device. Falls back to 'generic' for
 *  unrecognized or 'clean'-tier vendors (they still get the stock-Android step list). */
export function oemGuidanceKey(manufacturer: string, brand: string): OemVendorKey {
  return matchVendor(manufacturer, brand)?.key ?? 'generic';
}

// ─── Copy (single object — future i18n pulls from here) ─────────────────────────────────────────

interface OemGuidance {
  /** Short vendor-family label shown as the guidance section heading. */
  label: string;
  /** Ordered steps, dontkillmyapp.com-style, specific to this OEM's extra settings surface. */
  steps: readonly string[];
}

export const RELIABILITY_COPY = {
  sheetTitle: 'Reliability',
  statusGrantedLabel: 'Background connection allowed',
  statusNotGrantedLabel: 'Tor may disconnect in the background',
  statusGrantedSub: "Android won't stop Stiq's connection to save battery.",
  statusNotGrantedSub:
    'Battery optimization can pause or kill the Tor connection while Stiq is in the background.',
  statusStepsPendingLabel: 'One more step for your device',
  statusStepsPendingSub:
    'Background connection is allowed, but this device can still pause Stiq. Follow the steps below, ' +
    'then mark them done.',
  allowButtonLabel: 'Allow background connection',
  allowButtonSub: 'Opens the Android system dialog — no extra permissions beyond what you approve.',
  ackButtonLabel: "I've done these steps",
  ackedLabel: '✓ Steps marked done',
  ackedUndoLabel: 'Undo',
  recheckingLabel: 'Checking…',
  recentsTipTitle: 'Lock Stiq in your recents screen',
  recentsTipBody:
    'Open the recent-apps switcher, find Stiq, and tap the lock/pin icon (long-press the app icon or ' +
    'the card, depending on your device) so the system is less likely to swipe it away.',
  oemSectionTitle: (vendorLabel: string): string => `Extra steps for ${vendorLabel}`,
  oem: {
    xiaomi: {
      label: 'MIUI / HyperOS (Xiaomi, Redmi, POCO)',
      steps: [
        'Settings → Apps → Manage apps → Stiq → Autostart → turn ON',
        'Settings → Battery & performance → App battery saver → Stiq → No restrictions',
        'Recent apps → long-press the Stiq card → tap the lock icon',
      ],
    },
    huawei: {
      label: 'EMUI / Magic UI (Huawei, Honor)',
      steps: [
        'Settings → Apps → Apps → Stiq → Battery → App launch → switch to Manage manually → enable ' +
          'Auto-launch, Secondary launch, and Run in background',
        'Settings → Battery → App launch → Stiq → same manual toggles',
        'Recent apps → long-press the Stiq card → tap the lock icon',
      ],
    },
    oppo: {
      label: 'ColorOS (OPPO, Realme)',
      steps: [
        'Settings → Battery → App battery management → Stiq → allow background running / disable ' +
          'battery optimization',
        'Settings → Privacy permissions → Startup manager → Stiq → allow autostart',
        'Recent apps → long-press the Stiq card → tap the lock icon',
      ],
    },
    vivo: {
      label: 'Funtouch OS / OriginOS (vivo, iQOO)',
      steps: [
        'Settings → Battery → Background power consumption management → Stiq → allow',
        'Settings → More settings → Applications → Autostart → enable Stiq',
        'Recent apps → long-press the Stiq card → tap the lock icon',
      ],
    },
    oneplus: {
      label: 'OxygenOS (OnePlus)',
      steps: [
        'Settings → Battery → Battery optimization → Stiq → Don\'t optimize',
        'Recent apps → swipe down on the Stiq card (or long-press) → tap the lock icon',
      ],
    },
    meizu: {
      label: 'Flyme (Meizu)',
      steps: [
        'Settings → Battery → Background management → Stiq → allow background activity',
        'Settings → Application management → Permissions → Stiq → Autostart → enable',
      ],
    },
    asus: {
      label: 'ASUS (ZenUI)',
      steps: [
        'Settings → Battery → Battery optimization → Stiq → Don\'t optimize',
        'Mobile Manager → AutoStart Manager → enable Stiq',
      ],
    },
    samsung: {
      label: 'One UI (Samsung)',
      steps: [
        'Settings → Apps → Stiq → Battery → Unrestricted',
        'Settings → Battery → Background usage limits → make sure Stiq is not in "Sleeping apps" or ' +
          '"Deep sleeping apps"',
      ],
    },
    generic: {
      label: 'this device',
      steps: [
        'Settings → Apps → Stiq → Battery → set to "Unrestricted" / "No restrictions" / "Don\'t optimize"',
      ],
    },
  } as Record<OemVendorKey, OemGuidance>,
};

/** Resolve the OEM guidance entry (label + steps) for a device's manufacturer/brand. */
export function getOemGuidance(manufacturer: string, brand: string): OemGuidance {
  return RELIABILITY_COPY.oem[oemGuidanceKey(manufacturer, brand)];
}

// ─── One-time-prompt dismissal (persisted in the app's existing AsyncStorage settings store) ────

const DISMISSED_KEY = 'stiq.power.reliabilityPromptDismissed';

/** Whether the user has already dismissed the one-time reliability nudge (Phase C's App.tsx call
 *  site). Defaults to false (not dismissed) on any read failure. */
export async function hasDismissedReliabilityPrompt(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(DISMISSED_KEY)) === 'true';
  } catch {
    return false;
  }
}

/** Persist the user's dismissal (or un-dismissal, for tests/debug) of the one-time nudge. */
export async function setReliabilityPromptDismissed(dismissed: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(DISMISSED_KEY, dismissed ? 'true' : 'false');
  } catch {
    // best effort — matches lock/pinPrefs.ts and notifications/prefs.ts
  }
}

// ─── OEM-steps acknowledgement (clears the "Action needed" badge on aggressive OEMs) ────────────

const OEM_STEPS_ACK_KEY = 'stiq.power.oemStepsAcknowledged';

/** Whether the user has told us they've followed the OEM-specific manual steps (aggressive OEMs
 *  only — see `reliabilityActionNeeded`). Defaults to false (not acknowledged) on any read failure. */
export async function hasAcknowledgedOemSteps(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(OEM_STEPS_ACK_KEY)) === 'true';
  } catch {
    return false;
  }
}

/** Persist the user's acknowledgement (or un-acknowledgement, via the sheet's Undo) of the OEM
 *  manual steps. */
export async function setOemStepsAcknowledged(acknowledged: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(OEM_STEPS_ACK_KEY, acknowledged ? 'true' : 'false');
  } catch {
    // best effort — matches lock/pinPrefs.ts and notifications/prefs.ts
  }
}

// ─── Decision authority ───────────────────────────────────────────────────────────────────────────

/**
 * Whether the reliability row/sheet should still nag. Not exempt at all → always. Aggressive OEM →
 * until the user acknowledges the manual steps (those OEMs kill background apps even when the stock
 * exemption is granted). Otherwise clear.
 *
 * The SINGLE source of truth for the Settings row badge ("OK" / "Action needed") and the sheet's
 * status card — both must derive from this predicate so they never disagree, and so the user always
 * has a way to resolve the warning (grant the exemption, then acknowledge the OEM steps).
 */
export function reliabilityActionNeeded(
  exempt: boolean,
  tier: OemTier,
  oemStepsAcknowledged: boolean,
): boolean {
  return !exempt || (tier === 'aggressive' && !oemStepsAcknowledged);
}

/**
 * Whether the one-time reliability nudge should show. True when the device is worth warning about
 * — an "aggressive" OEM (regardless of exemption state, since those OEMs often kill background apps
 * even when the stock Android exemption is granted) OR the battery-optimization exemption genuinely
 * isn't granted — AND the user hasn't already dismissed the prompt.
 *
 * EXPORTED for Phase C's App.tsx one-time nudge (cross-slot contract C3). Not called from anywhere
 * in this slot — App.tsx is out of scope here.
 */
export async function maybePromptReliability(): Promise<boolean> {
  if (await hasDismissedReliabilityPrompt()) return false;
  const [vendor, exempt] = await Promise.all([getDeviceVendorInfo(), isIgnoringBatteryOptimizations()]);
  const tier = classifyOem(vendor.manufacturer, vendor.brand);
  return tier === 'aggressive' || !exempt;
}
