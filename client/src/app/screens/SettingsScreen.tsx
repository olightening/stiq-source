/**
 * SettingsScreen — slide-up modal opened by tapping the "Stiq." header.
 *
 * Sections (in order):
 *   1. Profile     — tap to open own profile editor
 *   2. Drafts      — view/resume saved drafts
 *   3. Appearance  — dark / light mode toggle
 *   4. Storage     — delete rendered media, clear old cache
 *   5. Security    — the PIN-lock toggle. Its ONLY row, so the whole section (header included) is
 *                    gated on PIN_LOCK_UI (config.ts) and is ABSENT from today's builds — see bugs
 *                    5+6. The emergency kill switch this line used to also claim lives in the danger
 *                    footer (Sign out / Leave <community>), not here, and is unaffected.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {Press} from '../../ui/Press';
import {SwipeBackView} from '../../ui/SwipeBack';
import {useSwipeOptOut} from '../../ui/swipeOptOut';
import {colors, fontSerif, radius, space, type as typeScale, weight, type Palette, DENSE_MAX_FONT_SCALE} from '../../ui/theme';
import {GradientAvatar} from '../../ui/GradientAvatar';
import type {Profile} from '../../profile/profile';
import {shortenNpub} from '../../util/npub';
import {communityId, type EnrolledCommunity} from '../../communities/communityStore';
import type {KeySlot} from '../../keys/keyRing';
import {validateEndpoint} from '../../media/mediaSettings';
import {isTorBrowserId, type InstalledBrowser} from '../../browser/browserData';
import {describeConnection, type ConnectionState} from '../../connection';
import type {ConnectionPhase} from '../../tor/ladder';
import {GUIDED_AUTO_LADDER, PIN_LOCK_UI} from '../../config';
import {DEFAULT_TOR_PREFS, type TorConnectionPrefs} from '../../tor/torSettings';
import type {UpdateInfo} from '../../update/updater';
import {ConnectionSheet, MODE_LABEL} from './ConnectionSheet';
import {RelaysSheet} from './RelaysSheet';
import type {RelaysSnapshot} from '../../communities/communityStore';
import {SyncDebugScreen} from './SyncDebugScreen';
import {TokenStatusScreen} from './TokenStatusScreen';
import type {TokenEconomyStatus} from '../tokenEconomyStatus';
import {ReliabilitySheet} from './ReliabilitySheet';
import {
  classifyOem,
  getDeviceVendorInfo,
  hasAcknowledgedOemSteps,
  isIgnoringBatteryOptimizations,
  reliabilityActionNeeded,
} from '../../power/reliability';

export interface SettingsScreenProps {
  visible: boolean;
  onClose: () => void;
  /** Current user's own profile. */
  profile?: Profile | null;
  /** Open the full profile editor view. */
  onOpenProfile?: () => void;
  /** Open the drafts list. */
  onOpenDrafts?: () => void;
  /** Open the Events — Organizer flow (Your events; README fact #2: reached from Settings). */
  onOpenYourEvents?: () => void;
  /** Called when the user requests a media cache clear (all rendered media). */
  onClearMediaCache?: () => void;
  /** Called when the user requests the quick "clear 30+ day events" action. */
  onClearEventCache?: () => void;
  /** Preview: how many cached feed events are older than `olderThanSeconds` (all ages when omitted).
   *  Drives the live count shown in the Manage-data sheet. */
  onCountCachedEvents?: (olderThanSeconds?: number) => number;
  /** Fine-grained delete: purge the selected type(s) of cached data within the chosen date range
   *  (`olderThanSeconds` undefined = everything cached). Returns the actual counts removed, so the
   *  UI can confirm the delete rather than leaving it silent. */
  onDeleteCachedData?: (opts: {media: boolean; events: boolean; olderThanSeconds?: number}) => {events: number; media: number};
  /** Whether PIN lock is currently enabled. */
  pinEnabled?: boolean;
  /** Toggle the PIN lock on/off. When disabling, the user is prompted to verify their PIN first. */
  onSetPinEnabled?: (enabled: boolean) => void;
  /** Verify that a PIN string matches the standard slot. */
  onVerifyPin?: (pin: string) => Promise<boolean>;
  /** Emergency kill switch — wipes all local data and resets the app. */
  onWipe?: () => void;
  /** Load the list of enrolled communities (async, called on modal open). */
  onLoadCommunities?: () => Promise<{list: EnrolledCommunity[]; activeId: string | null}>;
  /** Switch the active community (relay reconnects automatically). */
  onSwitchCommunity?: (id: string) => void;
  /** Leave a community — wipes its identity + cached data on-device (irreversible). */
  onRemoveCommunity?: (id: string) => void;
  /** Start onboarding in ADD mode to join ANOTHER community (additive; keeps existing ones). */
  onJoinAnotherCommunity?: () => void;
  /** Load the multi-identity key ring (async, called on modal open). */
  onLoadKeySlots?: () => Promise<{slots: KeySlot[]; activeId: string | null}>;
  /** Switch the active identity by key-ring slot id. */
  onSwitchIdentity?: (slotId: string) => void;
  /** Leave a single identity (key-ring slot) — wipes that identity (drops the community only when
   *  it was the last identity in it). Irreversible. */
  onRemoveIdentity?: (slotId: string) => void;
  /** Start onboarding to add a new identity (the only action behind "Add new identity"). */
  onAddIdentity?: () => void;
  /** Read the user's configured Blossom upload endpoint ('' = uploads disabled). */
  onGetBlossomEndpoint?: () => string;
  /** Persist a new Blossom upload endpoint. */
  onSetBlossomEndpoint?: (url: string) => void;
  /** Read the user's preferred external browser launch id ('' = none chosen). */
  onGetPreferredBrowser?: () => string;
  /** Persist the preferred external browser (package/scheme id; '' clears it). */
  onSetPreferredBrowser?: (id: string) => void;
  /** List installed browsers (for the picker). */
  onListBrowsers?: () => Promise<InstalledBrowser[]>;
  /** Live Tor connection state (drives the CONNECTION status row). */
  connection?: ConnectionState;
  /**
   * Guided-ladder plain-language phase (T2, GUIDED_AUTO_LADDER). Forwarded to the ConnectionSheet so
   * its "Automatic" status card narrates the real rung. Null when the flag is off (preset-first sheet).
   */
  torPhase?: ConnectionPhase | null;
  /** Read the user's Tor connection preferences (mode + advanced). */
  onGetConnectionPrefs?: () => TorConnectionPrefs;
  /** Persist new Tor connection preferences AND reconnect under them. */
  onApplyConnectionPrefs?: (prefs: TorConnectionPrefs) => void;
  /** Read the active community's relay snapshot (gates the RELAYS row + drives its sheet). */
  onGetRelaySnapshot?: () => RelaysSnapshot | null;
  /** Add a member relay (normalized ws onion url + optional members-only key). */
  onAddRelay?: (url: string, onionAuthKey: string | null) => Promise<void>;
  /** Remove a member-added relay by onion host. */
  onRemoveRelay?: (host: string) => Promise<void>;
  /** Mute ("close from") a relay by full spec. */
  onMuteRelay?: (spec: {url: string; onionAuthKey?: string | null}) => Promise<void>;
  /** Un-mute a relay by onion host. */
  onUnmuteRelay?: (host: string) => Promise<void>;
  /** Sign out of the active session (without wiping local data). */
  onSignOut?: () => void;
  /** App version string (e.g. "1.4.2"). */
  version?: string;
  /**
   * T9 (APK_UPDATES): whether signed in-app updates are enabled for this build. When false — or when
   * `onCheckForUpdate` is absent (the active community carries no update repo) — the entire App-updates
   * section is hidden and no update check ever runs (ship-dark, data-driven double gate).
   */
  apkUpdatesEnabled?: boolean;
  /** Fetch+verify the community's signed F-Droid index over Tor; resolves an offer or null (up to date).
   *  Present only when the active community publishes a repo. */
  onCheckForUpdate?: () => Promise<UpdateInfo | null>;
  /** Download the offered APK over Tor, verify its signer/version, and launch the OS install prompt. */
  onInstallUpdate?: (info: UpdateInfo) => Promise<void>;
  /**
   * Token/economy status (T5.1/F18): per-purpose wallet counts, the C5 per-domain provisioning
   * (drift) verdict, and recent token-relevant diagnostic log entries. Drives the `__DEV__`-gated
   * "Token status" diagnostics row/screen below — absent entirely from a member build's visible
   * surface. See AppRuntime.ts's AppSnapshot.tokenStatus doc for exactly what it contains (read-only,
   * no secrets).
   */
  tokenStatus?: TokenEconomyStatus;
  /** Force-refresh the per-purpose wallet counts backing tokenStatus (an async SecureStorage read) —
   *  called when the token-status screen opens / the user taps refresh. */
  onRefreshTokenStatus?: () => void;
}

export function SettingsScreen({
  visible,
  onClose,
  profile,
  onOpenProfile,
  onOpenDrafts,
  onOpenYourEvents,
  onClearMediaCache,
  onClearEventCache,
  onCountCachedEvents,
  onDeleteCachedData,
  pinEnabled,
  onSetPinEnabled,
  onVerifyPin,
  onLoadCommunities,
  onJoinAnotherCommunity,
  onLoadKeySlots,
  onSwitchIdentity,
  onRemoveIdentity,
  onGetBlossomEndpoint,
  onSetBlossomEndpoint,
  onGetPreferredBrowser,
  onSetPreferredBrowser,
  onListBrowsers,
  connection,
  torPhase,
  onGetConnectionPrefs,
  onApplyConnectionPrefs,
  onGetRelaySnapshot,
  onAddRelay,
  onRemoveRelay,
  onMuteRelay,
  onUnmuteRelay,
  onSignOut,
  version,
  apkUpdatesEnabled,
  onCheckForUpdate,
  onInstallUpdate,
  tokenStatus,
  onRefreshTokenStatus,
}: SettingsScreenProps): React.JSX.Element {
  // Stands this page's own swipe-back down for touches beginning on the Blossom URL field below (a
  // TextInput's own selection drag doesn't join JS responder negotiation) — spread onto that
  // TextInput; see the opt-out there for what it protects.
  const optOut = useSwipeOptOut();
  const [clearing, setClearing] = useState(false);
  // Fine-grained "Manage cached data" sub-sheet (type toggles + date-range presets).
  const [manageDataOpen, setManageDataOpen] = useState(false);
  const [communities, setCommunities] = useState<EnrolledCommunity[]>([]);
  // Identity slots ARE the switcher rows: one per (community, on-device identity) pair. A member can
  // hold several identities in the same community (joined twice), so we list per identity — not per
  // community — otherwise a second identity would hide the first. Each row shows its own npub +
  // gradient; the community name is looked up by relay onion.
  const [slots, setSlots] = useState<KeySlot[]>([]);
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);
  // Tapping the active community opens this sheet (the list of all identities + Join another).
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Blossom upload endpoint: input + "saved" confirmation, seeded when the modal opens.
  const [blossomInput, setBlossomInput] = useState('');
  const [blossomSaved, setBlossomSaved] = useState(false);

  // Default browser: the picker sheet + the installed-browser list, loaded on open.
  const [browserSheetOpen, setBrowserSheetOpen] = useState(false);
  const [preferredBrowser, setPreferredBrowser] = useState('');
  const [browsers, setBrowsers] = useState<InstalledBrowser[]>([]);

  // Connection mode sheet (opened from the CONNECTION row); prefs seeded when the modal opens.
  const [connectionSheetOpen, setConnectionSheetOpen] = useState(false);
  // Relays sheet (opened from the RELAYS row); the sheet reads its own snapshot when it opens.
  const [relaysSheetOpen, setRelaysSheetOpen] = useState(false);
  // Reliability sheet (battery-optimization exemption + OEM guidance, W3). The row's status pill is
  // seeded here on open; the sheet itself re-checks independently once it's visible.
  const [reliabilitySheetOpen, setReliabilitySheetOpen] = useState(false);
  const [reliabilityExempt, setReliabilityExempt] = useState<boolean | null>(null);
  // Dev-only sync diagnostics sub-screen (never rendered in a member build — see __DEV__ gate below).
  const [syncDebugOpen, setSyncDebugOpen] = useState(false);
  // Dev-only token/economy status sub-screen (T5.1/F18 — same __DEV__ gate as sync diagnostics).
  const [tokenStatusOpen, setTokenStatusOpen] = useState(false);
  const [connectionPrefs, setConnectionPrefs] = useState<TorConnectionPrefs>(DEFAULT_TOR_PREFS);

  // ── App updates (T9, APK_UPDATES) ──
  // `updateChecked` distinguishes "not checked yet" from "checked, nothing new" so we only show the
  // "up to date" line AFTER an actual check. `updateInfo` non-null ⇒ an offer to install.
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateChecked, setUpdateChecked] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const showUpdates = apkUpdatesEnabled === true && onCheckForUpdate !== undefined;

  // The parent (App) recreates these getter/loader props as fresh inline arrows on every render, and
  // App re-renders on every runtime emit (up to ~4x/s during a relay sync) while this modal stays
  // mounted. Keying the seed effects below on those callbacks would re-run them per emit — wiping the
  // Blossom field the user is mid-edit, re-firing the native browser enumeration, and re-issuing the
  // async community/key-slot loads. These are open-time seeds, so we hold the latest callbacks in a
  // ref (refreshed every render, no re-run) and drive each effect off `visible` alone.
  const cbs = useRef({
    onGetConnectionPrefs,
    onLoadCommunities,
    onLoadKeySlots,
    onGetBlossomEndpoint,
    onGetPreferredBrowser,
    onListBrowsers,
    onRefreshTokenStatus,
  });
  cbs.current = {
    onGetConnectionPrefs,
    onLoadCommunities,
    onLoadKeySlots,
    onGetBlossomEndpoint,
    onGetPreferredBrowser,
    onListBrowsers,
    onRefreshTokenStatus,
  };

  useEffect(() => {
    if (!visible) return;
    setConnectionPrefs(cbs.current.onGetConnectionPrefs?.() ?? DEFAULT_TOR_PREFS);
  }, [visible]);

  // Seed the reliability status pill (battery-optimization exemption + OEM tier) each time the
  // Settings modal opens. The sheet itself re-checks live on its own open/focus — this is only for
  // the row's "OK" / "Action needed" summary.
  useEffect(() => {
    if (!visible) return;
    void Promise.all([
      isIgnoringBatteryOptimizations(),
      getDeviceVendorInfo(),
      hasAcknowledgedOemSteps(),
    ]).then(([exempt, vendor, acked]) => {
      const tier = classifyOem(vendor.manufacturer, vendor.brand);
      setReliabilityExempt(!reliabilityActionNeeded(exempt, tier, acked));
    });
  }, [visible]);

  // Load communities (for name lookup) + identity slots (the rows) whenever the modal opens.
  useEffect(() => {
    if (!visible) return;
    if (cbs.current.onLoadCommunities) {
      void cbs.current.onLoadCommunities().then(({list}) => setCommunities(list));
    }
    if (cbs.current.onLoadKeySlots) {
      void cbs.current.onLoadKeySlots().then(({slots: list, activeId}) => {
        // Stable, deterministic order so rows don't jump between opens.
        setSlots([...list].sort((a, b) => a.enrolledAt - b.enrolledAt));
        setActiveSlotId(activeId);
      });
    }
  }, [visible]);

  // Community descriptor by id (relay onion), for showing each identity's community name.
  const communityById = useMemo(() => {
    const map = new Map<string, EnrolledCommunity>();
    for (const c of communities) map.set(c.id, c);
    return map;
  }, [communities]);

  // Seed the Blossom field from the persisted value each time the modal opens.
  useEffect(() => {
    if (!visible) return;
    setBlossomInput(cbs.current.onGetBlossomEndpoint?.() ?? '');
    setBlossomSaved(false);
  }, [visible]);

  // Seed the preferred browser + refresh the installed-browser list each time the modal opens.
  useEffect(() => {
    if (!visible) return;
    setPreferredBrowser(cbs.current.onGetPreferredBrowser?.() ?? '');
    if (cbs.current.onListBrowsers) {
      void cbs.current.onListBrowsers().then(setBrowsers).catch(() => setBrowsers([]));
    }
  }, [visible]);

  // Refresh the token/economy wallet counts (T5.1/F18) each time the token-status sub-screen opens —
  // gated on tokenStatusOpen (not the outer `visible`) so it fires exactly when that screen is shown,
  // not on every Settings-modal open. Reads the callback via the ref (see cbs above) rather than
  // depending on it directly: App.tsx recreates onRefreshTokenStatus as a fresh inline arrow on every
  // emit, and this screen's own refresh calls emit() again — depending on the callback directly would
  // re-run this effect on every relay-sync tick while the sub-screen stays open.
  useEffect(() => {
    if (!tokenStatusOpen) return;
    cbs.current.onRefreshTokenStatus?.();
  }, [tokenStatusOpen]);

  // PIN verification dialog — shown when the user tries to disable PIN lock
  const [pinDialogVisible, setPinDialogVisible] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState(false);

  const handleClearMedia = (): void => {
    Alert.alert(
      'Delete rendered media?',
      'All locally cached images will be removed. They will reload when you scroll past them.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setClearing(true);
            onClearMediaCache?.();
            setTimeout(() => setClearing(false), 500);
          },
        },
      ],
    );
  };

  const handleClearCache = (): void => {
    Alert.alert(
      'Clear old cache?',
      'Events older than 30 days will be removed from local storage. Recent posts remain unaffected.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Clear', style: 'destructive', onPress: () => { onClearEventCache?.(); }},
      ],
    );
  };

  // App updates: run the Tor index check, storing the result (or an inline error) in local state.
  // Never throws out of the sheet — a failed check surfaces as a one-line message, not a crash.
  const handleCheckForUpdate = (): void => {
    if (!onCheckForUpdate || updateChecking) return;
    setUpdateChecking(true);
    setUpdateError(null);
    setUpdateChecked(false);
    setUpdateInfo(null);
    void onCheckForUpdate()
      .then(info => {
        setUpdateInfo(info);
        setUpdateChecked(true);
      })
      .catch(() => setUpdateError('Update check failed — are you connected?'))
      .finally(() => setUpdateChecking(false));
  };

  // Install the offered update: download+verify over Tor, then the native PackageInstaller shows the
  // OS confirm dialog. Guarded against a double-tap while a download is in flight.
  const handleInstallUpdate = (): void => {
    if (!onInstallUpdate || !updateInfo || installing) return;
    setInstalling(true);
    setUpdateError(null);
    void onInstallUpdate(updateInfo)
      .catch(() => setUpdateError('Update failed to download or verify — try again.'))
      .finally(() => setInstalling(false));
  };

  const handlePinToggle = (value: boolean): void => {
    if (!onSetPinEnabled) return;
    if (value) {
      // Re-enabling PIN: no verification needed
      onSetPinEnabled(true);
    } else if (onVerifyPin) {
      // Disabling PIN: require current PIN first
      setPinInput('');
      setPinError(false);
      setPinDialogVisible(true);
    } else {
      onSetPinEnabled(false);
    }
  };

  const confirmPinDisable = async (): Promise<void> => {
    if (!onVerifyPin || !onSetPinEnabled) return;
    const ok = await onVerifyPin(pinInput);
    if (ok) {
      setPinDialogVisible(false);
      onSetPinEnabled(false);
    } else {
      setPinError(true);
    }
  };

  const handleSwitchIdentity = (slot: KeySlot): void => {
    setActiveSlotId(slot.id);
    onSwitchIdentity?.(slot.id);
    onClose();
  };

  const handleLeaveIdentity = (slot: KeySlot): void => {
    if (!onRemoveIdentity) return;
    const name = communityById.get(communityId(slot.relayUrl))?.name ?? slot.communityName ?? 'this community';
    // Whether this is the only identity left in its community changes the wording (wiping the last
    // one removes the whole community + its cached posts; a non-last one leaves siblings intact).
    const siblings = slots.filter(
      s => s.id !== slot.id && communityId(s.relayUrl) === communityId(slot.relayUrl),
    );
    const body = siblings.length
      ? `This permanently deletes this identity (its npub) from ${name}. Your other identity there stays. You can’t undo this.`
      : `This permanently deletes this identity (its npub) and all of ${name}’s cached posts and messages from this device. You can’t undo this — rejoining later makes a brand-new identity.`;
    Alert.alert(`Leave ${name}?`, body, [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Leave & wipe',
        style: 'destructive',
        onPress: () => {
          onRemoveIdentity(slot.id);
          setSlots(prev => prev.filter(x => x.id !== slot.id));
        },
      },
    ]);
  };

  const c: Palette = colors;

  const connState: ConnectionState = connection ?? 'disconnected';
  const connDot =
    connState === 'connected'
      ? c.success
      : connState === 'offline' || connState === 'disconnected'
        ? c.danger
        : c.warning;

  const blossomValidation = validateEndpoint(blossomInput);
  const handleSaveBlossom = (): void => {
    if (!onSetBlossomEndpoint || !blossomValidation.valid) return;
    onSetBlossomEndpoint(blossomInput);
    setBlossomSaved(true);
  };
  const blossomHintColor =
    blossomValidation.kind === 'invalid'
      ? c.danger
      : blossomValidation.kind === 'onion'
        ? c.success
        : blossomValidation.kind === 'clearnet'
          ? c.warning
          : c.textSecondary;

  const displayName = profile?.name?.trim() || 'Anonymous member';
  const npubShort = profile ? shortenNpub(profile.npub, {lead: 20, tail: 0}) : '';

  // The identity currently in use (the switcher's entry point + the per-community leave target).
  const activeSlot = slots.find(s => s.id === activeSlotId) ?? slots[0];
  const communityNameOf = (slot: KeySlot | undefined): string =>
    (slot && communityById.get(communityId(slot.relayUrl))?.name) || slot?.communityName || 'Community';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* SafeAreaView (not View): a Modal renders outside the app's root SafeAreaView, so it
          re-applies the top inset — otherwise the header flanks the Dynamic Island. */}
      <SafeAreaView style={[s.page, {backgroundColor: c.bg}]}>
        {/* SwipeBackView wraps the SafeAreaView's children, not the SafeAreaView itself, so that
            opaque c.bg-colored root stays put as the backdrop while just the page header and scroll
            content slide away — see PLAN_SWIPE_BACK_GESTURE_2026-07-27.md's "Modal-hosted pages"
            note. The sheets rendered as this SafeAreaView's own SIBLINGS below (identity switcher,
            connection/relays/reliability/browser/manage-data sheets, the PIN dialog, …) are
            deliberately OUTSIDE this wrap: each is its own separate (transparent) Modal stacked on
            top, not part of the page that slides. `onBack` is `onClose`, the exact function the
            header ‹ already calls, so the button, the hardware key and the swipe can never drift
            apart. */}
        <SwipeBackView onBack={onClose}>
          {/* Page header */}
          <View style={[s.pageHeader, {borderBottomColor: c.border}]}>
            <Press onPress={onClose} hitSlop={10} style={s.backBtn}>
              <Text style={[s.backText, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>‹</Text>
            </Press>
            <Text style={[s.sheetTitle, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Settings</Text>
            <View style={s.backBtn} />
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            style={s.scroll}
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>

            {/* ── Account hero card ─────────────────────── */}
            <Press
              variant="row"
              style={[s.heroCard, {backgroundColor: c.surface, borderColor: c.border}]}
              onPress={() => { onOpenProfile?.(); onClose(); }}>
              <GradientAvatar
                gradient={profile?.gradient}
                seed={profile?.npub ?? ''}
                size={54}
                ring
              />
              <View style={s.heroText}>
                <Text style={[s.heroName, {color: c.textPrimary}]} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{displayName}</Text>
                {npubShort ? (
                  <Text style={[s.heroNpub, {color: c.link}]} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{npubShort}</Text>
                ) : null}
              </View>
              <Text style={[s.heroChevron, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>›</Text>
            </Press>

            {/* ── Communities ──────────────────────────────────────────────────────────────
                Shows the community you're CURRENTLY in as one relaxed card. Tapping it opens the
                switcher sheet — the list of all your identities/communities (tap one to switch) plus
                "Join another community". Leaving a community is the red button in the footer. */}
            {activeSlot && (
              <>
                <SectionHeader label="COMMUNITIES" color={c.textMuted} />
                <Press
                  variant="row"
                  style={[s.communityCard, {backgroundColor: c.surface, borderColor: c.border}]}
                  onPress={() => setSwitcherOpen(true)}>
                  <GradientAvatar seed={activeSlot.npub} size={44} ring />
                  <View style={s.communityBody}>
                    <Text
                      style={[s.communityName, {color: c.textPrimary}]}
                      numberOfLines={1}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {communityNameOf(activeSlot)}
                    </Text>
                    <Text style={[s.communitySub, {color: c.textSecondary}]} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {shortenNpub(activeSlot.npub, {lead: 22, tail: 0})}
                    </Text>
                  </View>
                  <Text style={[s.communityChevron, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>›</Text>
                </Press>
                <Text style={[s.communityHint, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  {slots.length > 1
                    ? `Tap to switch between your ${slots.length} identities — or join another community`
                    : 'Tap to switch identity or join another community'}
                </Text>
              </>
            )}

            {/* ── Identity & account ──────────────────────── */}
            <SectionHeader label="IDENTITY & ACCOUNT" color={c.textMuted} />
            <NavRow label="Edit profile" onPress={() => { onOpenProfile?.(); onClose(); }} c={c} />
            <NavRow
              label="Drafts"
              onPress={() => { onOpenDrafts?.(); onClose(); }}
              c={c}
            />
            {onOpenYourEvents !== undefined && (
              <NavRow
                label="Your events"
                onPress={() => { onOpenYourEvents(); onClose(); }}
                c={c}
              />
            )}
            <NavRow
              label="Your npub"
              value={profile ? shortenNpub(profile.npub, {lead: 16, tail: 0}) : '—'}
              onPress={() => { onOpenProfile?.(); onClose(); }}
              c={c}
            />

            {/* ── Media / uploads ─────────────────────────── */}
            {onSetBlossomEndpoint !== undefined && (
              <>
                <SectionHeader label="MEDIA" color={c.textMuted} />
                <View style={[s.mediaBlock, {backgroundColor: c.surfaceAlt}]}>
                  <Text style={[s.rowLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    Image upload server
                  </Text>
                  <Text
                    style={[s.rowSub, {color: c.textSecondary, marginBottom: space.sm}]}
                    maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    Stiq hosts no images. To attach photos, point this at a Blossom server — an
                    .onion host keeps uploads inside Tor. Leave empty to disable uploads.
                  </Text>
                  {/* A TextInput's own selection-handle drag doesn't join JS PanResponder
                      negotiation, so without this opt-out the page-level swipe-back above would win
                      a rightward drag started inside the field instead of moving the cursor. */}
                  <TextInput
                    style={[s.mediaInput, {color: c.textPrimary, borderColor: blossomValidation.valid ? c.border : c.danger, backgroundColor: c.bg}]}
                    value={blossomInput}
                    onChangeText={v => { setBlossomInput(v); setBlossomSaved(false); }}
                    placeholder="https://…  or  http://…onion"
                    placeholderTextColor={c.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    spellCheck={false}
                    maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}
                    {...optOut}
                  />
                  <Text style={[s.mediaHint, {color: blossomHintColor}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    {blossomValidation.message}
                  </Text>
                  <Press
                    style={[s.mediaSaveBtn, {backgroundColor: blossomValidation.valid ? c.accent : c.surface}]}
                    onPress={handleSaveBlossom}
                    disabled={!blossomValidation.valid}>
                    <Text
                      style={[s.mediaSaveText, {color: blossomValidation.valid ? c.onAccent : c.textMuted}]}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {blossomSaved ? 'Saved ✓' : 'Save'}
                    </Text>
                  </Press>
                </View>
              </>
            )}

            {/* ── Browser (external hand-off default) ─────── */}
            {onSetPreferredBrowser !== undefined && (
              <>
                <SectionHeader label="BROWSER" color={c.textMuted} />
                <NavRow
                  label="Default browser"
                  value={
                    preferredBrowser
                      ? browsers.find(b => b.id === preferredBrowser)?.label ?? preferredBrowser
                      : 'Not set'
                  }
                  onPress={() => setBrowserSheetOpen(true)}
                  c={c}
                />
              </>
            )}

            {/* ── Storage ─────────────────────────────────── */}
            <SectionHeader label="STORAGE" color={c.textMuted} />
            <NavRow
              label="Delete rendered media"
              value="Free up cache"
              onPress={handleClearMedia}
              c={c}
              disabled={clearing}
            />
            <NavRow
              label="Clear old cache"
              value="30+ day events"
              onPress={handleClearCache}
              c={c}
            />
            {(onDeleteCachedData !== undefined || onCountCachedEvents !== undefined) && (
              <NavRow
                label="Manage data…"
                value="By type & date"
                onPress={() => setManageDataOpen(true)}
                c={c}
              />
            )}

            {/* ── Connection / Tor ────────────────────────── */}
            {onApplyConnectionPrefs !== undefined && (
              <>
                <SectionHeader label="CONNECTION" color={c.textMuted} />
                <Press
                  variant="row"
                  style={[s.row, {backgroundColor: c.surfaceAlt}]}
                  onPress={() => setConnectionSheetOpen(true)}>
                  <Text style={{color: connDot, fontSize: 11}} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>●</Text>
                  <View style={s.rowBody}>
                    <Text style={[s.rowLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {MODE_LABEL[connectionPrefs.mode]}
                    </Text>
                    <Text style={[s.rowSub, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {describeConnection(connState)}
                    </Text>
                  </View>
                  <Text style={[s.rowChevron, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>›</Text>
                </Press>
                {/* RELAYS: which relays this device receives the community from (add / mute your own). */}
                {onGetRelaySnapshot !== undefined && (() => {
                  const relaySnap = onGetRelaySnapshot();
                  const relaySub = relaySnap
                    ? `${relaySnap.active.length} receiving${relaySnap.muted.length ? ` · ${relaySnap.muted.length} muted` : ''}`
                    : 'Manage community relays';
                  return (
                    <Press
                      variant="row"
                      style={[s.row, {backgroundColor: c.surfaceAlt}]}
                      onPress={() => setRelaysSheetOpen(true)}>
                      <View style={s.rowBody}>
                        <Text style={[s.rowLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                          Relays
                        </Text>
                        <Text style={[s.rowSub, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                          {relaySub}
                        </Text>
                      </View>
                      <Text style={[s.rowChevron, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>›</Text>
                    </Press>
                  );
                })()}
                {/* RELIABILITY: battery-optimization exemption + OEM background-kill guidance (W3) —
                    keeping Tor alive while Stiq is backgrounded. Reads device state directly via
                    power/reliability.ts (no App.tsx callback needed); lives in the same CONNECTION
                    section gate as the rest of this block for a consistent section boundary. */}
                <Press
                  variant="row"
                  style={[s.row, {backgroundColor: c.surfaceAlt}]}
                  onPress={() => setReliabilitySheetOpen(true)}>
                  <View style={s.rowBody}>
                    <Text style={[s.rowLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      Reliability
                    </Text>
                    <Text style={[s.rowSub, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      Keep Tor connected in the background
                    </Text>
                  </View>
                  <View
                    style={[
                      s.reliabilityPill,
                      {
                        backgroundColor:
                          reliabilityExempt === null ? c.surface : reliabilityExempt ? c.successBg : c.warningBg,
                      },
                    ]}>
                    <Text
                      style={[
                        s.reliabilityPillText,
                        {
                          color:
                            reliabilityExempt === null ? c.textMuted : reliabilityExempt ? c.success : c.warning,
                        },
                      ]}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {reliabilityExempt === null ? '…' : reliabilityExempt ? 'OK' : 'Action needed'}
                    </Text>
                  </View>
                  <Text style={[s.rowChevron, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>›</Text>
                </Press>
              </>
            )}

            {/* ── App updates (T9, APK_UPDATES — hidden unless the flag is on AND the community
                   ships a signed repo) ─────────────────────────── */}
            {showUpdates && (
              <>
                <SectionHeader label="APP UPDATES" color={c.textMuted} />
                <View style={[s.row, {backgroundColor: c.surfaceAlt}]}>
                  <View style={s.rowBody}>
                    <Text style={[s.rowLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      Current version
                    </Text>
                    <Text style={[s.rowSub, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      Signed updates over Tor · no app store
                    </Text>
                  </View>
                  <Text
                    style={[s.rowValue, {color: c.textSecondary}]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    v{version || '—'}
                  </Text>
                </View>
                <Press
                  variant="row"
                  style={[s.row, {backgroundColor: c.surfaceAlt}]}
                  onPress={handleCheckForUpdate}
                  disabled={updateChecking}>
                  <View style={s.rowBody}>
                    <Text style={[s.rowLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {updateChecking ? 'Checking…' : 'Check for updates'}
                    </Text>
                  </View>
                  <Text style={[s.rowChevron, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>›</Text>
                </Press>

                {/* Inline error (check or install) — never crashes the sheet. */}
                {updateError !== null && (
                  <Text style={[s.updateStatusNote, {color: c.danger}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    {updateError}
                  </Text>
                )}

                {/* Up-to-date confirmation, only after a real check that found nothing. */}
                {updateChecked && updateInfo === null && updateError === null && (
                  <Text
                    style={[s.updateStatusNote, {color: c.textSecondary}]}
                    maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    You’re up to date.
                  </Text>
                )}

                {/* Update-available card: what-changed note + Install. */}
                {updateInfo !== null && (
                  <View style={[s.updateCard, {backgroundColor: c.surface, borderColor: c.accent}]}>
                    <Text style={[s.updateCardTitle, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      Update available · v{updateInfo.versionName}
                    </Text>
                    {updateInfo.whatChanged ? (
                      <ScrollView style={s.updateWhatsNewBox} nestedScrollEnabled>
                        <Text
                          style={[s.updateWhatsNew, {color: c.textSecondary}]}
                          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                          {updateInfo.whatChanged}
                        </Text>
                      </ScrollView>
                    ) : null}
                    <Press
                      style={[s.updateInstallBtn, {backgroundColor: c.accentSoft, borderColor: c.accent}]}
                      onPress={handleInstallUpdate}
                      disabled={installing}>
                      <Text style={[s.updateInstallText, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                        {installing ? 'Downloading over Tor…' : 'Install'}
                      </Text>
                    </Press>
                  </View>
                )}
              </>
            )}

            {/* ── Diagnostics (dev builds only — never shipped to members) ── */}
            {__DEV__ && (
              <>
                <SectionHeader label="DIAGNOSTICS" color={c.textMuted} />
                <NavRow
                  label="Sync diagnostics 🔧"
                  value="Reconcile stats"
                  onPress={() => setSyncDebugOpen(true)}
                  c={c}
                />
                <NavRow
                  label="Token status 🔧"
                  value="Wallets · drift · failures"
                  onPress={() => setTokenStatusOpen(true)}
                  c={c}
                />
              </>
            )}

            {/* ── Security ──────────────────────────────────
                The PIN-lock switch is this section's ONLY row, so PIN_LOCK_UI (config.ts, ship-dark —
                bugs 5+6) gates the SECTION HEADER with it: hiding just the row would leave a bare
                "SECURITY" heading over nothing. Sections here are plain ScrollView children with no
                separators of their own, so the whole block conditionally rendering away leaves no
                divider, gap or dead spacing — the danger footer simply follows Diagnostics, exactly as
                if the section had never been written. Flip PIN_LOCK_UI true to restore it verbatim. */}
            {PIN_LOCK_UI && onSetPinEnabled !== undefined && (
              <>
                <SectionHeader label="SECURITY" color={c.textMuted} />
                <View style={[s.row, {backgroundColor: c.surfaceAlt}]}>
                  <View style={s.rowBody}>
                    <Text style={[s.rowLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      PIN lock
                    </Text>
                    <Text style={[s.rowSub, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {pinEnabled ? 'App locks when idle' : 'Lock screen disabled'}
                    </Text>
                  </View>
                  <Switch
                    value={pinEnabled ?? true}
                    onValueChange={handlePinToggle}
                    trackColor={{false: c.border, true: c.accent}}
                    thumbColor={c.onAccent}
                  />
                </View>
              </>
            )}

            {/* ── Danger footer ───────────────────────────── */}
            {(onSignOut !== undefined || (onRemoveIdentity !== undefined && activeSlot)) && (
              <View style={s.dangerSection}>
                {onSignOut !== undefined && (
                  <Press
                    style={[s.dangerBtn, {backgroundColor: c.surface, borderColor: c.border}]}
                    onPress={onSignOut}>
                    <Text style={[s.dangerBtnText, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      Sign out
                    </Text>
                  </Press>
                )}
                {/* Per-community leave: wipes the community you're currently in (its identity + cached
                    data). If you hold another identity in the same community, that one stays. */}
                {onRemoveIdentity !== undefined && activeSlot && (
                  <Press
                    style={[s.dangerBtn, {backgroundColor: c.dangerBg, borderColor: c.danger}]}
                    onPress={() => handleLeaveIdentity(activeSlot)}>
                    <Text
                      style={[s.dangerBtnText, {color: c.danger}]}
                      numberOfLines={1}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      Leave {communityNameOf(activeSlot)}
                    </Text>
                  </Press>
                )}
              </View>
            )}

            {/* ── Version footer ──────────────────────────── */}
            <Text style={[s.versionText, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              <Text style={{fontFamily: fontSerif}} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Stiq.</Text>
              {version ? ` · v${version}` : ''}
              {'\nNostr over Tor v3 hidden services'}
            </Text>

            <View style={s.bottomPad} />
          </ScrollView>
        </SwipeBackView>
      </SafeAreaView>

      {/* Identity/community switcher — opened by tapping the active community. Lists every identity
          (tap one to switch) + "Join another community". */}
      <Modal visible={switcherOpen} animationType="slide" transparent onRequestClose={() => setSwitcherOpen(false)}>
        <View style={s.identityOverlay}>
          <View style={[s.identitySheet, {backgroundColor: c.bg, borderColor: c.border}]}>
            <View style={[s.identityHeader, {borderBottomColor: c.border}]}>
              <Text style={[s.identityTitle, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Your communities
              </Text>
              <Press onPress={() => setSwitcherOpen(false)} hitSlop={10}>
                <Text style={[s.identityClose, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Done
                </Text>
              </Press>
            </View>
            <ScrollView style={s.identityList} showsVerticalScrollIndicator={false}>
              {slots.map(slot => {
                const isActive = slot.id === activeSlotId;
                return (
                  <Press
                    variant="row"
                    key={slot.id}
                    style={[s.identityRow, {backgroundColor: c.surfaceAlt}]}
                    onPress={() => {
                      setSwitcherOpen(false);
                      if (!isActive) handleSwitchIdentity(slot); // also closes Settings + reconnects
                    }}>
                    <GradientAvatar seed={slot.npub} size={40} ring={isActive} />
                    <View style={s.identityRowBody}>
                      <Text
                        style={[s.identityName, {color: c.textPrimary}]}
                        numberOfLines={1}
                        maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                        {communityNameOf(slot)}
                      </Text>
                      <Text style={[s.identityNpub, {color: c.link}]} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                        {shortenNpub(slot.npub, {lead: 18, tail: 0})}
                      </Text>
                    </View>
                    {isActive ? (
                      <Text style={[s.identityActive, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                        Active
                      </Text>
                    ) : (
                      <View style={[s.identitySwitchBtn, {borderColor: c.border}]}>
                        <Text
                          style={[s.identitySwitchText, {color: c.accent}]}
                          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                          Switch
                        </Text>
                      </View>
                    )}
                  </Press>
                );
              })}
              {onJoinAnotherCommunity && (
                <Press
                  style={[s.identityAddBtn, {borderColor: c.border}]}
                  onPress={() => { setSwitcherOpen(false); onJoinAnotherCommunity(); onClose(); }}>
                  <Text style={[s.identityAddText, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    ＋ Join another community
                  </Text>
                </Press>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Connection mode picker — inline sheet over the Settings modal */}
      {onApplyConnectionPrefs !== undefined && (
        <ConnectionSheet
          visible={connectionSheetOpen}
          onClose={() => setConnectionSheetOpen(false)}
          c={c}
          connection={connState}
          phase={GUIDED_AUTO_LADDER ? torPhase : null}
          prefs={connectionPrefs}
          onApply={prefs => {
            setConnectionPrefs(prefs);
            onApplyConnectionPrefs(prefs);
            setConnectionSheetOpen(false);
          }}
        />
      )}

      {/* Reliability sheet — battery-optimization exemption + OEM guidance (W3), inline over Settings */}
      <ReliabilitySheet
        visible={reliabilitySheetOpen}
        onClose={() => setReliabilitySheetOpen(false)}
        c={c}
      />

      {/* Relays manager — inline sheet over the Settings modal (add / mute community relays) */}
      {onGetRelaySnapshot !== undefined && (
        <RelaysSheet
          visible={relaysSheetOpen}
          onClose={() => setRelaysSheetOpen(false)}
          c={c}
          getSnapshot={onGetRelaySnapshot}
          onAdd={(url, onionAuthKey) => onAddRelay?.(url, onionAuthKey) ?? Promise.resolve()}
          onRemove={host => onRemoveRelay?.(host) ?? Promise.resolve()}
          onMute={spec => onMuteRelay?.(spec) ?? Promise.resolve()}
          onUnmute={host => onUnmuteRelay?.(host) ?? Promise.resolve()}
        />
      )}

      {/* Default external browser picker — inline sheet over the Settings modal */}
      {onSetPreferredBrowser !== undefined && (
        <BrowserPickerSheet
          visible={browserSheetOpen}
          onClose={() => setBrowserSheetOpen(false)}
          c={c}
          browsers={browsers}
          preferred={preferredBrowser}
          onApply={id => {
            setPreferredBrowser(id);
            onSetPreferredBrowser(id);
            setBrowserSheetOpen(false);
          }}
        />
      )}

      {/* Fine-grained cache deletion — choose type(s) + a date range, see the count, then delete. */}
      {(onDeleteCachedData !== undefined || onCountCachedEvents !== undefined) && (
        <ManageDataSheet
          visible={manageDataOpen}
          onClose={() => setManageDataOpen(false)}
          c={c}
          onCountCachedEvents={onCountCachedEvents}
          onDeleteCachedData={onDeleteCachedData}
        />
      )}


      {/* Sync diagnostics — dev builds only (read-only view over the reconcile-stats ring buffer) */}
      {__DEV__ && (
        <SyncDebugScreen visible={syncDebugOpen} onClose={() => setSyncDebugOpen(false)} c={c} />
      )}

      {/* Token/economy status — dev builds only (T5.1/F18: read-only wallet counts + C5 drift +
          recent token-relevant failures). Absent entirely from a member build. */}
      {__DEV__ && (
        <TokenStatusScreen
          visible={tokenStatusOpen}
          onClose={() => setTokenStatusOpen(false)}
          status={tokenStatus}
          onRefresh={onRefreshTokenStatus}
          c={c}
        />
      )}

      {/* PIN verification dialog — shown when disabling PIN lock. Gated on PIN_LOCK_UI as
          defense-in-depth: its only trigger is the (now hidden) Security toggle's handlePinToggle,
          so it is already unreachable, but an always-mounted Modal is exactly the kind of stale
          surface that survives a "hide the row" edit. Restored verbatim with the flag. */}
      {PIN_LOCK_UI && (
      <Modal visible={pinDialogVisible} transparent animationType="fade" onRequestClose={() => setPinDialogVisible(false)}>
        {/* Backdrop scrim — tap outside to dismiss. */}
        <Press variant="bare" style={s.pinOverlay} onPress={() => setPinDialogVisible(false)} accessibilityRole="none">
          {/* Inner event-swallowing wrapper so a tap inside the dialog doesn't bubble to the scrim. */}
          <KeyboardAvoidingView
            style={{width: '100%', alignItems: 'center'}}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : undefined}>
            <Press variant="bare" style={[s.pinDialog, {backgroundColor: c.surface}]} onPress={() => {}} accessibilityRole="none">
              <Text style={[s.pinDialogTitle, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Confirm your PIN
              </Text>
              <Text style={[s.pinDialogSub, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Enter your current PIN to disable the lock screen.
              </Text>
              <TextInput
                style={[s.pinInput, {color: c.textPrimary, borderColor: pinError ? colors.danger : c.border}]}
                value={pinInput}
                onChangeText={v => { setPinInput(v); setPinError(false); }}
                placeholder="PIN"
                placeholderTextColor={c.textMuted}
                secureTextEntry
                keyboardType="number-pad"
                autoFocus
                onSubmitEditing={() => { void confirmPinDisable(); }}
                returnKeyType="done"
              />
              {pinError && (
                <Text style={s.pinErrorText} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Incorrect PIN. Try again.
                </Text>
              )}
              <View style={s.pinDialogActions}>
                <Press style={[s.pinDialogBtn, {backgroundColor: c.surfaceAlt}]} onPress={() => setPinDialogVisible(false)}>
                  <Text style={[s.pinDialogBtnText, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    Cancel
                  </Text>
                </Press>
                <Press style={[s.pinDialogBtn, {backgroundColor: colors.danger}]} onPress={() => { void confirmPinDisable(); }}>
                  <Text style={[s.pinDialogBtnText, {color: '#fff'}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                    Disable PIN
                  </Text>
                </Press>
              </View>
            </Press>
          </KeyboardAvoidingView>
        </Press>
      </Modal>
      )}
    </Modal>
  );
}

function SectionHeader({label, color}: {label: string; color: string}): React.JSX.Element {
  return (
    <Text style={[s.sectionLabel, {color}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
      {label}
    </Text>
  );
}

/**
 * BrowserPickerSheet — choose the browser "Open in my browser" targets.
 *
 * The choice is the user's, always: a Tor browser sitting on the device is marked ★ and described as
 * anonymous, but it is never forced. That matters beyond this sheet — the link dialog stops
 * recommending a secure browser only once one is actually CHOSEN here (see browser/linkOpen), so a
 * picker that quietly locked itself to Tor would leave that recommendation impossible to retire.
 */
function BrowserPickerSheet({
  visible,
  onClose,
  c,
  browsers,
  preferred,
  onApply,
}: {
  visible: boolean;
  onClose: () => void;
  c: Palette;
  browsers: InstalledBrowser[];
  preferred: string;
  onApply: (id: string) => void;
}): React.JSX.Element {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.identityOverlay}>
        <View style={[s.identitySheet, {backgroundColor: c.bg, borderColor: c.border}]}>
          <View style={[s.identityHeader, {borderBottomColor: c.border}]}>
            <Text style={[s.identityTitle, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              Default browser
            </Text>
            <Press onPress={onClose} hitSlop={10}>
              <Text style={[s.identityClose, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Done
              </Text>
            </Press>
          </View>

          <ScrollView style={s.identityList} showsVerticalScrollIndicator={false}>
            {browsers.length === 0 ? (
              <Text style={[s.identityEmpty, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                No browsers found. Install Tor Browser to open links privately.
              </Text>
            ) : (
              <>
                {browsers.map(b => {
                  const isSel = b.id === preferred;
                  const tor = isTorBrowserId(b.id);
                  return (
                    <Press
                      variant="row"
                      key={b.id}
                      style={[s.identityRow, {backgroundColor: c.surfaceAlt}]}
                      onPress={() => onApply(b.id)}>
                      <Text style={s.browserGlyph} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                        {tor ? '🔒' : '🌐'}
                      </Text>
                      <View style={s.identityRowBody}>
                        <Text
                          style={[s.identityName, {color: c.textPrimary}]}
                          numberOfLines={1}
                          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                          {b.label}
                          {tor ? '  ★' : ''}
                        </Text>
                        <Text
                          style={[s.rowSub, {color: tor ? c.textSecondary : c.danger}]}
                          numberOfLines={1}
                          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                          {tor ? 'Anonymous — routes through Tor' : 'The site will see your real IP address'}
                        </Text>
                      </View>
                      {isSel ? (
                        <Text
                          style={[s.identityActive, {color: c.accent}]}
                          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                          ✓
                        </Text>
                      ) : null}
                    </Press>
                  );
                })}
                {preferred ? (
                  <Press
                    style={[s.identityAddBtn, {borderColor: c.border}]}
                    onPress={() => onApply('')}>
                    <Text
                      style={[s.identityAddText, {color: c.textSecondary}]}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      Clear — use the system default
                    </Text>
                  </Press>
                ) : null}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** Date-range presets for the scoped cache-clear. `days: null` = "everything cached" (no cutoff). */
const CACHE_RANGE_PRESETS = [
  {key: '7', label: 'Older than 7 days', days: 7},
  {key: '30', label: 'Older than 30 days', days: 30},
  {key: '90', label: 'Older than 90 days', days: 90},
  {key: 'all', label: 'Everything cached', days: null},
] as const;

type CacheRangeKey = (typeof CACHE_RANGE_PRESETS)[number]['key'];

/** unix-seconds cutoff for a preset — undefined ("any age") for the "everything cached" preset. */
function cutoffForRange(key: CacheRangeKey): number | undefined {
  const preset = CACHE_RANGE_PRESETS.find(p => p.key === key);
  if (!preset || preset.days == null) return undefined;
  return Math.floor(Date.now() / 1000) - preset.days * 24 * 60 * 60;
}

/**
 * ManageDataSheet — fine-grained cache deletion. The user picks a TYPE (rendered media and/or cached
 * posts & events) and a DATE RANGE preset, sees how many cached events would be removed, and confirms.
 * Deletion only ever touches the rendered-media RAM cache + non-exempt received feed events — never
 * identity, drafts, unsent posts, DMs, or joined communities (enforced in the store).
 */
function ManageDataSheet({
  visible,
  onClose,
  c,
  onCountCachedEvents,
  onDeleteCachedData,
}: {
  visible: boolean;
  onClose: () => void;
  c: Palette;
  onCountCachedEvents?: (olderThanSeconds?: number) => number;
  onDeleteCachedData?: (opts: {media: boolean; events: boolean; olderThanSeconds?: number}) => {events: number; media: number};
}): React.JSX.Element {
  const [media, setMedia] = useState(false);
  const [events, setEvents] = useState(true);
  const [rangeKey, setRangeKey] = useState<CacheRangeKey>('30');
  const [count, setCount] = useState<number | null>(null);

  // App recreates onCountCachedEvents as a fresh arrow on every emit; hold it in a ref (refreshed each
  // render, no re-run) so the count effect fires only on the user's own type/range changes.
  const countCb = useRef(onCountCachedEvents);
  countCb.current = onCountCachedEvents;

  // Reset to defaults each time the sheet opens, so it never reflects a previous session's selection.
  useEffect(() => {
    if (!visible) return;
    setMedia(false);
    setEvents(true);
    setRangeKey('30');
  }, [visible]);

  // Live preview: recompute the event count whenever the sheet is open and the type/range changes.
  useEffect(() => {
    if (!visible || !events || !countCb.current) {
      setCount(null);
      return;
    }
    setCount(countCb.current(cutoffForRange(rangeKey)));
  }, [visible, events, rangeKey]);

  const nothingSelected = !media && !events;

  const confirmAndDelete = (): void => {
    if (nothingSelected) return;
    const parts: string[] = [];
    if (events) parts.push(count != null ? `≈ ${count} cached posts & events` : 'cached posts & events');
    if (media) parts.push('all rendered media');
    const rangeLabel = CACHE_RANGE_PRESETS.find(p => p.key === rangeKey)?.label ?? '';
    const body =
      `${parts.join(' and ')} will be removed` +
      (events && rangeKey !== 'all' ? ` (${rangeLabel.toLowerCase()})` : '') +
      '.\n\nYour identity, drafts, unsent posts, DMs, and joined communities are never affected.';
    Alert.alert('Delete cached data?', body, [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          // Recompute the cutoff at delete time so "older than N days" is measured from now, not the
          // moment the sheet opened.
          const res = onDeleteCachedData?.({media, events, olderThanSeconds: cutoffForRange(rangeKey)}) ?? {
            events: 0,
            media: 0,
          };
          const total = res.events + res.media;
          const msg =
            total > 0
              ? `Removed ${res.events} cached ${res.events === 1 ? 'event' : 'events'}` +
                (res.media > 0 ? ' and cleared rendered media.' : '.')
              : 'Nothing matched — your cache was already clear.';
          Alert.alert('Cache cleared', msg, [{text: 'OK', onPress: onClose}]);
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.identityOverlay}>
        <View style={[s.identitySheet, {backgroundColor: c.bg, borderColor: c.border}]}>
          <View style={[s.identityHeader, {borderBottomColor: c.border}]}>
            <Text style={[s.identityTitle, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              Manage cached data
            </Text>
            <Press onPress={onClose} hitSlop={10}>
              <Text style={[s.identityClose, {color: c.accent}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Done
              </Text>
            </Press>
          </View>

          <ScrollView style={s.identityList} showsVerticalScrollIndicator={false}>
            {/* TYPE — what to delete */}
            <Text
              style={[s.sectionLabel, {color: c.textMuted, paddingHorizontal: 0}]}
              maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              WHAT TO DELETE
            </Text>
            <View style={[s.manageToggle, {backgroundColor: c.surfaceAlt}]}>
              <View style={s.rowBody}>
                <Text style={[s.rowLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Rendered media cache
                </Text>
                <Text style={[s.rowSub, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Decoded pictures & Tor-fetched images
                </Text>
              </View>
              <Switch
                value={media}
                onValueChange={setMedia}
                trackColor={{false: c.border, true: c.accent}}
                thumbColor={c.onAccent}
              />
            </View>
            <View style={[s.manageToggle, {backgroundColor: c.surfaceAlt}]}>
              <View style={s.rowBody}>
                <Text style={[s.rowLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Cached posts & events
                </Text>
                <Text style={[s.rowSub, {color: c.textSecondary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                  Received community feed history
                </Text>
              </View>
              <Switch
                value={events}
                onValueChange={setEvents}
                trackColor={{false: c.border, true: c.accent}}
                thumbColor={c.onAccent}
              />
            </View>

            {/* DATE RANGE — only meaningful for cached events */}
            <Text
              style={[s.sectionLabel, {color: c.textMuted, paddingHorizontal: 0}]}
              maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              HOW FAR BACK
            </Text>
            <View style={s.presetWrap}>
              {CACHE_RANGE_PRESETS.map(p => {
                const active = p.key === rangeKey;
                return (
                  <Press
                    key={p.key}
                    style={[
                      s.presetChip,
                      {borderColor: active ? c.accent : c.border, backgroundColor: active ? c.accentSoft : 'transparent'},
                    ]}
                    onPress={() => setRangeKey(p.key)}
                    disabled={!events}>
                    <Text
                      style={[s.presetChipText, {color: active ? c.accent : c.textSecondary}]}
                      maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                      {p.label}
                    </Text>
                  </Press>
                );
              })}
            </View>
            <Text style={[s.manageNote, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              {events
                ? count != null
                  ? `≈ ${count} cached ${count === 1 ? 'event' : 'events'} match — the newest stay. Date range applies to posts & events only.`
                  : 'Date range applies to posts & events only.'
                : 'Rendered media is a small in-memory cache and is always cleared in full.'}
            </Text>

            <Press
              style={[s.manageDeleteBtn, {backgroundColor: c.dangerBg, borderColor: c.danger}]}
              onPress={confirmAndDelete}
              disabled={nothingSelected}>
              <Text style={[s.manageDeleteText, {color: c.danger}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
                Delete selected data
              </Text>
            </Press>
            <Text
              style={[s.manageNote, {color: c.textMuted, marginBottom: space.md}]}
              maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
              Your identity, drafts, unsent posts, DMs, and joined communities are never affected.
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function NavRow({
  label,
  value,
  onPress,
  disabled,
  c,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  disabled?: boolean;
  c: Palette;
}): React.JSX.Element {
  return (
    <Press
      variant="row"
      style={[s.row, {backgroundColor: c.surfaceAlt}]}
      onPress={onPress}
      disabled={disabled}>
      <View style={s.rowBody}>
        <Text style={[s.rowLabel, {color: c.textPrimary}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{label}</Text>
      </View>
      {value ? (
        <Text
          style={[s.rowValue, {color: c.textSecondary}]}
          numberOfLines={1}
          maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>
          {value}
        </Text>
      ) : null}
      <Text style={[s.rowChevron, {color: c.textMuted}]} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>›</Text>
    </Press>
  );
}

const s = StyleSheet.create({
  page: {flex: 1},
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {minWidth: 44},
  backText: {fontSize: 22, fontWeight: weight.regular},
  sheetTitle: {fontSize: 17, fontWeight: weight.bold},
  scroll: {flex: 1},

  // Account hero card
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    margin: 14,
    marginTop: 18,
    padding: 15,
    borderRadius: 14,
    borderWidth: 1,
  },
  heroText: {flex: 1},
  heroName: {fontSize: 18, fontWeight: weight.bold, marginBottom: 2},
  heroNpub: {fontSize: 12.5, fontFamily: 'monospace'},
  heroChevron: {fontSize: 22},

  // Active-community card (tap → switcher sheet). Relaxed: its own margin + padding, not a
  // hairline-stacked row.
  communityCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: 14,
    marginTop: 8,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  communityBody: {flex: 1},
  communityName: {fontSize: typeScale.body, fontWeight: weight.semibold, marginBottom: 2},
  communitySub: {fontSize: 12.5, fontFamily: 'monospace'},
  communityChevron: {fontSize: 22},
  communityHint: {
    fontSize: typeScale.caption,
    paddingHorizontal: 18,
    paddingTop: 8,
    lineHeight: 17,
  },

  // Section header (eyebrow)
  sectionLabel: {
    fontSize: 11,
    fontWeight: weight.bold,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
    paddingTop: 20,
    paddingBottom: 6,
  },

  // Nav row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: space.md,
  },
  rowDisabled: {opacity: 0.5},
  rowBody: {flex: 1},
  rowLabel: {fontSize: typeScale.body},
  rowSub: {fontSize: typeScale.caption, marginTop: 2},
  rowValue: {fontSize: typeScale.caption, maxWidth: 120},
  rowChevron: {fontSize: 20},
  activeBadge: {fontSize: typeScale.caption, fontWeight: weight.semibold},
  reliabilityPill: {
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  reliabilityPillText: {fontSize: typeScale.caption, fontWeight: weight.semibold},
  browserGlyph: {fontSize: 18},

  // Segmented control (Theme row)
  segmented: {
    flexDirection: 'row',
    borderRadius: radius.pill,
    borderWidth: 1,
    overflow: 'hidden',
  },
  segmentBtn: {paddingHorizontal: 14, paddingVertical: 6},
  segmentText: {fontSize: 13, fontWeight: weight.semibold},

  // Danger footer buttons
  dangerSection: {
    paddingHorizontal: 14,
    paddingTop: 24,
    gap: 10,
  },
  dangerBtn: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  dangerBtnText: {fontSize: 15, fontWeight: weight.semibold},

  // Version footer
  versionText: {
    fontSize: 11.5,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: space.lg,
    paddingTop: 20,
    paddingBottom: space.sm,
  },

  bottomPad: {height: 32},

  // App updates (T9)
  updateStatusNote: {
    fontSize: typeScale.caption,
    lineHeight: 17,
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  updateCard: {
    marginHorizontal: 14,
    marginTop: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  updateCardTitle: {fontSize: typeScale.body, fontWeight: weight.semibold, marginBottom: 8},
  updateWhatsNewBox: {maxHeight: 160, marginBottom: 4},
  updateWhatsNew: {fontSize: typeScale.caption, fontFamily: 'monospace', lineHeight: 18},
  updateInstallBtn: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  updateInstallText: {fontSize: typeScale.body, fontWeight: weight.semibold},

  // Media / Blossom endpoint editor
  mediaBlock: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: space.xs,
  },
  mediaInput: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: typeScale.label,
  },
  mediaHint: {fontSize: typeScale.caption, marginTop: 2},
  mediaSaveBtn: {
    alignSelf: 'flex-start',
    marginTop: space.sm,
    borderRadius: radius.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  mediaSaveText: {fontSize: typeScale.label, fontWeight: weight.semibold},

  // PIN verification dialog
  pinOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center'},
  pinDialog: {width: '82%', borderRadius: radius.lg, padding: space.lg, gap: space.md},
  pinDialogTitle: {fontSize: typeScale.subheading, fontWeight: weight.bold},
  pinDialogSub: {fontSize: typeScale.label, lineHeight: 20},
  pinInput: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: typeScale.subheading,
    fontWeight: weight.bold,
    letterSpacing: 8,
    textAlign: 'center',
  },
  pinErrorText: {fontSize: typeScale.caption, color: colors.danger},
  pinDialogActions: {flexDirection: 'row', gap: space.sm, justifyContent: 'flex-end'},
  pinDialogBtn: {borderRadius: radius.sm, paddingHorizontal: space.lg, paddingVertical: space.sm},
  pinDialogBtnText: {fontSize: typeScale.label, fontWeight: weight.semibold},

  // Identity switcher sheet (bottom sheet over Settings)
  identityOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end'},
  identitySheet: {
    maxHeight: '80%',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    paddingBottom: space.lg,
  },
  identityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  identityTitle: {fontSize: typeScale.subheading, fontWeight: weight.bold},
  identityClose: {fontSize: typeScale.body, fontWeight: weight.semibold},
  identityList: {paddingHorizontal: space.md, paddingTop: space.md},
  identityEmpty: {fontSize: typeScale.label, lineHeight: 20, paddingVertical: space.lg, textAlign: 'center'},
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    marginBottom: space.sm,
  },
  identityRowBody: {flex: 1},
  identityName: {fontSize: typeScale.body, fontWeight: weight.semibold},
  identityNpub: {fontSize: typeScale.caption, fontFamily: 'monospace', marginTop: 2},
  identityActive: {fontSize: typeScale.caption, fontWeight: weight.semibold},
  identitySwitchBtn: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  identitySwitchText: {fontSize: typeScale.caption, fontWeight: weight.semibold},
  identityAddBtn: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
    marginTop: space.xs,
    marginBottom: space.md,
  },
  identityAddText: {fontSize: typeScale.label, fontWeight: weight.semibold},

  // Manage-data sheet (type toggles + date-range presets)
  manageToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    marginBottom: space.sm,
  },
  presetWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: 2},
  presetChip: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 8,
  },
  presetChipText: {fontSize: typeScale.caption, fontWeight: weight.semibold},
  manageNote: {fontSize: typeScale.caption, lineHeight: 17, marginTop: space.sm},
  manageDeleteBtn: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: space.lg,
  },
  manageDeleteText: {fontSize: typeScale.body, fontWeight: weight.semibold},
});
