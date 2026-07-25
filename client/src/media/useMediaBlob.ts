/**
 * useMediaBlob — the ONE load-on-tap state machine, shared by every media modality.
 *
 * `PictureChip` and `VoicePlayer` have exactly the same job: show a quiet chip, and when the viewer
 * taps it, go get the bytes over Tor and report honestly how that went. Only what they do with the
 * bytes afterwards differs (unpack pixel-art vs. decode audio). So the lifecycle lives here, once,
 * and each modality supplies just its own decode step.
 *
 * This is deliberate: this codebase has repeatedly re-implemented the same element divergently across
 * parallel worktrees, and a picture that retries but a voice clip that doesn't (or two subtly
 * different "couldn't load" behaviours) is exactly how that happens. There is one state machine.
 *
 * ## The lifecycle
 *
 *     idle ──load()──▶ loading ──▶ loaded          (bytes fetched AND decoded)
 *                          └─────▶ error           (offline / timeout / malformed / decode)
 *     any  ──reset()─▶ idle
 *
 * `error` is a first-class, ROUTINE state, not a defensive afterthought: these fetches cross Tor,
 * which is slow and drops circuits. A UI built on this hook must render `error` properly — and, when
 * {@link MediaLoad.retryable}, let the viewer tap again.
 *
 * An `inline` source (a legacy body whose bytes rode with the post) moves through the same states
 * without touching the network, so callers never branch on the transport — they render one machine.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {loadMediaSource, MediaBlobFetchError, type BlobFetchFailure} from './mediaBlobService';
import {subscribeRenderedMedia} from './renderedMediaCache';
import {mediaSourceKey, type MediaSource} from '../feed/mediaBlob';

export type MediaLoadState = 'idle' | 'loading' | 'loaded' | 'error';

/** Why a load ended in `error`. `decode` = the bytes arrived but this modality couldn't read them. */
export type MediaLoadError = BlobFetchFailure | 'decode';

/** Whether tapping again could plausibly succeed. Transport hiccups retry; bad bytes never will. */
const RETRYABLE: Record<MediaLoadError, boolean> = {
  offline: true,
  timeout: true,
  malformed: false,
  decode: false,
};

export interface MediaLoad<T> {
  state: MediaLoadState;
  /** This modality's decoded artifact. Non-null iff `state === 'loaded'`. */
  value: T | null;
  /** Why it failed. Non-null iff `state === 'error'`. */
  error: MediaLoadError | null;
  /** Whether tapping again could plausibly help (see {@link RETRYABLE}). */
  retryable: boolean;
  /** Begin loading. No-op unless `state` is `idle` or a retryable `error`. */
  load: () => void;
  /** Return to `idle`, dropping the artifact (e.g. Settings cleared the rendered-media cache). */
  reset: () => void;
}

/**
 * Drive one media chip's load-on-tap lifecycle.
 *
 * `decode` turns the fetched base64 into this modality's artifact — return null to reject unreadable
 * bytes, landing the machine in `error: 'decode'`. It runs INSIDE `loading`, so the spinner covers
 * decode as well as transport (a 48KB unpack is not free on Hermes), and it runs exactly ONCE per
 * load: the result is handed back as {@link MediaLoad.value}, so a caller never re-decodes on render.
 * Keep it referentially stable (module-scope fn or `useCallback`) — it is a `load` dependency.
 *
 * Resets to `idle` when the rendered-media cache is cleared, matching the existing contract: a clear
 * drops rendered artifacts from RAM and reverts cards to tap-to-load. Nothing re-fetches over Tor on
 * its own — a blob already pulled sits in the durable event store, so a re-tap is instant.
 */
export function useMediaBlob<T>(source: MediaSource, decode: (payload: string) => T | null): MediaLoad<T> {
  const [state, setState] = useState<MediaLoadState>('idle');
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<MediaLoadError | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The guards `load` reads to decide whether a tap starts a fetch. Refs (not the state values) so a
  // double-tap in the same frame — before React has re-rendered — still can't start two fetches, and
  // so `load`'s identity doesn't churn on every state transition.
  //
  // `busy`      — a load is in flight.
  // `permanent` — the last failure can never be fixed by retrying (corrupt/undecodable bytes), so
  //               `load` refuses rather than re-fetching bytes we already know we cannot read.
  const busy = useRef(false);
  const permanent = useRef(false);

  const reset = useCallback((): void => {
    busy.current = false;
    permanent.current = false;
    setState('idle');
    setValue(null);
    setError(null);
  }, []);

  // A new source (a recycled FlatList row now showing a different picture) must never keep the
  // previous one's artifact — key the reset on the source's identity, not the object's.
  const key = mediaSourceKey(source);
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current !== key) {
      lastKey.current = key;
      reset();
    }
  }, [key, reset]);

  // Settings → "Delete rendered media": drop back to the quiet chip like every other media card.
  useEffect(() => subscribeRenderedMedia(reset), [reset]);

  const load = useCallback((): void => {
    if (busy.current || permanent.current) return;
    busy.current = true;
    setState('loading');
    setError(null);

    void (async () => {
      const fail = (reason: MediaLoadError): void => {
        busy.current = false;
        permanent.current = !RETRYABLE[reason];
        setError(reason);
        setState('error');
      };
      let got: string;
      try {
        got = await loadMediaSource(source);
      } catch (e) {
        if (!mounted.current) return;
        // Anything that isn't a classified fetch failure is still a real failure — never swallow it
        // into a spinner that spins forever.
        fail(e instanceof MediaBlobFetchError ? e.reason : 'timeout');
        return;
      }
      if (!mounted.current) return;
      let decoded: T | null;
      try {
        decoded = decode(got);
      } catch {
        decoded = null;
      }
      if (!mounted.current) return;
      if (decoded === null) {
        fail('decode');
        return;
      }
      busy.current = false;
      setValue(decoded);
      setState('loaded');
    })();
  }, [source, decode]);

  const retry = state === 'error' && RETRYABLE[error ?? 'decode'];
  return {
    state,
    value: state === 'loaded' ? value : null,
    error: state === 'error' ? error : null,
    retryable: retry,
    load,
    reset,
  };
}
