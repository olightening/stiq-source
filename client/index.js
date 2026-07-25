/**
 * Entry point. Registers the root component with React Native.
 *
 * polyfills must be the first import so Babel's require() hoisting
 * puts it before any library that uses TextDecoder/TextEncoder.
 */
import './src/polyfills';
import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {runBackgroundSync} from './src/background/syncTask';
import {installTextDefaults} from './src/ui/typography';
import {installStiqAlert} from './src/ui/StiqAlert';
import {log} from './src/util/log';
import {installLongTaskWatchdog} from './src/dev/longTaskWatchdog';

// Pin Inter + kill Android's includeFontPadding on every <Text>/<TextInput> before any UI
// renders, so vertical rhythm matches the design's CSS line-box model app-wide.
installTextDefaults();

// Reroute every Alert.alert(...) through the STIQ-themed dialog (StiqAlertHost) instead of the
// bare native OS box, app-wide, before any alert can fire. Zero per-call-site changes needed.
installStiqAlert();

// P2-4 diagnostic aid (UI_FREEZE_DIAGNOSIS_ONDEVICE_2026-07-12.md): opt-in JS-thread stall
// watchdog. A complete no-op — no timer started — while LONGTASK_WATCHDOG_MS (config.ts) is 0,
// which is the default. Only costs anything when a developer flips the flag for an on-device pass.
installLongTaskWatchdog();

// Local-only crash/rejection breadcrumbs: record into the in-memory ring buffer (log.ts) so a
// future "copy diagnostics" screen has something to show, then fall through to whatever handler
// was already installed (RN's own dev redbox / release-mode reporting). Never sends anything off
// the device — see log.ts. Wrapped defensively so a missing/odd global never blocks startup.
try {
  const prevHandler = global.ErrorUtils && global.ErrorUtils.getGlobalHandler
    ? global.ErrorUtils.getGlobalHandler()
    : null;
  if (global.ErrorUtils && typeof global.ErrorUtils.setGlobalHandler === 'function') {
    global.ErrorUtils.setGlobalHandler((error, isFatal) => {
      try {
        log.error('uncaught', isFatal ? 'fatal' : 'nonfatal', error);
      } catch {
        // logging must never be the reason a crash handler itself throws
      }
      if (prevHandler) {
        prevHandler(error, isFatal);
      }
    });
  }
} catch {
  // best-effort only — never block app startup over diagnostics wiring
}

// Unhandled promise rejection tracking, if the polyfill is present in this tree (it ships with
// react-native's own dependency graph today, but stay defensive — this must never crash startup
// or add meaningful cost if it's ever absent).
try {
  require('promise/setimmediate/rejection-tracking').enable({
    allRejections: true,
    onUnhandled: (id, error) => {
      try {
        log.error('unhandledRejection', String(id), error);
      } catch {
        // logging must never be the reason this handler itself throws
      }
    },
  });
} catch {
  // module not present in this tree — skip silently, no functional loss beyond the breadcrumb
}

AppRegistry.registerComponent(appName, () => App);

// Headless task: WorkManager fires StiqSyncService which triggers this task in a
// background JS context (no UI). Connects Tor, drains relay to EOSE, persists, disconnects.
AppRegistry.registerHeadlessTask('StiqBackgroundSync', () => runBackgroundSync);
