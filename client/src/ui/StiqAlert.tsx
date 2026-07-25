/**
 * StiqAlert — the app's own themed replacement for React Native's stock OS alert dialog.
 *
 * RN's `Alert.alert()` renders the platform's native dialog (a bare light Samsung box on Android),
 * which clashes with the app's dark surface. This module is a DROP-IN with the same call signature,
 * rendered instead as a STIQ-styled modal. `installStiqAlert()` reassigns `Alert.alert` at startup
 * so EVERY existing and future `Alert.alert(...)` call across the whole app — with zero per-call-site
 * changes — routes through <StiqAlertHost/>. Mount the host once, high in the tree.
 *
 * Signature parity: alert(title, message?, buttons?, options?). Button styles 'default' | 'cancel'
 * | 'destructive' are honored (RN's full set); a button's onPress fires on tap; with no buttons a
 * single "OK" shows. Requests queue (one visible at a time) so a burst never drops one. The 4th
 * options arg (cancelable / onDismiss) is respected. Alert.prompt is iOS-only and unused here.
 */
import React, {useEffect, useState} from 'react';
import {
  Alert,
  type AlertButton,
  type AlertOptions,
  Modal,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {Press} from './Press';
import {colors, radius, space, type as typeScale, weight} from './theme';

interface AlertRequest {
  title: string;
  message?: string;
  buttons: AlertButton[];
  options?: AlertOptions;
}

// ── Imperative store (module singleton): the host subscribes, stiqAlert() enqueues. ──────────────
let queue: AlertRequest[] = [];
const listeners = new Set<() => void>();
const notify = (): void => {
  for (const l of listeners) l();
};

/** Drop-in for RN's Alert.alert — enqueues a themed dialog. Same signature. */
export function stiqAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions,
): void {
  const normalized = buttons && buttons.length > 0 ? buttons : [{text: 'OK'}];
  queue = [...queue, {title, message, buttons: normalized, options}];
  notify();
}

/** Drop the front request (once dismissed) and reveal the next queued one, if any. */
function shift(): void {
  queue = queue.slice(1);
  notify();
}

/**
 * Replace RN's Alert.alert with the themed version, app-wide. Idempotent; call once at startup
 * (index.js) before any alert can fire. Alert.alert is a writable static method, so reassigning it
 * transparently reroutes every `Alert.alert(...)` call site through the host.
 */
let installed = false;
export function installStiqAlert(): void {
  if (installed) return;
  installed = true;
  (Alert as unknown as {alert: typeof stiqAlert}).alert = stiqAlert;
}

/**
 * The single always-mounted dialog surface. Renders the front of the queue as a STIQ-styled modal.
 * Mount once, high in the tree (App root), so alerts float above every screen.
 */
export function StiqAlertHost(): React.JSX.Element {
  const [, force] = useState(0);
  const req = queue[0];
  // Retain the last request so the fade-out still renders content after the queue drains. The Modal
  // stays mounted at ALL times and is driven by `visible`: Android presents a Modal only on a
  // `visible` false→true transition, so a conditionally-mounted `<Modal visible>` (returning null
  // when idle) frequently never appears — the same bug fixed in the Log tab's detail sheet.
  const [lastReq, setLastReq] = useState<AlertRequest | undefined>(req);
  useEffect(() => {
    const rerender = (): void => force(n => n + 1);
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);
  useEffect(() => {
    if (req) setLastReq(req);
  }, [req]);

  const shown = req ?? lastReq;

  const choose = (btn: AlertButton): void => {
    if (!req) return; // ignore taps landing during the fade-out after the queue drained
    shift();
    btn.onPress?.();
  };
  const onDismiss = (): void => {
    if (!req || req.options?.cancelable === false) return;
    shift();
    req.options?.onDismiss?.();
  };

  // Stack vertically for 3+ buttons or long labels; otherwise a tidy side-by-side row.
  const stack =
    !!shown &&
    (shown.buttons.length > 2 || shown.buttons.some(b => (b.text?.length ?? 0) > 11));

  return (
    <Modal
      visible={!!req}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onDismiss}>
      {shown && (
        <View style={s.backdrop}>
          <Press variant="bare" style={StyleSheet.absoluteFill} onPress={onDismiss} accessibilityLabel="dismiss-dialog" accessibilityRole="none" />
          <View style={s.card}>
            <Text style={s.title}>{shown.title}</Text>
            {shown.message ? <Text style={s.message}>{shown.message}</Text> : null}
            <View style={[s.actions, stack && s.actionsStack]}>
              {shown.buttons.map((b, i) => {
                const isPrimary = b.style !== 'cancel' && b.style !== 'destructive';
                return (
                  <Press
                    key={`${b.text ?? 'ok'}-${i}`}
                    style={[s.btn, stack ? s.btnStack : s.btnRow, isPrimary && s.btnPrimary]}
                    onPress={() => choose(b)}>
                    <Text
                      style={[
                        s.btnText,
                        isPrimary && s.btnPrimaryText,
                        b.style === 'cancel' && s.btnCancelText,
                        b.style === 'destructive' && s.btnDangerText,
                      ]}>
                      {b.text ?? 'OK'}
                    </Text>
                  </Press>
                );
              })}
            </View>
          </View>
        </View>
      )}
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
    paddingBottom: space.lg,
  },
  title: {
    fontSize: typeScale.subheading,
    fontWeight: weight.bold,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  message: {
    fontSize: typeScale.label,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginTop: space.sm,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'stretch',
    gap: space.sm,
    marginTop: space.xl,
  },
  // 3+ buttons / long labels stack; column-reverse keeps a leading Cancel at the bottom (familiar).
  actionsStack: {flexDirection: 'column-reverse'},
  btn: {
    borderRadius: radius.pill,
    paddingVertical: 11,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  btnRow: {flex: 1},
  btnStack: {alignSelf: 'stretch'},
  btnPrimary: {backgroundColor: colors.accent, borderColor: colors.accent},
  btnText: {fontSize: typeScale.body, fontWeight: weight.semibold, color: colors.textPrimary},
  btnPrimaryText: {color: colors.onAccent},
  btnCancelText: {color: colors.textSecondary},
  btnDangerText: {color: colors.danger},
});
