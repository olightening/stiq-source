/**
 * back.tsx — the app's single Android BACK contract.
 *
 * There is no react-navigation here and no native screen stack: MainScreen is a hand-rolled state
 * machine of ~25 "is this surface open" flags, so BACK is not something the framework derives — it
 * is something every surface has to declare. Before this module there was exactly ONE
 * `BackHandler.addEventListener` (in MainScreen) driving one long if-ladder, which meant BACK only
 * understood the surfaces MainScreen itself owns. Screens with their own internal pages (the group
 * Manage/Add-people flow, the events organizer, the browser) had no way to say "peel one level",
 * so BACK closed them outright, and onboarding — a sibling of MainScreen, not a child — had no
 * BACK at all.
 *
 * ── The contract every registered action must obey ───────────────────────────────────────────────
 *  1. One press = one level. Never peel two.
 *  2. BACK is the SAME function as the on-screen back affordance. Declare the action next to that
 *     button so the two cannot drift.
 *  3. At most ONE tab hop, ever (MainScreen's `tabRoot` nav-origin). Landing on a bare tab root
 *     always means the next BACK leaves the app.
 *  4. At a tab root nothing consumes the press → RN runs the default → MainActivity.kt's
 *     `invokeDefaultOnBackPressed` override calls moveTaskToBack, so the app backgrounds and the
 *     bundled Tor daemon survives. BACK must never finish the Activity.
 *  5. BACK never silently destroys typed work — see {@link useBackDismiss}.
 *
 * ── Why scopes, and why an explicit priority ─────────────────────────────────────────────────────
 * On Android a React Native `<Modal>` is a separate Dialog WINDOW. It consumes the back key itself
 * and calls its own `onRequestClose`; the Activity's onBackPressed — and therefore every JS
 * `BackHandler` listener — never fires while one is up. So a single global registry would be wrong
 * in both directions: actions registered inside a modal would be invisible to the key that actually
 * arrives, and the screen underneath would answer a press meant for the modal. Hence one scope per
 * window: {@link RootBackScope} owns the sole `BackHandler` listener, and each {@link BackModal}
 * owns a scope of its own that its `onRequestClose` drives.
 *
 * Ordering is an explicit {@link BACK_PRIORITY} tier, NOT mount order, because React runs effects
 * child-first: a parent and a child that mount in the same commit register in the reverse of the
 * order you would want (GroupView opened straight onto 'manage' via `openGroupInitialScreen` is
 * exactly that case). Within a tier, ties break LIFO — whatever opened last is on top.
 */
import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef} from 'react';
import {Alert, BackHandler, Modal, type ModalProps} from 'react-native';

/**
 * Tiers, highest first. Pick by what the thing IS, not by how deep it happens to be today:
 *  - `sheet` — a menu/sheet drawn INSIDE a surface as a plain absolute-fill View. (A sheet that is
 *    its own `<Modal>` needs nothing: its own Dialog already eats the key.)
 *  - `page`  — an inner page of a multi-page surface (group Manage, organizer Create, web history).
 *  - `host`  — the surface itself: the level whose BACK closes it.
 *  - `root`  — MainScreen's overlay ladder, the fallback for everything it owns directly.
 */
export const BACK_PRIORITY = {
  sheet: 30,
  page: 20,
  host: 10,
  root: 0,
} as const;

interface BackEntry {
  /** Returns true to consume the press. */
  handler: () => boolean;
  enabled: boolean;
  priority: number;
  /** Registration order within the scope — the LIFO tie-break. Assigned by `add`. */
  seq: number;
}

interface BackScope {
  add: (entry: BackEntry) => () => void;
  /** Run enabled handlers highest-priority-first; true if one consumed the press. */
  run: () => boolean;
}

function createBackScope(): BackScope {
  const entries = new Set<BackEntry>();
  let nextSeq = 0;
  return {
    add(entry) {
      entry.seq = ++nextSeq;
      entries.add(entry);
      return () => {
        entries.delete(entry);
      };
    },
    run() {
      const ordered = [...entries].sort((a, b) => b.priority - a.priority || b.seq - a.seq);
      for (const e of ordered) {
        if (e.enabled && e.handler()) {
          return true;
        }
      }
      return false;
    },
  };
}

const BackScopeCtx = createContext<BackScope | null>(null);

/**
 * Register a back action in the nearest scope. Return true from `handler` to consume the press,
 * false to let the next action (or the OS default) have it.
 *
 * The entry object is stable for the component's lifetime and its fields are refreshed on every
 * render, so the registration happens exactly once yet can never run a stale closure — the same
 * ref-refresh idiom MainScreen already used for its old `closeInnermostOverlayRef`.
 *
 * Outside any scope this is a no-op rather than a throw — a missing BACK action must never be the
 * reason a screen fails to render — but it warns in dev, because the failure is otherwise invisible:
 * the screen looks right and BACK quietly does the wrong thing. A test that renders a screen bare
 * needs a <RootBackScope> wrapper (see MainScreen.navOriginStack.test.tsx).
 */
export function useBackAction(
  handler: () => boolean,
  opts?: {enabled?: boolean; priority?: number},
): void {
  const scope = useContext(BackScopeCtx);
  const entry = useRef<BackEntry>({handler, enabled: true, priority: BACK_PRIORITY.host, seq: 0}).current;
  entry.handler = handler;
  entry.enabled = opts?.enabled ?? true;
  entry.priority = opts?.priority ?? BACK_PRIORITY.host;
  useEffect(() => {
    if (!scope) {
      if (__DEV__) {
        console.warn('[back] useBackAction outside any BackScope — this back action will never run.');
      }
      return;
    }
    return scope.add(entry);
  }, [scope, entry]);
}

/**
 * The one and only `BackHandler` listener. Mount ONCE, above every screen — in AppShell, wrapping
 * `renderScreen()`, so onboarding and the lock screen are inside it too (they are siblings of
 * MainScreen in `resolveScreen`, so a listener living inside MainScreen could never see them).
 */
export function RootBackScope({children}: {children: React.ReactNode}): React.JSX.Element {
  const scope = useMemo(createBackScope, []);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => scope.run());
    return () => sub.remove();
  }, [scope]);
  return <BackScopeCtx.Provider value={scope}>{children}</BackScopeCtx.Provider>;
}

/**
 * A `<Modal>` that owns its own back scope. The system back key lands on `onRequestClose`, which
 * resolves in depth order: this modal's registered actions first (children — they are deeper), then
 * `onBack`, then `onClose`. Use it for any modal-hosted surface with internal levels; a modal whose
 * BACK simply closes it needs nothing more than a plain `<Modal onRequestClose={…}>`.
 *
 * `onBack` exists because the component that RENDERS a BackModal cannot register into it: the scope
 * provider is that component's own child, so its `useBackAction` would resolve to the enclosing
 * scope (usually the root) and never fire while the modal is up. Multi-page hosts almost always
 * hold the page state themselves — the events organizer's `screen`, for one — so they declare their
 * inner-page back here and let genuinely nested children use `useBackAction`. Return true to consume.
 */
export function BackModal({
  onClose,
  onBack,
  children,
  ...rest
}: ModalProps & {onClose: () => void; onBack?: () => boolean}): React.JSX.Element {
  const scope = useMemo(createBackScope, []);
  const latestOnBack = useRef(onBack);
  latestOnBack.current = onBack;
  const onRequestClose = useCallback(() => {
    if (scope.run()) {
      return;
    }
    if (latestOnBack.current?.()) {
      return;
    }
    onClose();
  }, [scope, onClose]);
  return (
    <Modal {...rest} onRequestClose={onRequestClose}>
      <BackScopeCtx.Provider value={scope}>{children}</BackScopeCtx.Provider>
    </Modal>
  );
}

/**
 * Contract rule 5, as a helper: returns a dismiss function that closes a pristine form instantly and
 * asks first when there is typed work to lose. Wire the SAME returned function to the screen's own
 * Cancel/‹ Back button and to its {@link useBackAction}, so the key and the button can never differ.
 *
 * Uses the plain `Alert.alert` — `ui/StiqAlert.tsx`'s `installStiqAlert()` has already reassigned it
 * app-wide to the themed dialog, so there is no second dialog component to introduce here. Modelled
 * on ComposerScreen's `handleCancel`, which has shipped this exact shape for the post composer.
 */
export function useBackDismiss(
  isDirty: boolean,
  discard: () => void,
  copy?: {title?: string; message?: string; discardLabel?: string; keepLabel?: string},
): () => void {
  const latest = useRef({isDirty, discard, copy});
  latest.current = {isDirty, discard, copy};
  return useCallback(() => {
    const {isDirty: dirty, discard: doDiscard, copy: c} = latest.current;
    if (!dirty) {
      doDiscard();
      return;
    }
    Alert.alert(c?.title ?? 'Discard changes?', c?.message, [
      {text: c?.keepLabel ?? 'Keep editing', style: 'cancel'},
      {text: c?.discardLabel ?? 'Discard', style: 'destructive', onPress: doDiscard},
    ]);
  }, []);
}
