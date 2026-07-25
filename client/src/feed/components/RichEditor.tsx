/**
 * RichEditor — a WYSIWYG rich-text editor backed by a sandboxed react-native-webview.
 *
 * The editor itself lives entirely inside a self-contained HTML document (see richEditorHtml.ts):
 * a contenteditable surface + a formatting toolbar that serializes to the app's shared Markdown
 * dialect (the same dialect RichText.tsx renders). This RN wrapper is thin: it owns the WebView,
 * relays the host↔page message protocol, tracks the reported content height (clamped, then the
 * editor scrolls internally), and exposes an imperative API for toolbar/host-driven actions.
 *
 * The WebView runs with JS on but NO network, no DOM storage, no file access — the document is a
 * local string with no remote resources, so there's no fingerprint/leak surface.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Platform,
  StyleSheet,
  UIManager,
  View,
  requireNativeComponent,
  type HostComponent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import WebView, {type WebViewMessageEvent, type WebViewProps} from 'react-native-webview';
import Clipboard from '@react-native-clipboard/clipboard';
import {colors} from '../../ui/theme';

// ── Selection-toolbar suppressor ────────────────────────────────────────────
// Android's OS text-selection toolbar (Cut/Copy/Paste/Translate) is unreliable to suppress for a
// contenteditable WebView via react-native-webview's menuItems prop (issue #3774). We instead nest
// the WebView in a native ViewGroup (StiqNoCabView / NoCabView.kt) that overrides
// startActionModeForChild → null, so the toolbar can never be created. Our in-editor bubble replaces
// it. On iOS (or any build where the native manager isn't registered) this falls back to a plain
// View — iOS relies on the WebView's menuItems/suppressMenuItems props instead.
type FrameProps = {style?: StyleProp<ViewStyle>; children?: React.ReactNode};
const NO_CAB = 'StiqNoCabView';
const NoCabNative: HostComponent<FrameProps> | null =
  Platform.OS === 'android' && UIManager.getViewManagerConfig?.(NO_CAB) != null
    ? requireNativeComponent<FrameProps>(NO_CAB)
    : null;
function EditorFrame({style, children}: FrameProps): React.JSX.Element {
  if (NoCabNative) return <NoCabNative style={style}>{children}</NoCabNative>;
  return <View style={style}>{children}</View>;
}
import {richEditorHtml, type RichEditorTheme} from './richEditorHtml';

// Suppress the OS text-selection menu (the native copy/paste callout) so our in-editor bubble is the
// ONLY selection UI. On Android, react-native-webview builds a custom selection ActionMode whenever
// `menuItems` is a non-null array; an EMPTY array yields an ActionMode with zero items — the native
// toolbar never renders. On iOS an empty custom menu suppresses the callout likewise (and #ed's
// -webkit-touch-callout:none covers the long-press callout). Verified against RNCWebView 14.0.1
// source (RNCWebView.java startActionMode + RNCWebViewManagerImpl.setMenuCustomItems). A module-level
// constant keeps the prop referentially stable so it never triggers a native re-render.
const EMPTY_MENU: {label: string; key: string}[] = [];

// The package's default export is the `WebView` class declared with `P = undefined`, so its JSX
// props resolve to `WebViewProps & undefined` (= `never`) and can't be written inline. Re-type it
// as a plain component that takes WebViewProps + a ref to the class instance (for injectJavaScript /
// postMessage / requestFocus). This is purely a typing alias — the runtime component is unchanged.
const Web = WebView as unknown as React.ForwardRefExoticComponent<
  WebViewProps & React.RefAttributes<WebView>
>;

/** Toolbar/command names the page understands. */
export type RichEditorCommand =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'code'
  | 'body'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'number'
  | 'quote'
  | 'pull'
  | 'footer'
  | 'task'
  | 'details'
  | 'table'
  | 'divider'
  | 'undo'
  | 'redo';

/**
 * The block styles the page reports via its 'state' message (the caret's current block) — drives
 * the composer's block sheet checkmark and the bubble's Aa label. 'table' is reported but not a
 * pickable style (tables insert from the bar's ▦ chip).
 */
export type RichEditorBlock =
  | 'body'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'quote'
  | 'pull'
  | 'footer'
  | 'ul'
  | 'ol'
  | 'task'
  | 'details'
  | 'table';

export interface RichEditorHandle {
  /** Run a formatting command at the current selection. */
  cmd(name: RichEditorCommand): void;
  /** Insert an embed/voice chip (atomic, non-editable) at the caret. */
  insertToken(token: string): void;
  /** Insert a link [text](url) at the caret (call after resolving onRequestLink). */
  insertLink(text: string, url: string): void;
  /** Read the OS clipboard and insert it as plain text at the caret (the Insert bar's Paste). */
  paste(): void;
  /** Focus the editing surface. */
  focus(): void;
  /**
   * Flush any pending debounced edit and hand the freshest markdown to the callback. Call this on
   * Send/Publish so the last keystrokes aren't lost to the in-page change debounce. Falls back to the
   * last known markdown if the editor isn't ready or doesn't answer within a short window.
   */
  requestMarkdown(cb: (md: string) => void): void;
}

export interface RichEditorProps {
  /** Markdown value (controlled). Pushed into the editor when it differs from the last edit. */
  value: string;
  /** Fires (debounced in-page) with the markdown serialization on every edit. */
  onChange: (md: string) => void;
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
  autoFocus?: boolean;
  /** The page's 🔗 toolbar button posts here; resolve a URL then call `insertLink` on the ref. */
  onRequestLink?: () => void;
  /** The bubble's Aa style button posts here; open the native block sheet, then `cmd(<style>)`. */
  onRequestBlockSheet?: () => void;
  /** Fires when the caret's block style changes — keeps the block sheet's checkmark current. */
  onBlockState?: (block: RichEditorBlock) => void;
  /** Override individual theme colors; the rest default from the app palette. */
  theme?: Partial<RichEditorTheme>;
  /** Draw a hairline border + rounded card around the surface. Default true; the Post Editor sets
   *  false so the body is chromeless (the design has no box around the writing area). */
  bordered?: boolean;
}

/** Map the app palette → the editor's flat theme; callers may override any key. */
function mergeTheme(override?: Partial<RichEditorTheme>): RichEditorTheme {
  return {
    bg: colors.bg,
    surface: colors.surface,
    text: colors.textPrimary,
    muted: colors.textMuted,
    accent: colors.accent,
    border: colors.border,
    code: colors.link,
    surfaceAlt: colors.surfaceAlt,
    accentSoft: colors.accentSoft,
    link: colors.link,
    onAccent: colors.onAccent,
    textSecondary: colors.textSecondary,
    padX: 14,
    padY: 12,
    ...override,
  };
}

type PageMessage =
  | {type: 'ready'}
  | {type: 'change'; md: string}
  | {type: 'flushed'; md: string}
  | {type: 'height'; px: number}
  | {type: 'linkRequest'}
  | {type: 'state'; block: string}
  | {type: 'blockSheet'}
  | {type: 'clip'; op: 'copy' | 'cut' | 'paste'; text?: string};

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(
  {value, onChange, placeholder, minHeight = 120, maxHeight = 320, autoFocus, onRequestLink, onRequestBlockSheet, onBlockState, theme, bordered = true},
  ref,
) {
  const webRef = useRef<WebView>(null);
  const ready = useRef(false);
  // The last markdown the page reported (or that we pushed in) — guards against echo loops and
  // clobbering in-flight edits when the controlled `value` round-trips back unchanged.
  const lastMd = useRef<string>(value);
  // A one-shot callback awaiting the next 'flushed' reply (set by requestMarkdown, on Send/Publish).
  const pendingFlush = useRef<((md: string) => void) | null>(null);
  // Bumped every time the PAGE reports content ('change' or 'flushed') — see the push-back effect
  // below. Distinct from `lastMd` (the content itself): this is a monotonic counter used only to
  // detect whether a newer report has arrived since a given render was committed.
  const recvGen = useRef(0);
  // Commands issued before the page has announced 'ready' (WebView still loading, or reloaded after
  // a crash) — send() queues them here instead of silently dropping them; flushed in order the
  // instant 'ready' arrives (see below). Without this, a command fired the moment the composer opens
  // (e.g. an eager "Add link" tap) would postMessage into a bridge nothing is listening to yet.
  const pendingSends = useRef<Record<string, unknown>[]>([]);
  const [height, setHeight] = useState(minHeight);

  const html = useMemo(() => richEditorHtml(mergeTheme(theme)), [theme]);

  const send = useCallback((msg: Record<string, unknown>): void => {
    if (!ready.current) {
      pendingSends.current.push(msg);
      return;
    }
    // postMessage delivers a string to the page's message listener.
    webRef.current?.postMessage(JSON.stringify(msg));
  }, []);

  const pushValue = useCallback(
    (md: string): void => {
      lastMd.current = md;
      send({type: 'setMarkdown', md});
    },
    [send],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent): void => {
      let msg: PageMessage;
      try {
        msg = JSON.parse(e.nativeEvent.data) as PageMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ready':
          ready.current = true;
          // Placeholder text is shown by the page's `#ed:empty::before` from the data-ph attribute;
          // inject it directly (JSON-encoded so quotes can't break out of the script string).
          if (placeholder) {
            webRef.current?.injectJavaScript(
              `(function(){var e=document.getElementById('ed');if(e)e.setAttribute('data-ph',${JSON.stringify(
                placeholder,
              )});})();true;`,
            );
          }
          // Seed the editor with the initial value, then optionally focus.
          if (value) {
            pushValue(value);
          }
          if (autoFocus) {
            webRef.current?.postMessage(JSON.stringify({type: 'focus'}));
          }
          // Flush anything issued while the page was still loading (see send()) — in the order it
          // was queued, so a command fired the instant the composer opened still lands.
          if (pendingSends.current.length) {
            const queued = pendingSends.current;
            pendingSends.current = [];
            for (const m of queued) webRef.current?.postMessage(JSON.stringify(m));
          }
          break;
        case 'change':
          lastMd.current = msg.md;
          recvGen.current += 1;
          onChange(msg.md);
          break;
        case 'flushed': {
          lastMd.current = msg.md;
          recvGen.current += 1;
          onChange(msg.md);
          const cb = pendingFlush.current;
          pendingFlush.current = null;
          cb?.(msg.md);
          break;
        }
        case 'height': {
          const clamped = Math.max(minHeight, Math.min(maxHeight, msg.px));
          setHeight(clamped);
          break;
        }
        case 'linkRequest':
          onRequestLink?.();
          break;
        case 'blockSheet':
          onRequestBlockSheet?.();
          break;
        case 'state':
          onBlockState?.(msg.block as RichEditorBlock);
          break;
        case 'clip':
          // Our bubble owns copy/cut/paste; the actual OS clipboard I/O happens here on the RN side
          // (the WebView can't reliably read the clipboard). copy/cut carry the plain-text selection;
          // paste reads the OS clipboard and feeds it back into the editor as plain text.
          if (msg.op === 'paste') {
            // Bubble Paste: replaces the active selection (the bubble only shows with one).
            Clipboard.getString()
              .then(t => { if (t) send({type: 'insertText', text: t}); })
              .catch(() => {}); // a locked-down OEM clipboard can reject — fail silently, don't crash
          } else if (msg.text) {
            Clipboard.setString(msg.text);
          }
          break;
        default:
          break;
      }
    },
    [autoFocus, maxHeight, minHeight, onChange, onRequestLink, onRequestBlockSheet, onBlockState, placeholder, pushValue, send, value],
  );

  // Snapshot 'how many times the page has reported new content, as of THIS render' — a plain number
  // read fresh on every render (unlike `recvGen.current` read live inside the effect below, which
  // reflects whatever is true at the moment the effect actually RUNS, possibly later).
  const recvGenAtRender = recvGen.current;

  // Push the controlled value in whenever the parent changes it to something the editor isn't
  // already showing (avoids clobbering the user's own edits, which round-trip via lastMd). Runs
  // after commit so we never postMessage during render. The 'ready' handler does the first seed.
  //
  // Stale-push race (root cause): the page debounces DOM->markdown serialization and can post a
  // 'change' message at any time, including in the gap between this render committing and this very
  // effect actually running (useEffect is scheduled, not synchronous with commit). If a NEWER 'change'
  // arrives in that gap, `lastMd.current` has already moved past what `value` (captured by this
  // render's closure) reflects — the naive `value !== lastMd.current` check would then read as "the
  // parent has something new to push" for the WRONG reason (render lag, not a real external change),
  // and pushValue would overwrite the page's newer content — and everything the user typed since —
  // with this render's now-stale value. Comparing the LIVE recvGen (as of when the effect runs)
  // against the snapshot taken when `value` was rendered catches exactly that gap: if a report landed
  // since, skip — the page already has content at least as new as anything this render knows about.
  useEffect(() => {
    if (ready.current && value !== lastMd.current && recvGen.current === recvGenAtRender) {
      pushValue(value);
    }
  }, [value, pushValue, recvGenAtRender]);

  useImperativeHandle(
    ref,
    () => ({
      cmd(name: RichEditorCommand): void {
        send({type: 'cmd', name});
      },
      insertToken(token: string): void {
        send({type: 'insertToken', token});
      },
      insertLink(text: string, url: string): void {
        send({type: 'insertLink', text, url});
      },
      paste(): void {
        // Read the OS clipboard on the RN side and insert it as plain text at the caret. Used by the
        // composer's Insert-bar Paste, which must work with no selection (the bubble is hidden then).
        // atCaret:true so a leftover non-collapsed selection is collapsed, not overwritten.
        Clipboard.getString()
          .then(t => { if (t) send({type: 'insertText', text: t, atCaret: true}); })
          .catch(() => {});
      },
      focus(): void {
        send({type: 'focus'});
        webRef.current?.requestFocus?.();
      },
      requestMarkdown(cb: (md: string) => void): void {
        // Not ready → nothing to flush; answer with the last known value immediately.
        if (!ready.current) {
          cb(lastMd.current);
          return;
        }
        let done = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (md: string): void => {
          if (done) return;
          done = true;
          if (retryTimer) clearTimeout(retryTimer);
          cb(md);
        };
        pendingFlush.current = finish;
        // Ask the page to flush now, then keep re-asking on a bounded retry instead of racing a
        // single fixed timeout. flushNow() is O(document) (richEditorHtml.ts's domToMarkdown walks +
        // regexes the whole DOM), so on a slow phone the FIRST request can still genuinely be in
        // flight past a short window — giving up there published `lastMd.current`, which is missing
        // whatever was typed in the gap right before Send. flushNow() always answers (even when
        // unchanged), so re-asking is harmless, never duplicated work the page wasn't already doing.
        send({type: 'flush'});
        let attempt = 0;
        const RETRY_MS = 300;
        const MAX_ATTEMPTS = 6; // ~1.8s total bound — generous for a slow phone, still well under user patience
        const retry = (): void => {
          if (done) return;
          attempt += 1;
          if (attempt >= MAX_ATTEMPTS) { finish(lastMd.current); return; } // last resort, not the default path
          send({type: 'flush'});
          retryTimer = setTimeout(retry, RETRY_MS);
        };
        retryTimer = setTimeout(retry, RETRY_MS);
      },
    }),
    [send],
  );

  return (
    <EditorFrame style={[s.wrap, bordered && s.wrapBordered, {height}]}>
      <Web
        ref={webRef}
        source={{html}}
        originWhitelist={['*']}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        cacheEnabled={false}
        incognito
        // Kill the OS text-selection callout (copy/paste bubble) — our in-editor bubble replaces it.
        // An empty (non-null) menuItems array makes the WebView present a custom selection menu with
        // zero items on both Android and iOS, so no native toolbar appears. See EMPTY_MENU above.
        menuItems={EMPTY_MENU}
        scrollEnabled
        nestedScrollEnabled
        hideKeyboardAccessoryView
        keyboardDisplayRequiresUserAction={false}
        automaticallyAdjustContentInsets={false}
        // A hardware layer makes the contenteditable caret / scrolling smooth on Android.
        androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
        // Local html only — the editor NEVER navigates. Use an ALLOWLIST: permit only the initial
        // document load (about:blank / the inlined data: html / an empty url), and block (return
        // false) every other navigation — http(s)/file/ftp AND about:/data:/blob:/javascript:/
        // intent:/content: that a blocklist would have let through.
        onShouldStartLoadWithRequest={req => {
          const u = (req.url || '').trim();
          return u === '' || u === 'about:blank' || /^data:text\/html[;,]/i.test(u);
        }}
        setSupportMultipleWindows={false}
        style={s.web}
        // Accessibility placeholder is rendered in-page via data-ph; expose it for clarity.
        accessibilityLabel={placeholder}
      />
    </EditorFrame>
  );
});

const s = StyleSheet.create({
  wrap: {
    width: '100%',
    overflow: 'hidden',
    backgroundColor: colors.bg,
  },
  // The hairline card around the surface — on by default, off for the chromeless Post Editor body.
  wrapBordered: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  web: {flex: 1, backgroundColor: 'transparent'},
});
