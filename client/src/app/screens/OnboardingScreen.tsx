/**
 * OnboardingScreen — the first-run join flow, built to the Stiq Onboarding design handoff.
 *
 * Six linear steps in one screen (design_handoff_onboarding/README.md):
 *   0 Welcome    — what Stiq is + the four identity shapes; "I have a request code →".
 *   1 Code       — paste the organizer's one-time request (join) code; Connect when valid.
 *   2 Connecting — automatic Tor + blind-approval exchange, narrated as a five-line bootstrap log.
 *   3 Identity   — create the gradient + handle (no real names).
 *   4 PIN        — choose then confirm a device-local unlock PIN (custom keypad, shake on mismatch).
 *                  SKIPPED (five steps, not six) while the PIN UI ships dark — PIN_LOCK_UI,
 *                  config.ts, bugs 5+6. See {@link stepAfterIdentity} / {@link DOT_COUNT}.
 *   5 Done       — "You're in. 🎉", identity card, "Enter the community →".
 *
 * The visuals are the new design; the data layer is the real one. The "request code" is the join
 * code (parseJoinCode); "Connecting" runs the real credential exchange over Tor (onAutoExchange),
 * which waits for a live circuit and gets the code blind-approved with no manual key exchange — on
 * failure it retries in place. The member's key is generated on-device; the organizer never sees it.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {Press} from '../../ui/Press';
import {BACK_PRIORITY, useBackAction} from '../../ui/back';
import {parseJoinCode} from '../../onboarding/join';
import type {ExchangeResult, CircuitHooks} from '../../onboarding/exchange';
import type {Session} from '../../onboarding/enrollment';
import type {Community} from '../../onboarding/community';
import type {ConnectionState} from '../../connection';
import type {BootstrapProgress} from '../../tor/types';
import type {ConnectionPhase} from '../../tor/ladder';
import {GUIDED_AUTO_LADDER, PIN_LOCK_UI} from '../../config';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {GradientMaker} from '../../ui/GradientMaker';
import {randomGradientSet, type GradientSpec} from '../../media/gradient';
import {randomHandle} from '../../profile/handleWords';
import {colors, radius, weight} from '../../ui/theme';
import {fonts} from '../../ui/typography';
import {ConnectionSheet} from './ConnectionSheet';
import {DEFAULT_TOR_PREFS, type TorConnectionPrefs} from '../../tor/torSettings';
import {PinKeypad} from '../../ui/PinKeypad';
import {useSubmitGuard} from '../../ui/useSubmitGuard';

// ── Static design data ─────────────────────────────────────────────────────────

/**
 * The eight gradients from the design (ported verbatim) — the Welcome step's decorative avatar
 * cluster and bullet dots ONLY.
 *
 * These are design furniture, not identity. They used to double as the identity step's option grid,
 * which is what made "the random gradient generator isn't random": every member on every phone was
 * offered the same eight, with `PRESET_GRADIENTS[0]` pre-selected — so every member who didn't
 * think to tap Shuffle shipped the *byte-identical* gradient as their identity. The grid is now
 * generated per device ({@link makeGradientOptions}); these stay frozen because the Welcome art is
 * a pixel-exact port of the mockup.
 */
const PRESET_GRADIENTS: GradientSpec[] = [
  {type: 'linear', angle: 120, stops: ['#7cb2ff', '#b89aff']},
  {type: 'linear', angle: 135, stops: ['#34d399', '#3b82f6']},
  {type: 'linear', angle: 135, stops: ['#f59e0b', '#ef4444']},
  {type: 'linear', angle: 135, stops: ['#f472b6', '#a78bfa']},
  {type: 'radial', angle: 135, stops: ['#9ee6c4', '#2a9d8f']},
  {type: 'linear', angle: 135, stops: ['#ffb38f', '#ff7a59']},
  {type: 'linear', angle: 135, stops: ['#b89aff', '#7c6cff']},
  {type: 'linear', angle: 135, stops: ['#7cb2ff', '#4f8eec']},
];

/** How many gradients the identity step offers at once (a 4×2 grid — see `swatchCell`: 25% wide). */
const GRADIENT_OPTION_COUNT = 8;

/**
 * A fresh set of identity gradients, drawn from the CSPRNG (randomGradientSet's default `rand`).
 * Generated per device rather than served from a frozen preset list, so two members are not handed
 * the same eight options — and, crucially, so the pre-selected default at index 0 is not the same
 * constant for everybody.
 *
 * `randomGradientSet` (not eight independent `randomGradient` calls) because these are seen side by
 * side: it spreads the eight across the hue wheel and across all five gradient families, so a
 * Shuffle visibly changes the whole *character* of the grid rather than nudging eight pastels.
 *
 * Exported for focused unit tests (OnboardingScreen.identity.test.tsx), like PinStep/DoneStep below.
 */
export function makeGradientOptions(): GradientSpec[] {
  return randomGradientSet(GRADIENT_OPTION_COUNT);
}

/**
 * Which gradient is selected after a ↻ Shuffle.
 *
 * Shuffle always re-rolls the grid, but it must only re-point the *selection* when that selection
 * came from the grid being replaced. Before Customize existed the answer was unconditionally
 * `next[0]`; now a member can hand-roll a gradient in the maker, and Shuffle — the control they are
 * most likely to tap next out of curiosity — would silently throw that work away.
 *
 * Reference identity is the right test here: a swatch hands its own object to `onPickGradient`, so
 * "is this one of the eight?" is exactly "did they pick it from the grid?". A hand-rolled gradient
 * that happens to *look* like a swatch is still the member's own and survives.
 */
export function selectionAfterShuffle(
  current: GradientSpec,
  previousOptions: GradientSpec[],
  nextOptions: GradientSpec[],
): GradientSpec {
  return previousOptions.includes(current) ? nextOptions[0]! : current;
}

/**
 * The connect checklist — one row per REAL phase of the connecting step, each driven by a real
 * signal rather than a timer:
 *   0  the live Tor circuit          — the daemon's actual bootstrap state + percent.
 *   1  the blinded credential exchange — greens only when a Session actually came back. This ONE row
 *      replaces the former two ("Building an encrypted circuit" / "Sending your one-time request
 *      code"): both narrated halves of a single authentication the member has no way to act on
 *      separately, so splitting them bought a longer ladder and no information. The circuit-open
 *      proof it used to check off has NOT been dropped — it still drives the live subtitle (see
 *      `title` / `liveLine`), which is where "we reached your community" actually belongs.
 *   2  the first-run community prefetch — the relay EOSEing its plan into this community's real
 *      store (onboarding/prefetchCommunity.ts). This is the rung that makes the app usable on the
 *      first screen instead of empty: without it a new member lands on the Updates tab against a
 *      cold cache and watches it fill over Tor.
 *   3  terminal.
 */
const CONNECT_STEPS = [
  'Starting Tor',
  'Exchanging keys',
  'Getting your community ready',
  'Approved — welcome in',
];

const WELCOME_POINTS = [
  {gradient: PRESET_GRADIENTS[0]!, text: 'A calm, invite-only space for your community.'},
  {gradient: PRESET_GRADIENTS[6]!, text: 'Everything you share stays between members.'},
  {gradient: PRESET_GRADIENTS[3]!, text: 'Pick a name and a look that feel like you.'},
];

const PIN_LENGTH = 4;

// ── Step model ───────────────────────────────────────────────────────────────

type Step =
  | {kind: 'welcome'}
  | {kind: 'code'}
  | {kind: 'connecting'; community: Community; inviteCode: string}
  | {kind: 'identity'; session: Session}
  | {kind: 'pin'; session: Session}
  | {kind: 'done'; session: Session};

/** Map a step to its position in the chrome dot indicator (code · connect · identity [· pin]). */
function dotIndex(step: Step): number {
  switch (step.kind) {
    case 'code': return 0;
    case 'connecting': return 1;
    case 'identity': return 2;
    case 'pin': return 3;
    default: return -1; // welcome / done — no chrome bar
  }
}

/**
 * How many dots the chrome indicator draws: 4 (code · connect · identity · pin) normally, 3 while
 * the PIN step is skipped (PIN_LOCK_UI off — config.ts, bugs 5+6). Derived from the flag rather than
 * hardcoded so the indicator can never disagree with the flow it is indicating: a member who never
 * sees a PIN step must not be shown a fourth dot that never lights, and flipping PIN_LOCK_UI true
 * brings the dot back in its original position with no second edit. `dotIndex` above is deliberately
 * left whole — 'pin' keeps its index 3 — so the PIN step slots back in exactly where it was.
 */
const DOT_COUNT = PIN_LOCK_UI ? 4 : 3;

/**
 * The step that follows Identity. Normally the PIN step; Done when there is no PIN to set —
 * i.e. when the PIN UI ships dark (PIN_LOCK_UI, config.ts — bugs 5+6), or in "add mode", which has
 * always skipped it because the device already has a PIN. The two reasons converge on the exact same
 * transition, so the dark build takes a path that has been in production all along rather than a new
 * one. Gating the TRANSITION (rather than dropping 'pin' from the Step union or from a step array)
 * is what keeps the flag a one-line, position-preserving revert.
 *
 * Consequence for enrollment, deliberate: skipping the step leaves `pinRef` at '' and
 * `AppRuntime.completeEnrollment` is handed an empty PIN, which it now reads as "no PIN chosen" and
 * seals nothing (see its `!isAddMode && standardPin` guard). Enrollment otherwise completes exactly
 * as before — the member lands enrolled and unlocked in the feed.
 */
function stepAfterIdentity(session: Session, addMode: boolean): Step {
  return addMode || !PIN_LOCK_UI ? {kind: 'done', session} : {kind: 'pin', session};
}

export interface OnboardingScreenProps {
  connection?: ConnectionState;
  /** Live Tor bootstrap progress (real percent + summary) for the connecting step. */
  torBootstrap?: BootstrapProgress | null;
  /**
   * Guided-ladder plain-language phase (T2, GUIDED_AUTO_LADDER). When the auto-fallback ladder is
   * on, App.tsx passes the live {@link ConnectionPhase} here so the connecting step narrates the
   * real rung ("Trying obfs4 bridges…" / "…is taking too long") instead of Tor's raw summary. Null
   * when the flag is off — the step then renders exactly as today (torBootstrap.summary + 20s slow).
   */
  torPhase?: ConnectionPhase | null;
  /** Restart the Tor cascade under current prefs (the connect step's "Try again"). */
  onRetryTor?: () => void;
  onEnroll?: (
    session: Session,
    pin: string,
    duressPin: string,
    gradient?: GradientSpec,
    handle?: string,
  ) => Promise<void>;
  /** Run the automated credential exchange over Tor (absent on builds without Tor). */
  onAutoExchange?: (
    community: Community,
    inviteCode: string,
    hooks?: CircuitHooks,
  ) => Promise<ExchangeResult>;
  /**
   * Warm this community's real event store before the member ever reaches it — the connect
   * checklist's third rung ("Getting your community ready"). Called ONCE, with the freshly-exchanged
   * Session, the instant the credential lands; resolves when the essentials are in the store, when
   * an internal cap fires, or when the prefetch failed. The screen does not care which: it simply
   * shows the row as active until this settles, then advances.
   *
   * The host (App.tsx) owns the returned prefetch handle — it must pass the pre-minted account slot
   * into enrollment and close the prefetch's socket/store handle first. See
   * onboarding/prefetchCommunity.ts. Absent (tests, builds without Tor) → the row is skipped
   * entirely and the ladder behaves exactly as it did before the prefetch existed.
   */
  onPrefetchCommunity?: (session: Session) => Promise<unknown>;
  /** Join code received via deep link (stiq://join?c=…), prefilled into the code field. */
  incomingJoinCode?: string | null;
  onJoinCodeConsumed?: () => void;
  /** Read the current Tor connection preferences (seeds the in-onboarding connection picker). */
  onGetConnectionPrefs?: () => TorConnectionPrefs;
  /**
   * Persist new Tor connection prefs AND reconnect under them. Wiring this in lets a first-time
   * user on a censored network change how they connect (bridges / max reachability / custom) while
   * still onboarding — before they could ever reach Settings, where these options otherwise live.
   */
  onApplyConnectionPrefs?: (prefs: TorConnectionPrefs) => void;
  /**
   * 'enroll' (default) is the first-run flow. 'add' runs the SAME flow over the live app to join
   * ANOTHER community: it starts at the code step (skipping the Welcome intro), skips the device-PIN
   * step (a PIN already exists), and calls {@link onDone} when finished instead of relying on the
   * enrolled→feed route (the user is already enrolled).
   */
  mode?: 'enroll' | 'add';
  /** Called in add mode after a successful join OR on cancel, to dismiss the overlay. */
  onDone?: () => void;
}

export function OnboardingScreen({
  connection = 'disconnected',
  torBootstrap,
  torPhase,
  onRetryTor,
  onEnroll,
  onAutoExchange,
  onPrefetchCommunity,
  incomingJoinCode,
  onJoinCodeConsumed,
  onGetConnectionPrefs,
  onApplyConnectionPrefs,
  mode = 'enroll',
  onDone,
}: OnboardingScreenProps): React.JSX.Element {
  const addMode = mode === 'add';
  const [step, setStep] = useState<Step>(addMode ? {kind: 'code'} : {kind: 'welcome'});
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  // Identity. The option grid is generated once per mount (lazy useState initialiser — NOT on every
  // render, which would reshuffle the swatches under the member's finger) and the first option is
  // pre-selected, as the design intends.
  const [gradOptions, setGradOptions] = useState<GradientSpec[]>(makeGradientOptions);
  const [gradient, setGradient] = useState<GradientSpec>(() => gradOptions[0]!);
  const [handle, setHandle] = useState('');

  // The chosen unlock PIN, held only in a ref between the PIN step and the Done step's "Enter"
  // action so it never lands in React state, props, or logs.
  const pinRef = useRef('');
  // Bug #1: "Enter the community" has no natural disabled state once tapped (enrollment is async —
  // local key-gen + encrypted storage writes), so a double-tap could double-fire onEnroll. `entering`
  // disables/relabels the button and `enterGuard` (the same primitive LockScreen uses) makes a
  // same-tick double-fire impossible even before the disabled re-render lands.
  const [entering, setEntering] = useState(false);
  const enterGuard = useSubmitGuard();
  // Parse the join code ONCE per keystroke. Both the Connect-button gate (codeValid) and the
  // "you're about to join" preview derive from this single result — previously each was its own
  // useMemo calling parseJoinCode, so every keystroke parsed the code twice.
  const parsedCode = useMemo(() => parseJoinCode(code.trim()), [code]);
  const codeValid = parsedCode.ok;
  const previewCommunity = parsedCode.ok ? parsedCode.join.community : null;

  // A join code arriving via deep link jumps straight to the code step, prefilled.
  useEffect(() => {
    if (!incomingJoinCode) return;
    setCode(incomingJoinCode);
    setError('');
    setStep(prev => (prev.kind === 'welcome' || prev.kind === 'code' ? {kind: 'code'} : prev));
    onJoinCodeConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingJoinCode]);

  // ── Code step ────────────────────────────────────────────────────────────────

  function handlePaste(): void {
    void (async () => {
      try {
        const text = await Clipboard.getString();
        if (text && text.trim()) {
          setCode(text.trim());
          setError('');
        }
      } catch {
        // clipboard unavailable — ignore
      }
    })();
  }

  function handleConnect(): void {
    const result = parseJoinCode(code.trim());
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError('');
    setStep({kind: 'connecting', community: result.join.community, inviteCode: result.join.inviteCode});
  }

  // ── Done step → enrollment ─────────────────────────────────────────────────────

  /**
   * `unlockPin` is whatever the PIN step put in `pinRef` — and '' when there was no PIN step to run
   * (add mode, or the PIN UI shipped dark; see stepAfterIdentity). AppRuntime.completeEnrollment
   * reads '' as "no PIN chosen" and seals nothing rather than sealing an empty PIN.
   */
  async function enterCommunity(session: Session, unlockPin: string): Promise<void> {
    if (!onEnroll) {
      setError('Secure storage is unavailable on this build, so enrollment can’t be saved.');
      return;
    }
    // enterGuard makes a same-tick double-tap a no-op even before `entering` has re-rendered the
    // button as disabled (the exact race useSubmitGuard's doc explains — see LockScreen).
    await enterGuard(async () => {
      setError('');
      setEntering(true);
      try {
        // The duress PIN is always '' — onboarding has never offered to set one, and no other
        // screen in the app does either, so the vault's duress slot is left unconfigured. (An
        // earlier comment here claimed it was "opt-in from Settings"; there is no such setting.)
        await onEnroll(session, unlockPin, '', gradient, handle.trim());
        // First-run: enrollment now lands UNLOCKED straight into the feed (bug #4) and this
        // component unmounts. Add mode: the app is already enrolled (no route change), so explicitly
        // dismiss the overlay — the runtime has already switched to the just-joined community
        // underneath.
        if (addMode) onDone?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Enrollment failed. Try again.');
      } finally {
        setEntering(false);
      }
    });
  }

  // ── Hardware BACK ──────────────────────────────────────────────────────────────
  // Setup is a linear wizard, so BACK walks it one step at a time — the same "one press, one level"
  // rule the rest of the app follows (ui/back.tsx). It had none before: this screen is a SIBLING of
  // MainScreen in AppShell's resolveScreen, and the app's only BackHandler used to live INSIDE
  // MainScreen, so a press anywhere in signup fell straight through to "background the app". In add
  // mode the same actions run inside AppShell's BackModal, whose onClose cancels the join — so the
  // steps peel here first and only the first one dismisses the flow.
  //
  //  · welcome — nothing registered: BACK leaves the app, which is right for the first screen.
  //  · code    — the ‹ arrow's own handler, verbatim (welcome, or cancel the add-mode join).
  //  · connecting — cancel the attempt and return to the code field, like "Try again"'s sibling.
  //  · identity — the session is already established, so leaving discards a completed exchange:
  //    confirm, then drop back to the code step. The one step where BACK asks first.
  //  · pin / done — plain steps back; nothing is persisted until DoneStep's "Enter".
  const backToCode = (): void => {
    setError('');
    setStep({kind: 'code'});
  };
  const handleBack = (): boolean => {
    switch (step.kind) {
      case 'welcome':
        return false;
      case 'code':
        setError('');
        if (addMode) onDone?.();
        else setStep({kind: 'welcome'});
        return true;
      case 'connecting':
        backToCode();
        return true;
      case 'identity':
        Alert.alert('Leave setup?', 'You will need to enter your join code again.', [
          {text: 'Stay', style: 'cancel'},
          {text: 'Leave', style: 'destructive', onPress: backToCode},
        ]);
        return true;
      case 'pin':
        setStep({kind: 'identity', session: step.session});
        return true;
      case 'done':
        // Mirror stepAfterIdentity exactly, so BACK returns through the step that actually ran.
        setStep(
          PIN_LOCK_UI && !addMode
            ? {kind: 'pin', session: step.session}
            : {kind: 'identity', session: step.session},
        );
        return true;
    }
  };
  useBackAction(handleBack, {priority: BACK_PRIORITY.page});

  // ── Render ─────────────────────────────────────────────────────────────────────

  const di = dotIndex(step);
  const showChrome = di >= 0;

  return (
    <SafeAreaView style={s.root}>
      <StatusRow step={step} connection={connection} />

      {showChrome && (
        <View style={s.chrome}>
          <View style={s.chromeSide}>
            {step.kind === 'code' && (
              <Press
                hitSlop={10}
                onPress={() => {
                  setError('');
                  // Add mode has no Welcome step to go back to — the back arrow cancels the join.
                  if (addMode) onDone?.();
                  else setStep({kind: 'welcome'});
                }}>
                <Text style={s.back}>‹</Text>
              </Press>
            )}
          </View>
          <View style={s.dots}>
            {Array.from({length: DOT_COUNT}, (_, i) => (
              <View key={i} style={[s.dot, i === di && s.dotActive, i < di && s.dotDone]} />
            ))}
          </View>
          <View style={s.chromeSide} />
        </View>
      )}

      {step.kind === 'welcome' && <WelcomeStep onStart={() => setStep({kind: 'code'})} />}

      {step.kind === 'code' && (
        <CodeStep
          code={code}
          codeValid={codeValid}
          previewCommunity={previewCommunity}
          error={error}
          onChange={t => { setCode(t); setError(''); }}
          onPaste={handlePaste}
          onConnect={handleConnect}
        />
      )}

      {step.kind === 'connecting' && (
        <ConnectingStep
          community={step.community}
          inviteCode={step.inviteCode}
          connection={connection}
          torBootstrap={torBootstrap}
          torPhase={torPhase}
          onRetryTor={onRetryTor}
          onAutoExchange={onAutoExchange}
          onPrefetchCommunity={onPrefetchCommunity}
          onSession={session => setStep({kind: 'identity', session})}
          onBackToCode={() => { setError(''); setStep({kind: 'code'}); }}
          onGetConnectionPrefs={onGetConnectionPrefs}
          onApplyConnectionPrefs={onApplyConnectionPrefs}
        />
      )}

      {step.kind === 'identity' && (
        <IdentityStep
          gradient={gradient}
          gradOptions={gradOptions}
          handle={handle}
          onPickGradient={setGradient}
          onShuffle={() => {
            const opts = makeGradientOptions();
            setGradient(selectionAfterShuffle(gradient, gradOptions, opts));
            setGradOptions(opts);
          }}
          onHandle={setHandle}
          onSuggest={() => setHandle(randomHandle())}
          // → PIN step, or straight to Done when there is no PIN to set (add mode / PIN UI dark).
          onContinue={() => setStep(stepAfterIdentity(step.session, addMode))}
        />
      )}

      {step.kind === 'pin' && (
        <PinStep onDone={pin => { pinRef.current = pin; setStep({kind: 'done', session: step.session}); }} />
      )}

      {step.kind === 'done' && (
        <DoneStep
          gradient={gradient}
          handle={handle.trim() || 'your handle'}
          community={step.session.community.name ?? 'the community'}
          error={error}
          entering={entering}
          onEnter={() => void enterCommunity(step.session, pinRef.current)}
        />
      )}
    </SafeAreaView>
  );
}

// ── Status row (Tor transport indicator) ─────────────────────────────────────────

function StatusRow({step, connection}: {step: Step; connection: ConnectionState}): React.JSX.Element {
  let label = 'Tor · standby';
  let color = colors.textMuted;
  if (step.kind === 'connecting') {
    label = 'Connecting…';
    color = colors.warning;
  } else if (step.kind === 'identity' || step.kind === 'pin' || step.kind === 'done') {
    label = connection === 'connected' ? 'Tor · obfs4  100%' : 'Tor · obfs4';
    color = colors.textPrimary;
  }
  return (
    <View style={s.statusRow}>
      <Text style={[s.statusText, {color}]}>{label}</Text>
    </View>
  );
}

// ── Step 0 · Welcome ─────────────────────────────────────────────────────────────

function WelcomeStep({onStart}: {onStart: () => void}): React.JSX.Element {
  return (
    <View style={s.welcomeWrap}>
      <View style={s.welcomeCenter}>
        <View style={s.cluster}>
          <View style={s.clusterLow}>
            <GradientAvatar gradient={PRESET_GRADIENTS[1]} shape="square" size={60} />
          </View>
          <View style={s.clusterHigh}>
            <GradientAvatar gradient={PRESET_GRADIENTS[0]} shape="circle" size={78} />
          </View>
          <View style={s.clusterHigh}>
            <GradientAvatar gradient={PRESET_GRADIENTS[6]} shape="hexagon" size={78} />
          </View>
          <View style={s.clusterLow}>
            <GradientAvatar gradient={PRESET_GRADIENTS[3]} shape="diamond" size={60} />
          </View>
        </View>

        <Text style={s.wordmark}>
          Stiq<Text style={s.wordmarkDot}>.</Text>
        </Text>
        <Text style={s.lead}>
          An invite-only community where you can speak freely and stay private.
        </Text>

        <View style={s.points}>
          {WELCOME_POINTS.map(p => (
            <View key={p.text} style={s.point}>
              <GradientAvatar gradient={p.gradient} shape="circle" size={14} />
              <Text style={s.pointText}>{p.text}</Text>
            </View>
          ))}
        </View>
      </View>

      <PrimaryButton label="I have a request code →" onPress={onStart} />
      <Text style={s.footnote}>No code? Ask an organizer to add you.</Text>
    </View>
  );
}

// ── Step 1 · Enter code ──────────────────────────────────────────────────────────

/** Compact display of a relay onion for the join confirmation: `abcd1234…wxyz23.onion`. */
function shortOnion(relayUrl: string): string {
  const h = relayUrl.match(/([a-z2-7]{56})\.onion/i)?.[1];
  if (!h) {
    return relayUrl.replace(/^wss?:\/\//, '').slice(0, 32);
  }
  return `${h.slice(0, 8)}…${h.slice(-6)}.onion`;
}

/**
 * The relay(s) a preview community will use: the full mirror list when the join code carries one
 * (v2 `rs`, capped at MAX_MIRRORS by the parser), else the single primary relay (v1, or a v2 code
 * that fell back to `r`). Shown so a member sees every mirror they're about to trust, not just the
 * first — the anti-censorship invariant is that the organizer can only ADD mirrors, never force the
 * client off one, so surfacing the whole list here is part of that trust story.
 */
function previewRelays(c: Community): string[] {
  return c.relays && c.relays.length > 0 ? c.relays.map(r => r.url) : [c.relayUrl];
}

/**
 * Whether the relay at `index` (matching {@link previewRelays}'s ordering) carries a Tor v3
 * onion-auth reach credential — i.e. is "members-only" (a non-member who merely learns the
 * address cannot even open a connection) rather than "public" (reachable by anyone, though they
 * still can't read or post without a valid invite — content stays gated by the relay's own
 * permission checks). Reads the per-mirror key when the join code carried a mirror list (v2 `rs`),
 * else falls back to the community's single top-level `onionAuthKey` for index 0 (v1 code, or a v2
 * code that fell back to `r`/`oa` — see ./join `resolveV2Relays`), matching how `previewRelays`
 * itself picks its source.
 */
function relayAuthGated(c: Community, index: number): boolean {
  if (c.relays && c.relays.length > 0) {
    return !!c.relays[index]?.onionAuthKey;
  }
  return index === 0 && !!c.onionAuthKey;
}

/**
 * True only when the join code carries a PAST advisory expiry (`x`, unix seconds). This is a UX
 * nudge, NEVER authoritative — the real enforcement point is the organizer's server-side expiry
 * check (feature 4, issueInviteCredential); a code with no `x` (or one still in the future) shows
 * nothing here.
 */
function isPastAdvisoryExpiry(c: Community): boolean {
  return typeof c.advisoryExpiry === 'number' && c.advisoryExpiry * 1000 < Date.now();
}

function CodeStep({
  code, codeValid, previewCommunity, error, onChange, onPaste, onConnect,
}: {
  code: string;
  codeValid: boolean;
  /**
   * The community resolved from the current code (or null), parsed ONCE by the parent. Shown so the
   * member sees WHICH community / organizer / relay they're about to join before tapping Connect — a
   * join code can arrive from an untrusted channel (a stiq://join link any web page can fire), so
   * this turns the Connect tap into an informed confirmation, not a blind hand-off into enrollment.
   */
  previewCommunity: Community | null;
  error: string;
  onChange: (t: string) => void;
  onPaste: () => void;
  onConnect: () => void;
}): React.JSX.Element {
  const preview = previewCommunity;
  return (
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scrollPad} keyboardShouldPersistTaps="handled">
        <Text style={s.eyebrow}>YOUR REQUEST CODE</Text>
        <Text style={s.title}>Paste your request code</Text>
        <Text style={s.body}>
          An organizer sent you a one-time code. Paste it in here and we'll connect you — no need to
          read through it.
        </Text>

        <View style={s.codeField}>
          <TextInput
            style={s.codeInput}
            value={code}
            onChangeText={onChange}
            placeholder="Paste your request code"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            numberOfLines={1}
          />
          {codeValid && (
            <View style={s.looksRight}>
              <Text style={s.looksRightText}>✓ Looks right</Text>
            </View>
          )}
        </View>
        <Text style={s.counter}>
          {code.length} {code.length === 1 ? 'character' : 'characters'}
        </Text>

        {preview && (
          <View style={s.joinPreview}>
            <Text style={s.joinPreviewLabel}>YOU'RE ABOUT TO JOIN</Text>
            <Text style={s.joinPreviewName}>{preview.name || 'Unnamed community'}</Text>
            {preview.organizerLabel ? (
              <Text style={s.joinPreviewMeta}>Invited by {preview.organizerLabel}</Text>
            ) : null}
            {previewRelays(preview).map((url, i) => (
              <View key={url + i} style={s.joinPreviewRelayRow}>
                <Text style={s.joinPreviewRelay}>{shortOnion(url)}</Text>
                <Text style={relayAuthGated(preview, i) ? s.joinPreviewRelayGated : s.joinPreviewRelayPublic}>
                  {relayAuthGated(preview, i) ? '🔒 members-only' : '🌐 public'}
                </Text>
              </View>
            ))}
            {previewRelays(preview).every((_, i) => !relayAuthGated(preview, i)) && (
              <Text style={s.joinPreviewExpiry}>
                ⚠ This community's relay address is public — anyone who learns it can attempt to
                connect, though they still can't read or post without your invite.
              </Text>
            )}
            {isPastAdvisoryExpiry(preview) && (
              <Text style={s.joinPreviewExpiry}>
                ⚠ This invite may have expired — try connecting anyway or ask for a new code.
              </Text>
            )}
          </View>
        )}

        <Press style={s.pasteBtn} onPress={onPaste}>
          <Text style={s.pasteBtnText}>📋  Paste from clipboard</Text>
        </Press>

        <Text style={s.reassure}>Single-use — it stops working once you're connected.</Text>
        {error ? <Text style={s.errorCenter}>{error}</Text> : null}
      </ScrollView>
      <View style={s.footer}>
        <PrimaryButton label="Connect →" onPress={onConnect} disabled={!codeValid} />
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Step 2 · Connecting (real Tor circuit → blinded credential exchange) ────────────

type ConnectPhase = 'tor' | 'exchange';

/**
 * The connecting step's failure state. 'unsupported' is a pre-flight check (no automatic path or no
 * organizer mailbox at all) that never even attempted an exchange, so it carries its own verbatim
 * message rather than an {@link ExchangeResult} to classify. 'exchange' is a real, completed attempt
 * — its `result` is fed to {@link classifyExchangeFailure} at render time (using the freshest
 * `circuitOpen`) to decide which retry affordances make sense.
 */
type ConnectFailure =
  | {kind: 'unsupported'; message: string}
  | {kind: 'exchange'; result: Extract<ExchangeResult, {ok: false}>};

/** {@link classifyExchangeFailure}'s three buckets. */
export type ExchangeFailureKind = 'tor' | 'relay' | 'auth';

/**
 * Turns a failed automated exchange into a plain-language message and a bucket that decides which
 * retry affordances the connecting step offers:
 *  - 'relay' — the circuit never reached the community's OWN relay (or some other transport-level
 *              error): a Tor restart / different connection mode might actually help.
 *  - 'auth'  — the circuit opened and the relay was reached, but the invite itself was rejected
 *              (already used, revoked, or otherwise not accepted): no transport retry can fix that,
 *              so the connecting step hides the transport-retry actions for this bucket.
 *  - 'tor'   — reserved for Tor-network bootstrap failures; this function never returns it because
 *              those never reach the exchange phase's failure card (the `phase === 'tor'` view
 *              handles Tor failures separately, with its own retry affordances) — kept in the union
 *              so any future caller can share one taxonomy instead of inventing a second one.
 */
export function classifyExchangeFailure(
  result: Extract<ExchangeResult, {ok: false}>,
  circuitEverOpened: boolean,
): {kind: ExchangeFailureKind; message: string} {
  if (!circuitEverOpened) {
    return {
      kind: 'relay',
      message:
        "We connected to Tor, but couldn't reach your community's relay. It may be offline, or " +
        "this invite's address may be out of date.",
    };
  }
  if (/rejected|could not verify the organizer|invite may be stale|not accepted/i.test(result.error)) {
    return {
      kind: 'auth',
      message: "This code wasn't accepted by your community. It may have already been used or is no longer valid.",
    };
  }
  return {
    kind: 'relay',
    message: result.timedOut
      ? "We couldn't reach your community over Tor in time."
      : `Connection failed: ${result.error}`,
  };
}

export function ConnectingStep({
  community, inviteCode, connection, torBootstrap, torPhase, onRetryTor, onAutoExchange,
  onPrefetchCommunity, onSession,
  onBackToCode, onGetConnectionPrefs, onApplyConnectionPrefs,
}: {
  community: Community;
  inviteCode: string;
  connection: ConnectionState;
  torBootstrap?: BootstrapProgress | null;
  torPhase?: ConnectionPhase | null;
  onRetryTor?: () => void;
  onAutoExchange?: (
    community: Community,
    inviteCode: string,
    hooks?: CircuitHooks,
  ) => Promise<ExchangeResult>;
  /** Warm this community's store before the member reaches it — see OnboardingScreenProps. */
  onPrefetchCommunity?: (session: Session) => Promise<unknown>;
  onSession: (session: Session) => void;
  onBackToCode: () => void;
  onGetConnectionPrefs?: () => TorConnectionPrefs;
  onApplyConnectionPrefs?: (prefs: TorConnectionPrefs) => void;
}): React.JSX.Element {
  // Two REAL phases. FIRST establish a live Tor circuit — progress is the daemon's actual bootstrap
  // percentage (torBootstrap), not a timer. THEN run the blinded credential exchange, which starts
  // only once Tor reports `connected`, so it never races a half-built circuit. Tor is usually already
  // up from the launch-time cascade by the time the member reaches here, so this often opens straight
  // in 'exchange'.
  const [phase, setPhase] = useState<ConnectPhase>(connection === 'connected' ? 'exchange' : 'tor');
  const [success, setSuccess] = useState(false);
  const [failed, setFailed] = useState<ConnectFailure | null>(null);
  // The exchange sub-phase's own proof-of-connectivity: true only once the credential socket's
  // onOpen has actually fired for THIS attempt (see exchange.ts's onCircuitOpen) — i.e. the onion
  // rendezvous to the community relay itself succeeded, not just Tor's generic bootstrap. Latches
  // true; reset to false only when a fresh exchange attempt starts (below).
  const [circuitOpen, setCircuitOpen] = useState(false);
  // The credential came back and a Session exists — checklist row 1 ("Exchanging keys") is done and
  // row 2 (the community prefetch) is the one now running. Distinct from `success`, which is the
  // TERMINAL state (row 3): between the two, the member is watching the prefetch fill their store.
  // Reset alongside `success`/`circuitOpen` whenever a fresh exchange attempt starts.
  const [exchanged, setExchanged] = useState(false);
  const [attempt, setAttempt] = useState(0);        // exchange retries
  const [torAttempt, setTorAttempt] = useState(0);  // resets the "slow" hint on a manual Tor restart
  const [slow, setSlow] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

  // Guided auto-ladder is active only when the flag is on AND App.tsx is feeding a live phase.
  // In that mode the connecting subtitle, the "slow" nudge and the bar percent are driven by the
  // stiq-authored ConnectionPhase (deterministic, deadline-driven) rather than Tor's raw summary +
  // a flat 20s timer. Off → torPhase is null and every path below falls back to today's behaviour.
  const guided = GUIDED_AUTO_LADDER && torPhase != null;

  // Advance to the exchange only while Tor has a live circuit. If the daemon drops before the
  // credential arrives, return to the Tor phase; that cancels the in-flight exchange effect and
  // automatically starts a fresh one after the cascade reaches 100% again. Keeping phase='exchange'
  // through an offline transition made onboarding show "Verifying…" for up to 150 seconds while
  // there was no usable transport.
  useEffect(() => {
    if (connection === 'connected') {
      setPhase('exchange');
    } else if (!success) {
      setPhase('tor');
    }
  }, [connection, success]);

  // While still waiting on Tor, flag a slow network after a grace period so the connection options
  // (and a manual restart) get a nudge. Reset whenever we (re)enter the Tor phase or restart Tor.
  // The guided ladder drives "slow" deterministically off torPhase.kind (see showSlow below), so the
  // flat 20s timer is the flag-OFF fallback only — skip arming it when the guided phase is present.
  useEffect(() => {
    if (guided) { setSlow(false); return; }
    if (phase !== 'tor') { setSlow(false); return; }
    setSlow(false);
    const t = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(t);
  }, [phase, torAttempt, guided]);

  // Guided ladder: the nudge appears exactly when a rung hard-ceiling fires (ceiling-exceeded →
  // escalating → exhausted), which the ladder ALWAYS resolves to — never a fixed timer. Flag off:
  // the 20s `slow` timer above is authoritative.
  const showSlow = guided
    ? torPhase!.kind === 'ceiling-exceeded' ||
      torPhase!.kind === 'escalating' ||
      torPhase!.kind === 'exhausted'
    : slow;

  // The blinded credential exchange. Runs only in the exchange phase (Tor already connected), so the
  // waitForTor inside onAutoExchange resolves immediately.
  useEffect(() => {
    if (phase !== 'exchange') return;
    let cancelled = false;
    let doneTimer: ReturnType<typeof setTimeout> | undefined;
    setFailed(null);
    setSuccess(false);
    setCircuitOpen(false);
    setExchanged(false);
    void (async () => {
      // No automatic path (no Tor build) or no organizer key → the blinded mailbox exchange can't
      // run; surface it as a retryable failure rather than hanging. Not an exchange RESULT, so it
      // bypasses classifyExchangeFailure — the fix here is a different code, not a transport retry.
      if (!onAutoExchange || !community.organizerPubkey) {
        if (!cancelled) {
          setFailed({
            kind: 'unsupported',
            message: 'This code can’t be used for an automatic connection. Check it and try again.',
          });
        }
        return;
      }
      let result: ExchangeResult;
      try {
        result = await onAutoExchange(community, inviteCode, {
          // Fires once the credential socket's onOpen has actually landed — a real proof the onion
          // circuit to the community relay is open, not just that Tor's generic bootstrap hit 100%.
          onCircuitOpen: () => { if (!cancelled) setCircuitOpen(true); },
        });
      } catch (e) {
        result = {ok: false, error: e instanceof Error ? e.message : 'exchange failed'};
      }
      if (cancelled) return;
      if (result.ok) {
        // Row 1 done. Row 2 (the community prefetch) now runs: this is the ONE place the member
        // waits for something other than the network handshake, and it is bounded from the inside
        // (prefetchCommunity.ts caps it and never rejects), so there is no timeout to enforce here.
        // Absent handler → the row is skipped and we fall straight through to terminal, exactly as
        // this step behaved before the prefetch existed.
        setExchanged(true);
        if (onPrefetchCommunity) {
          try {
            await onPrefetchCommunity(result.session);
          } catch {
            // A prefetch failure must never cost the member the credential they just earned — the
            // app simply starts cold, as it always did. Fall through to terminal.
          }
          if (cancelled) return;
        }
        setSuccess(true);
        doneTimer = setTimeout(() => { if (!cancelled) onSession(result.session); }, 900);
      } else {
        setFailed({kind: 'exchange', result});
      }
    })();
    return () => { cancelled = true; if (doneTimer) clearTimeout(doneTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, attempt]);

  // Change how you connect: persist + reconnect under the new prefs, then show the Tor phase again.
  const applyPrefs = (prefs: TorConnectionPrefs): void => {
    onApplyConnectionPrefs?.(prefs);
    setOptionsOpen(false);
    setFailed(null);
    setSuccess(false);
    setExchanged(false);
    setPhase('tor');
    setTorAttempt(a => a + 1);
  };

  // Restart the Tor circuit under the current prefs (full daemon restart, no settings change).
  const restartTor = (): void => {
    onRetryTor?.();
    setFailed(null);
    setSuccess(false);
    setExchanged(false);
    setPhase('tor');
    setTorAttempt(a => a + 1);
  };

  // The real Tor picker (the same sheet as Settings), reused inline. Rendered in every branch so
  // it's reachable whether Tor is stalling or the exchange has failed.
  const optionsSheet = onApplyConnectionPrefs ? (
    <ConnectionSheet
      visible={optionsOpen}
      onClose={() => setOptionsOpen(false)}
      c={colors}
      connection={connection}
      prefs={onGetConnectionPrefs?.() ?? DEFAULT_TOR_PREFS}
      onApply={applyPrefs}
      phase={GUIDED_AUTO_LADDER ? torPhase : null}
    />
  ) : null;

  // Exchange failure (real: bad code / relay unreachable / no organizer key). Tor failures don't
  // land here — the cascade keeps retrying Tor, so the Tor phase just shows live progress + options.
  if (failed) {
    // The 'unsupported' case (no automatic path at all) isn't an exchange RESULT, so it bypasses
    // classification and shows its own message verbatim — a transport retry can't fix a missing
    // organizer key any more than it can fix a rejected invite.
    const classified = failed.kind === 'exchange'
      ? classifyExchangeFailure(failed.result, circuitOpen)
      : {kind: 'relay' as const, message: failed.message};
    // A rejected/used-up invite can't be fixed by retrying the transport — hide the transport
    // affordances and leave only "use a different code".
    const hideTransportRetry = classified.kind === 'auth';
    return (
      <View style={s.connectWrap}>
        <View style={s.orbBox}>
          <View style={s.orbFailed}><Text style={s.orbGlyph}>!</Text></View>
        </View>
        <Text style={s.connectTitle}>Couldn't connect</Text>
        <Text style={[s.body, s.center, s.maxw280]}>{classified.message}</Text>
        <View style={s.connectActions}>
          <PrimaryButton label="Try again" onPress={() => setAttempt(a => a + 1)} />
          {!hideTransportRetry && onApplyConnectionPrefs && (
            <Press style={s.textBtn} onPress={() => setOptionsOpen(true)}>
              <Text style={s.textBtnLink}>Change how you connect</Text>
            </Press>
          )}
          <Press style={s.textBtn} onPress={onBackToCode}>
            <Text style={s.textBtnLink}>Use a different code</Text>
          </Press>
        </View>
        {optionsSheet}
      </View>
    );
  }

  // Real progress. Tor phase shows the daemon's actual bootstrap percent (floored so the bar isn't
  // empty at "starting"). The bar maps Tor to the first 80% of the journey and the exchange to the
  // last 20, so it only ever moves forward across the phase handoff.
  // Percent comes from the daemon's live bootstrap (torBootstrap); under the guided ladder App.tsx
  // also threads that same percent through torPhase, so honour it when torBootstrap is absent.
  const livePercent = torBootstrap?.percent ?? (guided ? torPhase!.percent : undefined) ?? 0;
  const torPct = connection === 'connected'
    ? 100
    : Math.max(connection === 'starting-tor' ? 4 : 0, livePercent);
  // Tor owns the first 80% of the bar; the exchange lands it at 92 and the prefetch at 96, so the
  // fill keeps creeping while the store warms rather than freezing at one value for the whole rung.
  // It only ever moves forward across every handoff.
  const bar = phase === 'tor'
    ? Math.round(torPct * 0.8)
    : success ? 100 : exchanged ? 96 : 92;

  // Completed beats in the 4-row checklist. Row 0 is Tor; rows 1–3 belong to the exchange phase:
  //   1 → `exchanged`  the credential actually came back (a Session exists),
  //   2 → `success`    the community prefetch settled (landed, capped, or failed — see the effect),
  //   3 → terminal.
  // Row 1 deliberately does NOT green on `circuitOpen`: an open circuit to the community relay
  // proves the transport, not that the invite was accepted, and checking off "Exchanging keys" on
  // transport alone would tell a member with a stale/spent invite that their key exchange succeeded
  // right before it fails. `circuitOpen` still drives the subtitle below, which is where that
  // (genuine, useful) progress signal belongs.
  const completed = phase === 'tor'
    ? (torPct > 0 && connection !== 'starting-tor' ? 1 : 0)
    : (success ? 4 : exchanged ? 2 : 1);

  const title = success
    ? "You're in"
    : phase === 'exchange'
      ? (exchanged
          ? 'Getting your community ready…'
          : circuitOpen ? 'Verifying your request code…' : 'Connecting to your community…')
      : 'Connecting to Tor…';

  const liveLine = success
    ? 'Approved — welcome in'
    : phase === 'exchange'
      ? (exchanged
          ? 'Downloading the latest so the app opens ready…'
          : circuitOpen
          ? 'Getting your code approved over Tor…'
          : 'Opening a private circuit to your community…')
      // Guided ladder: always a stiq-authored plain-language line for the active rung / ceiling
      // event — Tor's raw summary is intentionally never shown here.
      : guided
        ? torPhase!.plainLabel
        : torBootstrap?.summary
          || (connection === 'offline' ? 'Reconnecting to Tor…'
            : connection === 'starting-tor' ? 'Starting the Tor daemon…'
            : 'Building a private circuit…');

  return (
    <View style={s.connectWrap}>
      <ConnectingOrb done={success} />
      <Text style={s.connectTitle}>{title}</Text>
      <Text style={s.liveLine}>{liveLine}</Text>
      {phase === 'tor' && <Text style={s.torMeta}>Tor · {torPct}%</Text>}

      <View style={s.progressTrack}>
        <View style={[s.progressFill, {width: `${bar}%`}]} />
      </View>

      <View style={s.log}>
        {CONNECT_STEPS.map((label, i) => {
          const done = i < completed;
          const active = i === completed && !success;
          return (
            <View key={label} style={s.logRow}>
              {done ? (
                <View style={s.logDone}><Text style={s.logDoneGlyph}>✓</Text></View>
              ) : active ? (
                <Spinner size={20} />
              ) : (
                <View style={s.logPending} />
              )}
              <Text style={[s.logLabel, done && s.logLabelDone, active && s.logLabelActive]}>
                {label}
              </Text>
            </View>
          );
        })}
      </View>

      {phase === 'tor' && showSlow && (
        <Text style={s.slowHint}>
          This is taking longer than usual on this network. You can change how you connect below.
        </Text>
      )}

      <Text style={s.privacyNote}>
        🔐 Your code is stamped “approved” without anyone — even the organizer — being able to see
        which account is yours.
      </Text>

      {!success && (
        <View style={s.connectFooterLinks}>
          {onApplyConnectionPrefs && (
            <Press style={s.optionsLink} onPress={() => setOptionsOpen(true)}>
              <Text style={s.optionsLinkText}>⚙  Connection options</Text>
            </Press>
          )}
          {phase === 'tor' && onRetryTor && showSlow && (
            <Press style={s.optionsLink} onPress={restartTor}>
              <Text style={s.optionsLinkText}>↻  Restart Tor</Text>
            </Press>
          )}
        </View>
      )}
      {optionsSheet}
    </View>
  );
}

// ── Step 3 · Identity ────────────────────────────────────────────────────────────

/** Exported for focused unit tests (OnboardingScreen.identity.test.tsx) — not used outside this file. */
export function IdentityStep({
  gradient, gradOptions, handle, onPickGradient, onShuffle, onHandle, onSuggest, onContinue,
}: {
  gradient: GradientSpec;
  gradOptions: GradientSpec[];
  handle: string;
  onPickGradient: (g: GradientSpec) => void;
  onShuffle: () => void;
  onHandle: (t: string) => void;
  onSuggest: () => void;
  onContinue: () => void;
}): React.JSX.Element {
  const canContinue = handle.trim().length > 0;
  // Whether the full colour picker is expanded. Pure view state — the gradient itself stays lifted
  // to the screen, so opening/closing the maker can never disturb the chosen identity.
  const [customOpen, setCustomOpen] = useState(false);
  return (
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scrollPad} keyboardShouldPersistTaps="handled">
        <Text style={s.eyebrow}>YOUR IDENTITY</Text>
        <Text style={s.title}>Make yourself recognizable</Text>
        {/* "…and only you can change it" was here, and it wasn't true of the handle: names aren't
            reserved, and an earlier claimant silently wins one (displayName.ts). Nothing on this
            step can check that — the phonebook is empty until content syncs — so the copy simply
            stops promising exclusivity instead of faking an availability check. The real clash, if
            it ever happens, is surfaced on the member's own profile where it's both knowable and
            fixable (ProfileScreen's NameConflictBanner). */}
        <Text style={s.body}>
          No real names here. Pick a gradient and a handle — it's how the community knows you.
          Nothing's locked in; you can change either one later.
        </Text>

        <View style={s.identityCenter}>
          <GradientAvatar gradient={gradient} shape="circle" size={96} ring />
          <TextInput
            style={s.handleInput}
            value={handle}
            onChangeText={onHandle}
            placeholder="Pick a handle"
            placeholderTextColor={colors.textMuted}
            maxLength={24}
            autoCapitalize="words"
            autoCorrect={false}
            textAlign="center"
          />
          <Press onPress={onSuggest}>
            <Text style={s.suggest}>🎲  Suggest a handle</Text>
          </Press>
        </View>

        <View style={s.gradientHeader}>
          <Text style={s.eyebrow}>YOUR GRADIENT</Text>
          <Press onPress={onShuffle}>
            <Text style={s.shuffle}>↻ Shuffle</Text>
          </Press>
        </View>
        <View style={s.swatchGrid}>
          {gradOptions.map((g, i) => {
            const selected = g === gradient;
            return (
              <Press key={i} style={s.swatchCell} onPress={() => onPickGradient(g)}>
                {selected && <View style={s.swatchRing} />}
                <GradientAvatar gradient={g} shape="circle" size={48} />
              </Press>
            );
          })}
        </View>

        {/* Beyond the eight: the same GradientMaker the profile screen uses, so there is ONE colour
            picker in the app rather than an onboarding-shaped imitation of one. Collapsed by
            default — the grid is the fast path, this is for the member who wants an exact colour. */}
        {customOpen ? (
          <View style={s.customCard}>
            <View style={s.customHeader}>
              <Text style={s.eyebrow}>MAKE YOUR OWN</Text>
              <Press onPress={() => setCustomOpen(false)}>
                <Text style={s.customDone}>Done</Text>
              </Press>
            </View>
            <GradientMaker value={gradient} onChange={onPickGradient} previewSize={96} />
          </View>
        ) : (
          <Press style={s.customizeRow} onPress={() => setCustomOpen(true)}>
            <Text style={s.customize}>Customize →</Text>
          </Press>
        )}
      </ScrollView>
      <View style={s.footer}>
        <PrimaryButton label="Continue →" onPress={onContinue} disabled={!canContinue} />
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Step 4 · PIN ─────────────────────────────────────────────────────────────────
//
// Rendered only when PIN_LOCK_UI is on (config.ts — bugs 5+6): the step is skipped, not deleted, so
// everything below is live, compiled and still directly unit-tested (OnboardingScreen.pinDone.test
// .tsx), and flipping the flag restores it in place. Nothing here reads the flag — the decision is
// made once, at the identity→next transition (stepAfterIdentity).

/** Exported for focused unit tests (OnboardingScreen.pinDone.test.tsx) — not used outside this file. */
export function PinStep({onDone}: {onDone: (pin: string) => void}): React.JSX.Element {
  const [phase, setPhase] = useState<'set' | 'confirm'>('set');
  const chosenRef = useRef('');
  const [error, setError] = useState('');
  // Bumped on a confirm-phase mismatch to trigger PinKeypad's shake — see PinKeypad.shakeSignal.
  const [shakeSignal, setShakeSignal] = useState(0);

  const handleComplete = (pin: string): void => {
    setError('');
    if (phase === 'set') {
      chosenRef.current = pin;
      setPhase('confirm');
      return;
    }
    if (pin === chosenRef.current) {
      onDone(pin);
      return;
    }
    setError('That didn’t match — try again.');
    setShakeSignal(n => n + 1);
  };

  const title = phase === 'confirm' ? 'Confirm your PIN' : 'Choose your PIN';
  const helper = phase === 'confirm'
    ? 'Type it once more to be sure.'
    : "You'll enter this every time you open Stiq. It's stored only on this phone.";

  return (
    <PinKeypad
      title={title}
      helper={helper}
      error={error}
      length={PIN_LENGTH}
      onComplete={handleComplete}
      shakeSignal={shakeSignal}
      // No "…you can add a duress PIN later in Settings" here: that promise was FALSE — no
      // change-PIN or duress-PIN screen has ever existed anywhere in the app (the duress slot is
      // real, but only ever settable through this call site, which passes ''). Dropped rather than
      // kept-and-dark so that flipping PIN_LOCK_UI back on restores a step that tells the truth.
      footnote="Stored only on this phone."
    />
  );
}

// ── Step 5 · Done ────────────────────────────────────────────────────────────────

/** Exported for focused unit tests (OnboardingScreen.pinDone.test.tsx) — not used outside this file. */
export function DoneStep({
  gradient, handle, community, error, entering, onEnter,
}: {
  gradient: GradientSpec;
  handle: string;
  community: string;
  error: string;
  /** Bug #1: true while enrollment (local key-gen + encrypted storage writes) is in flight —
   *  relabels and disables the button so a double-tap can't double-fire onEnroll. */
  entering: boolean;
  onEnter: () => void;
}): React.JSX.Element {
  return (
    <View style={s.doneWrap}>
      <View style={s.doneCenter}>
        <View>
          <GradientAvatar gradient={gradient} shape="circle" size={96} ring />
          <View style={s.doneBadge}><Text style={s.doneBadgeText}>🎉</Text></View>
        </View>
        <Text style={s.doneTitle}>You're in. 🎉</Text>
        <Text style={[s.body, s.center, s.maxw290]}>
          Welcome to {community}. Your identity is set and your connection is private.
        </Text>

        <View style={s.identityCard}>
          <GradientAvatar gradient={gradient} shape="circle" size={40} />
          <View style={s.identityCardText}>
            <Text style={s.identityCardName} numberOfLines={1}>{handle}</Text>
            <Text style={s.identityCardSub}>Your handle in the community</Text>
          </View>
        </View>
        {error ? <Text style={s.errorCenter}>{error}</Text> : null}
      </View>
      <PrimaryButton
        label={entering ? 'Entering…' : 'Enter the community →'}
        onPress={onEnter}
        disabled={entering}
      />
    </View>
  );
}

// ── Shared primitives ────────────────────────────────────────────────────────────

function PrimaryButton({
  label, onPress, disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <Press
      style={[s.primary, disabled && s.primaryDisabled]}
      pressedStyle={s.primaryPressed}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}>
      <Text style={[s.primaryText, disabled && s.primaryTextDisabled]}>{label}</Text>
    </Press>
  );
}

/** A rotating accent arc — the bootstrap-log "active" marker and the connecting orb's ring. */
function Spinner({size}: {size: number}): React.JSX.Element {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(spin, {toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true}),
    );
    anim.start();
    return () => anim.stop();
  }, [spin]);
  const rotate = spin.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']});
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 2,
        borderColor: colors.borderLight,
        borderTopColor: colors.accent,
        transform: [{rotate}],
      }}
    />
  );
}

const ORB_GRADIENT: GradientSpec = {type: 'linear', angle: 120, stops: ['#7cb2ff', '#b89aff']};

function ConnectingOrb({done}: {done: boolean}): React.JSX.Element {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (done) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {toValue: 1, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
        Animated.timing(pulse, {toValue: 0, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true}),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [pulse, done]);
  const scale = pulse.interpolate({inputRange: [0, 1], outputRange: [1, 1.04]});

  if (done) {
    return (
      <View style={s.orbBox}>
        <View style={s.orbDone}>
          <GradientAvatar gradient={ORB_GRADIENT} shape="circle" size={108} />
          <Text style={s.orbCheck}>✓</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={s.orbBox}>
      <View style={s.orbRing}><Spinner size={128} /></View>
      <Animated.View style={[s.orbPulse, {transform: [{scale}]}]}>
        <GradientAvatar gradient={ORB_GRADIENT} shape="circle" size={84} />
      </Animated.View>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  flex: {flex: 1},

  statusRow: {flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 26, paddingTop: 6, paddingBottom: 2},
  statusText: {fontSize: 13, fontWeight: weight.semibold},

  chrome: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 6},
  chromeSide: {width: 30, justifyContent: 'center'},
  back: {color: colors.accent, fontSize: 30, lineHeight: 30, marginTop: -4},
  dots: {flexDirection: 'row', alignItems: 'center', gap: 6},
  dot: {width: 7, height: 4, borderRadius: 2, backgroundColor: colors.borderLight},
  dotActive: {width: 22, backgroundColor: colors.accent},
  dotDone: {backgroundColor: colors.accent},

  // Welcome
  welcomeWrap: {flex: 1, paddingHorizontal: 28, paddingBottom: 26},
  welcomeCenter: {flex: 1, justifyContent: 'center', alignItems: 'center'},
  cluster: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, height: 110},
  clusterLow: {transform: [{translateY: 14}]},
  clusterHigh: {transform: [{translateY: -10}]},
  wordmark: {fontFamily: fonts.serif, fontSize: 42, fontWeight: weight.bold, color: colors.textPrimary, letterSpacing: 0.4, marginTop: 18},
  wordmarkDot: {color: colors.accent},
  lead: {fontSize: 16, lineHeight: 24, color: colors.textSecondary, marginTop: 14, textAlign: 'center', maxWidth: 290},
  points: {marginTop: 30, alignSelf: 'stretch', gap: 13},
  point: {flexDirection: 'row', alignItems: 'center', gap: 13},
  pointText: {flex: 1, fontSize: 14.5, color: colors.textSecondary, lineHeight: 20},
  footnote: {textAlign: 'center', fontSize: 13, color: colors.textMuted, marginTop: 14},

  // Scroll steps
  scrollPad: {paddingHorizontal: 26, paddingTop: 12, paddingBottom: 16, flexGrow: 1},
  footer: {paddingHorizontal: 26, paddingBottom: 16, paddingTop: 6},
  eyebrow: {fontSize: 11, color: colors.textMuted, fontWeight: weight.bold, letterSpacing: 0.9, textTransform: 'uppercase'},
  title: {fontSize: 27, fontWeight: weight.bold, lineHeight: 32, color: colors.textPrimary, marginTop: 9},
  body: {fontSize: 15, lineHeight: 23, color: colors.textSecondary, marginTop: 11},
  center: {textAlign: 'center'},
  maxw280: {maxWidth: 280},
  maxw290: {maxWidth: 290},

  codeField: {position: 'relative', marginTop: 22, justifyContent: 'center'},
  codeInput: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 14,
    paddingVertical: 15,
    paddingLeft: 15,
    paddingRight: 120,
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    fontSize: 14,
  },
  looksRight: {position: 'absolute', right: 13, backgroundColor: colors.successBg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill},
  looksRightText: {fontSize: 11, fontWeight: weight.bold, color: colors.success},
  counter: {marginTop: 8, fontSize: 11.5, color: colors.textMuted, fontFamily: fonts.mono},
  pasteBtn: {marginTop: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radius.pill, paddingVertical: 12, alignItems: 'center'},
  pasteBtnText: {fontSize: 14, fontWeight: weight.semibold, color: colors.textPrimary},
  reassure: {textAlign: 'center', marginTop: 16, fontSize: 12.5, color: colors.textMuted},
  errorCenter: {textAlign: 'center', marginTop: 14, fontSize: 13, color: colors.danger},

  // Join confirmation: what the parsed code resolves to (community / organizer / relay onion),
  // so Connect is an informed choice rather than a blind hand-off.
  joinPreview: {marginTop: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderLight, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, gap: 3},
  joinPreviewLabel: {fontSize: 10.5, fontWeight: weight.bold, letterSpacing: 0.8, color: colors.textMuted, marginBottom: 1},
  joinPreviewName: {fontSize: 15, fontWeight: weight.bold, color: colors.textPrimary},
  joinPreviewMeta: {fontSize: 13, color: colors.textSecondary},
  joinPreviewRelay: {fontSize: 12, color: colors.textMuted, fontFamily: fonts.mono, marginTop: 2},
  joinPreviewRelayRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2},
  joinPreviewRelayGated: {fontSize: 11, color: colors.success, fontWeight: weight.bold},
  joinPreviewRelayPublic: {fontSize: 11, color: colors.textMuted},
  joinPreviewExpiry: {fontSize: 12, color: colors.warning, marginTop: 6, lineHeight: 17},

  // Connecting
  connectWrap: {flex: 1, paddingHorizontal: 30, paddingBottom: 30, justifyContent: 'center', alignItems: 'center'},
  orbBox: {width: 128, height: 128, alignItems: 'center', justifyContent: 'center'},
  orbRing: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center'},
  orbPulse: {alignItems: 'center', justifyContent: 'center'},
  orbDone: {width: 108, height: 108, borderRadius: 54, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft},
  orbCheck: {position: 'absolute', fontSize: 46, color: colors.onAccent, fontWeight: weight.bold},
  orbFailed: {width: 108, height: 108, borderRadius: 54, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.dangerBg, borderWidth: 1, borderColor: colors.danger},
  orbGlyph: {fontSize: 46, color: colors.danger, fontWeight: weight.bold},
  connectTitle: {fontSize: 24, fontWeight: weight.bold, color: colors.textPrimary, marginTop: 30, textAlign: 'center'},
  liveLine: {marginTop: 10, fontSize: 13.5, color: colors.textSecondary, textAlign: 'center', maxWidth: 280, lineHeight: 19},
  torMeta: {marginTop: 6, fontSize: 12, color: colors.textMuted, fontFamily: fonts.mono},
  slowHint: {marginTop: 18, fontSize: 12.5, color: colors.warning, textAlign: 'center', maxWidth: 280, lineHeight: 18},
  connectFooterLinks: {marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, flexWrap: 'wrap'},
  progressTrack: {width: '100%', maxWidth: 240, height: 5, borderRadius: 3, backgroundColor: colors.surface, marginTop: 18, overflow: 'hidden'},
  progressFill: {height: '100%', borderRadius: 3, backgroundColor: colors.accent},
  log: {marginTop: 26, alignSelf: 'stretch', gap: 11},
  logRow: {flexDirection: 'row', alignItems: 'center', gap: 11},
  logDone: {width: 20, height: 20, borderRadius: 10, backgroundColor: colors.successBg, alignItems: 'center', justifyContent: 'center'},
  logDoneGlyph: {fontSize: 12, fontWeight: weight.bold, color: colors.success},
  logPending: {width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.border},
  logLabel: {flex: 1, fontSize: 14, color: colors.textMuted},
  logLabelDone: {color: colors.textSecondary},
  logLabelActive: {color: colors.textPrimary},
  privacyNote: {marginTop: 28, fontSize: 12, color: colors.textMuted, lineHeight: 18, textAlign: 'left'},
  connectActions: {alignSelf: 'stretch', marginTop: 24, gap: 8},
  textBtn: {alignItems: 'center', paddingVertical: 8},
  textBtnLink: {color: colors.accent, fontSize: 13, fontWeight: weight.semibold},
  optionsLink: {alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 10},
  optionsLinkText: {color: colors.textSecondary, fontSize: 13, fontWeight: weight.semibold},

  // Identity
  identityCenter: {alignItems: 'center', marginTop: 22},
  handleInput: {marginTop: 16, width: '100%', maxWidth: 240, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, color: colors.textPrimary, fontSize: 17, fontWeight: weight.semibold},
  suggest: {color: colors.accent, fontSize: 13, fontWeight: weight.semibold, marginTop: 10},
  gradientHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 22},
  shuffle: {color: colors.accent, fontSize: 13, fontWeight: weight.semibold},
  swatchGrid: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 13},
  swatchCell: {width: '25%', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, height: 64},
  swatchRing: {position: 'absolute', width: 56, height: 56, borderRadius: 28, borderWidth: 2, borderColor: colors.accent},
  customizeRow: {alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 12, marginTop: 6},
  customize: {color: colors.accent, fontSize: 13, fontWeight: weight.semibold},
  customCard: {marginTop: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 14, gap: 14},
  customHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  customDone: {color: colors.accent, fontSize: 13, fontWeight: weight.semibold},

  // PIN step now renders PinKeypad (client/src/ui/PinKeypad.tsx) — its dots/keypad styles live
  // there so onboarding and the recurring lock screen stay pixel-identical from one definition.

  // Done
  doneWrap: {flex: 1, paddingHorizontal: 28, paddingBottom: 28},
  doneCenter: {flex: 1, justifyContent: 'center', alignItems: 'center'},
  doneBadge: {position: 'absolute', right: -2, bottom: -2, width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderLight, alignItems: 'center', justifyContent: 'center'},
  doneBadgeText: {fontSize: 17},
  doneTitle: {fontSize: 30, fontWeight: weight.bold, color: colors.textPrimary, marginTop: 24},
  identityCard: {alignSelf: 'stretch', marginTop: 26, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14},
  identityCardText: {flex: 1, minWidth: 0},
  identityCardName: {fontSize: 16, fontWeight: weight.bold, color: colors.textPrimary},
  identityCardSub: {fontSize: 12.5, color: colors.textMuted, marginTop: 2},

  // Primary button
  primary: {backgroundColor: colors.accent, borderRadius: radius.pill, paddingVertical: 16, alignItems: 'center'},
  primaryPressed: {backgroundColor: colors.accentPressed},
  primaryDisabled: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border},
  primaryText: {color: colors.onAccent, fontSize: 16, fontWeight: weight.semibold},
  primaryTextDisabled: {color: colors.textMuted},
});
