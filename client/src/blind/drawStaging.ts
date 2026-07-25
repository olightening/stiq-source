/**
 * Durable draw-in-flight staging (F10, TOKEN_FIXING_PLAN.md T3.1).
 *
 * A freshly-blinded, organizer-signed token batch otherwise lives ONLY in the JS heap between the
 * 9025 response and the caller's `wallet.add()` — a process kill in that window (routine: draws run
 * right after a relay (re)connect, exactly when Android is most likely to background/kill the app)
 * loses the whole PAID batch with no recovery. This module is the small SecureStorage record that
 * closes that gap: it persists a {@link DrawMarker} (built by drawExchange.ts, which owns the
 * knowledge of exactly what `finalize()` needs) BEFORE the mailbox round-trip, so a killed-and-relaunched
 * process can resume instead of losing the batch (see AppRuntime.resumeStagedDraw).
 *
 * SILOING: keyed by (namespace, purpose) — namespace mirrors the wallets' own per-slot (per-account)
 * namespace (see wallet.ts's walletStorageKeys), and purpose separates the five domains that can draw
 * concurrently (posting, space-write, picture-write, audio-write, read all run independent Tor
 * round-trips over independent wallets — see AppRuntime.stockAuxiliaryWallets/drawTokens/
 * unlockContentEpoch). Two purposes drawing at once must never clobber each other's marker, and a
 * marker must never be reachable from a different account's namespace — SAME isolation guarantee the
 * wallets themselves already provide, reusing the SAME SecureStorage instance (never AsyncStorage: a
 * marker carries bearer-token secrets, exactly like the wallet it stages for).
 */
import type {SecureStorage} from '../keys/keystore';
import type {DrawMarker, DrawPurpose} from './drawExchange';

const DRAW_MARKER_ITEM = 'stiq.wallet.drawMarker';

/**
 * F-F: a marker older than this is treated as ABANDONED rather than resumable, and purged (its
 * blinding/token secrets cleared from SecureStorage) the next time it's loaded, instead of being
 * handed back for a resume attempt. The normal resume path is short-lived — a marker is reconciled
 * into its wallet (or definitively given up on) the very next time its owning purpose draws, which
 * happens on every relay (re)connect / proactive top-up / on-demand draw, i.e. within seconds to
 * minutes of the process that staged it dying. A marker still sitting here days later has no
 * realistic path left to ever finalize (its owning process is long gone and nothing keeps retrying
 * it on its own), so leaving it forever would just keep paid-for bearer-token secrets on disk with
 * no TTL. A few days is deliberately generous — well past any plausible "phone was off all
 * weekend" gap — so it never cuts off a real short-lived resume. Exported so tests can assert
 * against the exact cutoff rather than a duplicated magic number.
 */
export const STALE_DRAW_MARKER_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/** The SecureStorage key one purpose's marker lives under, in `namespace` — mirrors
 *  {@link import('./wallet').walletStorageKeys}'s `base + '.' + namespace` shape. */
function markerKey(namespace: string, purpose: DrawPurpose): string {
  const suffix = namespace ? `.${namespace}` : '';
  return `${DRAW_MARKER_ITEM}.${purpose}${suffix}`;
}

/** Guards a parsed record as a well-formed {@link DrawMarker} before trusting it enough to attempt a
 *  resume. A corrupt/partial record reads as "no marker" (never "repair") — the batch it may have
 *  described is unrecoverable anyway once its shape can't be trusted, so failing safe here just means
 *  an occasional un-collected draw, never a crash loop on a malformed on-disk record. */
function isDrawMarker(v: unknown): v is DrawMarker {
  const m = v as DrawMarker;
  return (
    !!m &&
    typeof m.credId === 'string' &&
    typeof m.epoch === 'number' &&
    typeof m.purpose === 'string' &&
    typeof m.reqHash === 'string' &&
    typeof m.issuerPublicKey === 'string' &&
    typeof m.organizerPubkey === 'string' &&
    !!m.requestEvent &&
    typeof m.replyPubkey === 'string' &&
    typeof m.respConvKey === 'string' &&
    Array.isArray(m.items)
  );
}

/** Persist a draw-in-flight marker, overwriting any prior one for the same (namespace, purpose) — the
 *  correct behavior for a cap-adjustment rebuild (see DrawOptions.onMarker's doc comment). */
export async function saveDrawMarker(
  storage: SecureStorage,
  namespace: string,
  purpose: DrawPurpose,
  marker: DrawMarker,
): Promise<void> {
  await storage.setItem(markerKey(namespace, purpose), JSON.stringify(marker));
}

/** Load a purpose's outstanding marker, or null if none exists / the record is corrupt / it's stale
 *  enough to be considered abandoned (see {@link STALE_DRAW_MARKER_MS} — a stale-but-well-formed
 *  marker is purged here, right before returning null, rather than left to be resumed). */
export async function loadDrawMarker(
  storage: SecureStorage,
  namespace: string,
  purpose: DrawPurpose,
): Promise<DrawMarker | null> {
  try {
    const raw = await storage.getItem(markerKey(namespace, purpose));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isDrawMarker(parsed)) return null;
    if (Date.now() - parsed.savedAt > STALE_DRAW_MARKER_MS) {
      // Abandoned — clear its secrets rather than handing it back for a resume attempt (F-F). The
      // caller then sees exactly what it would for "no marker ever staged" and proceeds straight to
      // a fresh draw.
      await clearDrawMarker(storage, namespace, purpose);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Clear a purpose's marker — called once its batch is reconciled into the wallet, or once it is
 *  definitively unrecoverable (see AppRuntime.resumeStagedDraw). */
export async function clearDrawMarker(
  storage: SecureStorage,
  namespace: string,
  purpose: DrawPurpose,
): Promise<void> {
  await storage.removeItem(markerKey(namespace, purpose));
}
