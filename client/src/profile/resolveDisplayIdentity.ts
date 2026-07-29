/**
 * The ONE shared resolver every surface that renders "who authored this" — feed cards, the
 * post-detail header, comments, LogPostView — must call. It exists because those surfaces used to
 * roll their own attribution chain, and diverged: a post could render a bare npub ("anonymous")
 * while a comment BY THE SAME MEMBER, on the SAME screen, rendered their display name. STIQ's rule
 * is that attribution is ALWAYS npub » display name » gradient; anonymity must never be possible.
 *
 * Precedence, in order:
 *   1. The attribution ATTESTATION carried on the event itself (blind/identity.ts's `resolveAuthor`
 *      — the real npub + name + gradient a blind post's throwaway signer vouches for, decrypted
 *      from `stiq_attr`). This is the one piece of identity that survives even when the phonebook
 *      has never seen this member before (their first-ever post, this device's first sync, …).
 *   2. The learned phonebook (`DisplayNameStore.nameFor` / `GradientStore.gradientFor`) — consulted
 *      (and, for a blind attestation, TAUGHT first — see below) so the community's longest-held-wins
 *      anti-impersonation arbitration always has the final say over a display name. A plaintext
 *      post's SOH header has no attestation to fall back to, so for those the phonebook (already
 *      taught by the ingest/feed-build learn passes) IS the only source beyond the raw npub.
 *   3. The npub itself, with a deterministic seed-derived gradient — the only state that is NEVER
 *      undefined, which is exactly what makes anonymity impossible: there is always something to
 *      render as an identity even when nothing else is known.
 *
 * Teaching the phonebook from the attestation happens INSIDE this resolver (step 1→2), keyed on the
 * RESOLVED real pubkey — never the blind post's throwaway `event.pubkey` — so every call site that
 * switches onto this resolver also, for free, fixes the phonebook's blind-post learning gap (a blind
 * post's real author used to teach the phonebook nothing, since only the plaintext SOH-header path
 * fed it). `names`/`grads` are optional so this can be called with only one, or neither (a bare
 * attestation-then-npub resolve), from anywhere that doesn't hold a full AppRuntime.
 */
import * as nip19 from 'nostr-tools/nip19';
import {resolveAuthor, isOffRollBlindPost} from '../blind/identity';
import type {DisplayNameStore} from './displayName';
import type {GradientStore} from './gradientIdentity';
import {decodeGradient, gradientFromSeed, type GradientSpec} from '../media/gradient';

/** The minimal event shape the resolver (and the blind `resolveAuthor` it wraps) needs. */
export interface IdentityEvent {
  id: string;
  pubkey: string;
  tags: string[][];
  created_at: number;
}

export interface DisplayIdentityDeps {
  /** The learned display-name phonebook. Omit to skip phonebook consultation/teaching entirely. */
  names?: DisplayNameStore;
  /** The learned gradient store. Omit to skip phonebook consultation/teaching entirely. */
  grads?: GradientStore;
  /** The viewer's own pubkey — when the resolved author IS the viewer, their own (live-editable)
   *  name/gradient always renders, exactly as `DisplayNameStore`'s own doc promises, regardless of
   *  any arbitration the phonebook would otherwise apply to a peer. */
  myPubkey?: string;
}

export interface DisplayIdentity {
  /** The real author to attribute this event to (decrypted from a blind attestation, else event.pubkey). */
  pubkey: string;
  /** Bech32 npub of `pubkey`. Always present — the one thing that can never be missing. */
  npub: string;
  /** Display name, when known and (for a peer) not lost to the longest-held-wins arbitration. */
  name?: string;
  /** The gradient to render — a custom claimed gradient, else the deterministic seed fallback.
   *  Always present, by design: a gradient identity must never be able to render as "nothing". */
  gradient: GradientSpec;
}

/**
 * Resolve `event`'s author identity through the full precedence chain described above.
 *
 * Safe to call with the same event repeatedly (e.g. once per render): `resolveAuthor` is itself
 * cached by event id, and re-teaching the phonebook the same already-known claim is a cheap no-op
 * (`DisplayNameStore`/`GradientStore.learn` only schedule a persist when something actually changed).
 */
export function displayIdentityFor(event: IdentityEvent, deps: DisplayIdentityDeps = {}): DisplayIdentity {
  const author = resolveAuthor(event);
  const pubkey = author.pubkey;
  const npub = nip19.npubEncode(pubkey);
  const isMe = deps.myPubkey !== undefined && pubkey === deps.myPubkey;

  // Member-roll enforcement: an off-roll event (valid attestation, never-bound npub) still
  // RENDERS — a mod-log detail sheet legitimately shows the claimed identity — but must not
  // TEACH the phonebook: sock-puppet keys could otherwise squat display names/gradients whose
  // arbitration (longest-held / latest-wins) outlives the hidden post. Reads still resolve.
  const teach = !isOffRollBlindPost(event);
  const name = resolveName(pubkey, isMe, teach ? author.name : undefined, event.created_at, deps.names);
  const gradient =
    resolveGradient(pubkey, isMe, teach ? author.gradient : undefined, event.created_at, deps.grads) ??
    gradientFromSeed(npub);

  return {pubkey, npub, ...(name ? {name} : {}), gradient};
}

function resolveName(
  pubkey: string,
  isMe: boolean,
  attestedName: string | undefined,
  createdAt: number,
  names: DisplayNameStore | undefined,
): string | undefined {
  // Self always renders their own CURRENT name (never the arbitration's answer, never a stale
  // attestation snapshot from whenever this particular post was made) — mirrors displayName.ts's
  // "your own name always renders for yourself" guarantee everywhere else in the app.
  if (isMe) return names?.getMyName() || undefined;
  if (!names) return attestedName;
  // Teach the phonebook from the attestation BEFORE reading it, keyed on the real (resolved) pubkey
  // — never the blind post's throwaway signer. `learn` mutates its in-memory maps synchronously
  // (only the debounced persist is async), so the very next `nameFor` call already sees it.
  if (attestedName) void names.learn(pubkey, attestedName, createdAt);
  // The phonebook (not the raw attestation) has the final word: it applies longest-held-wins
  // arbitration, so a blind post can't bypass anti-impersonation by simply attesting to a name
  // someone else already owns.
  return names.nameFor(pubkey);
}

function resolveGradient(
  pubkey: string,
  isMe: boolean,
  attestedGradientWire: string | undefined,
  createdAt: number,
  grads: GradientStore | undefined,
): GradientSpec | undefined {
  if (isMe) return grads?.getMyGradient() ?? undefined;
  if (!grads) return attestedGradientWire ? decodeGradient(attestedGradientWire) : undefined;
  if (attestedGradientWire) void grads.learn(pubkey, attestedGradientWire, createdAt);
  return grads.gradientFor(pubkey);
}
