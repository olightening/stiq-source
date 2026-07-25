/**
 * Display names — relay-blind, locally-rendered nicknames with a longest-held-wins phonebook.
 *
 * A display name is NEVER published as kind-0 metadata. Instead a user's chosen name rides
 * *inside* the content they author — both NIP-17 DMs and ordinary posts/comments — as a control
 * header (SOH 'n' <name> SOH) that the relay never interprets. Readers strip the header, learn
 * `npub → name`, and render it locally. Until learned, others just see your npub.
 *
 * **Uniqueness (anti-impersonation).** Names are not globally registered, so two npubs can claim
 * the same name. The phonebook resolves the clash deterministically: the npub that has held the
 * name *longest* (earliest claim timestamp) is its rightful owner and renders the name; any later
 * claimant renders as bare npub only. Every device converges on the same owner because the claim
 * timestamp is the authored event's `created_at`, not local receipt time.
 *
 * Your OWN name always renders for yourself (getMyName), regardless of clashes — which is exactly
 * why losing the arbitration used to be invisible to the one person it affects: the community sees
 * your npub while your own screens still say your name. {@link DisplayNameStore.nameConflict}
 * detects that state so a UI can say so (ProfileScreen's banner), and it is deliberately the ONLY
 * uniqueness question this module will answer — "is this name taken?" is unanswerable in a
 * relay-blind client (no registry exists, by design) and must never be faked.
 */
import type {SecureStorage} from '../keys/keystore';
import {
  LEGACY_DISPLAYNAME_SELF,
  LEGACY_DISPLAYNAME_BOOK,
  displayNameSelfKey,
  displayNameBookKey,
} from '../app/workspaceKeys';

const PERSIST_DEBOUNCE_MS = 1500;

/** Max name length, to keep the header small and avoid abuse. */
export const MAX_DISPLAY_NAME = 40;

// A rumor/post body may begin with a control-delimited header: SOH 'n' <name> SOH. The U+0001
// (SOH) control char never appears in normal typed text, so this won't collide with real content.
const SOH = String.fromCharCode(1);
/** Max length of the gradient wire payload, to keep the header small and unbreakable. */
const MAX_GRADIENT_WIRE = 64;

// Leading control-delimited headers may precede a body, in any order:
//   SOH 'n' <name> SOH      — the author's display name
//   SOH 'g' <wire> SOH      — the author's gradient identity (opaque compact form)
//   SOH 'i' <wire> SOH      — a space-invite payload (base64url; see channels/membership.ts).
//                             Parsed here ONLY so every renderer strips it like the identity
//                             headers — the invite semantics live entirely in membership.ts.
//   SOH 'a' <wire> SOH      — an event application/control frame (base64url; see
//                             events/eventFrames.ts). Same deal: parsed here ONLY so every
//                             renderer strips it; the RSVP semantics live in the events layer.
const NAME_RE = new RegExp(`^${SOH}n([^${SOH}\\n]{0,${MAX_DISPLAY_NAME}})${SOH}`);
const GRAD_RE = new RegExp(`^${SOH}g([^${SOH}\\n]{0,${MAX_GRADIENT_WIRE}})${SOH}`);
/** Max length of an invite frame's wire (matches membership.ts MAX_INVITE_WIRE). Sized to carry an
 *  optional relay-verifiable invite grant (a base64 kind-9010 event) alongside the render snapshot. */
const MAX_INVITE_WIRE = 1600;
const INVITE_RE = new RegExp(`^${SOH}i([A-Za-z0-9_-]{0,${MAX_INVITE_WIRE}})${SOH}`);
/** Max length of an event control frame's wire (matches events/eventFrames.ts MAX_EVENT_FRAME_WIRE).
 *  Sized for the approve frame — the largest, carrying the post-approval reveal payload. */
const MAX_EVENT_WIRE = 2048;
const EVENT_FRAME_RE = new RegExp(`^${SOH}a([A-Za-z0-9_-]{0,${MAX_EVENT_WIRE}})${SOH}`);

/** Strip control characters and clamp length so a name can't break the header framing. */
export function sanitizeName(name: string): string {
  let out = '';
  for (const ch of name) {
    if (ch.charCodeAt(0) >= 32) out += ch;
  }
  return out.trim().slice(0, MAX_DISPLAY_NAME);
}

/** Strip control chars / newlines and clamp, so a gradient wire can't break the header framing. */
function sanitizeWire(wire: string): string {
  let out = '';
  for (const ch of wire) {
    if (ch.charCodeAt(0) >= 32) out += ch;
  }
  return out.slice(0, MAX_GRADIENT_WIRE);
}

/** Consume any leading identity/invite/event headers (any order) off `body`. */
function parseHeaders(body: string): {
  name?: string;
  gradient?: string;
  invite?: string;
  eventFrame?: string;
  text: string;
} {
  let rest = body;
  let name: string | undefined;
  let gradient: string | undefined;
  let invite: string | undefined;
  let eventFrame: string | undefined;
  for (;;) {
    const nm = NAME_RE.exec(rest);
    if (nm) {
      name = sanitizeName(nm[1] ?? '');
      rest = rest.slice(nm[0].length);
      continue;
    }
    const gm = GRAD_RE.exec(rest);
    if (gm) {
      gradient = gm[1] ?? '';
      rest = rest.slice(gm[0].length);
      continue;
    }
    const im = INVITE_RE.exec(rest);
    if (im) {
      invite = im[1] ?? '';
      rest = rest.slice(im[0].length);
      continue;
    }
    const em = EVENT_FRAME_RE.exec(rest);
    if (em) {
      eventFrame = em[1] ?? '';
      rest = rest.slice(em[0].length);
      continue;
    }
    break;
  }
  return {name, gradient, invite, eventFrame, text: rest};
}

/** Prefix an outgoing body with the sender's display-name header (no-op if name is empty). */
export function encodeNameHeader(text: string, myName: string): string {
  const clean = sanitizeName(myName);
  return clean ? `${SOH}n${clean}${SOH}${text}` : text;
}

/**
 * Prefix an outgoing body with the sender's identity headers — display name and/or gradient wire.
 * Either may be empty. Headers are control-framed so the relay never interprets them and readers
 * strip them before display.
 */
export function encodeIdentityHeader(text: string, myName: string, gradientWire: string): string {
  let out = text;
  const wire = sanitizeWire(gradientWire);
  if (wire) out = `${SOH}g${wire}${SOH}${out}`;
  const name = sanitizeName(myName);
  if (name) out = `${SOH}n${name}${SOH}${out}`;
  return out;
}

/** The author's claimed gradient wire (if any), from any plaintext authored body. */
export function decodeGradientHeader(body: string): string | undefined {
  return parseHeaders(body).gradient || undefined;
}

/** Prefix an outgoing body with a space-invite frame (opaque base64url wire; see membership.ts). */
export function encodeInviteHeader(text: string, inviteWire: string): string {
  // The wire is producer-controlled base64url so it can never collide with the SOH framing; the
  // length guard mirrors INVITE_RE so an oversized frame is dropped rather than half-framed.
  if (!inviteWire || inviteWire.length > MAX_INVITE_WIRE || !/^[A-Za-z0-9_-]+$/.test(inviteWire)) {
    return text;
  }
  return `${SOH}i${inviteWire}${SOH}${text}`;
}

/** The space-invite wire (if any) framed at the head of a received body. */
export function decodeInviteHeader(body: string): string | undefined {
  return parseHeaders(body).invite || undefined;
}

/** Prefix an outgoing body with an event control frame (opaque base64url wire; see
 *  events/eventFrames.ts). Mirrors encodeInviteHeader: producer-controlled base64url only, and an
 *  oversized/dirty wire is dropped whole rather than half-framed. */
export function encodeEventFrameHeader(text: string, frameWire: string): string {
  if (!frameWire || frameWire.length > MAX_EVENT_WIRE || !/^[A-Za-z0-9_-]+$/.test(frameWire)) {
    return text;
  }
  return `${SOH}a${frameWire}${SOH}${text}`;
}

/** The event control-frame wire (if any) framed at the head of a received body. */
export function decodeEventFrameHeader(body: string): string | undefined {
  return parseHeaders(body).eventFrame || undefined;
}

/** Split a received body into the author's claimed name (if any) and the visible text. Strips the
 *  gradient header too, so neither identity header ever leaks into displayed text or search. */
export function decodeNameHeader(body: string): {name?: string; text: string} {
  const {name, text} = parseHeaders(body);
  return name !== undefined ? {name, text} : {text};
}

/** One pubkey's current claim: the name and the earliest timestamp we've seen them use it. */
interface Claim {
  name: string;
  at: number; // seconds (authored event created_at)
}

/**
 * A name the viewer has definitively LOST: some other pubkey holds an older claim, so every device
 * in the community — including this one, for everyone but the viewer — awards them the name and
 * renders the viewer as a bare npub. See {@link DisplayNameStore.nameConflict}.
 */
export interface NameConflict {
  /** The contested name (exactly as the loser claims it). */
  name: string;
  /** The pubkey that wins the arbitration — the earlier claimant. */
  owner: string;
  /** The winning claim's timestamp (seconds, authored created_at). Earlier than the loser's. */
  ownerSince: number;
}

/**
 * Persistent display-name store: your own name + a learned npub→name phonebook with
 * longest-held-wins ownership resolution.
 */
export class DisplayNameStore {
  /** pubkey → its current claim. */
  private byPubkey = new Map<string, Claim>();
  /** name → (pubkey → earliest claim time) for everyone currently claiming that name. */
  private claimants = new Map<string, Map<string, number>>();
  private myName = '';
  private persistTimer?: ReturnType<typeof setTimeout>;
  /** Storage key for MY name (per identity slot) and the learned phonebook (per community). */
  private myNameKey: string;
  private bookKey: string;

  constructor(private readonly storage: SecureStorage | null, slotId?: string, cid?: string) {
    this.myNameKey = slotId ? displayNameSelfKey(slotId) : LEGACY_DISPLAYNAME_SELF;
    this.bookKey = cid ? displayNameBookKey(cid) : LEGACY_DISPLAYNAME_BOOK;
  }

  /**
   * Re-point this store at a different identity slot + community and reload from storage. Used by
   * the community switch: MY name is per-slot, the learned name phonebook is per-community, so both
   * must swap together. Any pending debounced persist for the OUTGOING community is flushed first so
   * its last edit isn't lost, then the in-memory state is cleared before the new namespace loads.
   */
  async reload(slotId?: string, cid?: string): Promise<void> {
    await this.flush();
    this.byPubkey.clear();
    this.claimants.clear();
    this.myName = '';
    this.myNameKey = slotId ? displayNameSelfKey(slotId) : LEGACY_DISPLAYNAME_SELF;
    this.bookKey = cid ? displayNameBookKey(cid) : LEGACY_DISPLAYNAME_BOOK;
    await this.load();
  }

  async load(): Promise<void> {
    if (!this.storage) return;
    try {
      this.myName = (await this.storage.getItem(this.myNameKey)) ?? '';
      const raw = await this.storage.getItem(this.bookKey);
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, Claim>;
        for (const [pubkey, claim] of Object.entries(obj)) {
          if (claim && typeof claim.name === 'string') {
            this.record(pubkey, claim.name, typeof claim.at === 'number' ? claim.at : 0);
          }
        }
      } else if (this.bookKey === LEGACY_DISPLAYNAME_BOOK) {
        // The v1→v2 migration only applies to the legacy global book. A per-community book that is
        // simply empty must NOT pull in the old global names (that would leak names across
        // communities); the global→per-community move is handled once by app/migration.ts.
        await this.migrateLegacy();
      }
    } catch {
      // start empty on corrupt/absent storage
    }
  }

  /** One-time migration from the v1 flat {pubkey: name} book (claim times unknown → 0). */
  private async migrateLegacy(): Promise<void> {
    try {
      const legacy = await this.storage?.getItem('stiq.displayName.book');
      if (!legacy) return;
      const obj = JSON.parse(legacy) as Record<string, string>;
      for (const [pubkey, name] of Object.entries(obj)) {
        if (typeof name === 'string') this.record(pubkey, name, 0);
      }
      await this.persist();
    } catch {
      // ignore malformed legacy book
    }
  }

  getMyName(): string {
    return this.myName;
  }

  async setMyName(name: string): Promise<void> {
    this.myName = sanitizeName(name);
    await this.storage?.setItem(this.myNameKey, this.myName);
  }

  /**
   * The display name to render for `pubkey`, or undefined when none is known OR `pubkey` is not
   * the rightful (longest-holding) owner of the name it claims — so impersonators show as npub.
   */
  nameFor(pubkey: string): string | undefined {
    const claim = this.byPubkey.get(pubkey);
    if (!claim) return undefined;
    return this.ownerOf(claim.name) === pubkey ? claim.name : undefined;
  }

  /** The pubkey that has held `name` the longest (earliest claim; ties broken by hex order). */
  ownerOf(name: string): string | undefined {
    const claimants = this.claimants.get(name);
    if (!claimants || claimants.size === 0) return undefined;
    let owner: string | undefined;
    let bestAt = Infinity;
    for (const [pubkey, at] of claimants) {
      if (at < bestAt || (at === bestAt && (owner === undefined || pubkey < owner))) {
        bestAt = at;
        owner = pubkey;
      }
    }
    return owner;
  }

  /**
   * Whether `pubkey` claiming `name` LOSES the longest-held-wins arbitration to someone else —
   * i.e. the community renders them as a bare npub while they themselves still see their own name
   * (getMyName always renders for its owner, and feed.ts short-circuits self to it). That gap is
   * the silent failure this exists to surface: today a member can be invisible under their chosen
   * name to every other person in the community and never be told.
   *
   * `name` defaults to the viewer's own; returns undefined when there is no conflict.
   *
   * The arbitration run here is EXACTLY {@link ownerOf}'s, with one addition: `pubkey`'s own claim
   * is included even when the phonebook has never seen it. That matters, because a claim only
   * enters the phonebook once content carrying it has been authored and observed. Without this,
   * asking about a name you have chosen but not yet posted under would report a conflict against
   * ANY existing claimant — including one you would actually beat. So the claim time used is:
   *
   *   - the timestamp already learned for `pubkey` under this exact name, when there is one
   *     (authored content of theirs has round-tripped — this is the number every other device
   *     will arbitrate on), else
   *   - `now`, because a name not yet published can only be claimed from this moment forward, and
   *     therefore loses to every existing claimant. That is not pessimism, it is the truth: peers
   *     cannot award you a name on the strength of content they have never seen.
   *
   * **This is only ever as truthful as what has synced.** It answers "given what I know, have I
   * definitively lost this name?" — never "is this name free?", which no relay-blind client can
   * know (there is no registry, by design). A `undefined` return is therefore NOT a promise of
   * uniqueness and must never be rendered as one.
   */
  nameConflict(pubkey: string, name?: string, now?: number): NameConflict | undefined {
    const contested = sanitizeName(name ?? this.myName);
    if (!contested || !pubkey) return undefined;
    const claimants = this.claimants.get(contested);
    if (!claimants || claimants.size === 0) return undefined;

    const mine = this.byPubkey.get(pubkey);
    const myAt =
      mine && mine.name === contested ? mine.at : now ?? Math.floor(Date.now() / 1000);

    // Same comparison as ownerOf (earliest wins; ties broken by hex order), seeded with our own
    // claim so the winner is decided among ALL claimants including us.
    let owner = pubkey;
    let bestAt = myAt;
    for (const [claimant, at] of claimants) {
      if (claimant === pubkey) continue;
      if (at < bestAt || (at === bestAt && claimant < owner)) {
        bestAt = at;
        owner = claimant;
      }
    }
    return owner === pubkey ? undefined : {name: contested, owner, ownerSince: bestAt};
  }

  /**
   * Record a peer's claimed display name (from a decrypted DM or an authored post). `claimedAt`
   * is the authored event's created_at (seconds); defaults to "now" for live/local use. Schedules
   * a debounced persist only when something actually changed (in-memory update is immediate).
   */
  async learn(pubkey: string, name: string, claimedAt?: number): Promise<void> {
    const at = claimedAt ?? Math.floor(Date.now() / 1000);
    if (this.record(pubkey, name, at)) {
      this.schedulePersist();
    }
  }

  /** In-memory update. Returns true if the phonebook changed (caller decides whether to persist). */
  private record(pubkey: string, rawName: string, at: number): boolean {
    const name = sanitizeName(rawName);
    if (!name) return false;

    const prev = this.byPubkey.get(pubkey);
    if (prev && prev.name === name) {
      // Same name — keep only the EARLIEST claim time (longest-held is what matters).
      if (at >= prev.at) return false;
      prev.at = at;
      this.claimants.get(name)?.set(pubkey, at);
      return true;
    }

    // Switching names: drop the old claim so a vacated name can be re-owned by someone else.
    if (prev) {
      const old = this.claimants.get(prev.name);
      old?.delete(pubkey);
      if (old && old.size === 0) this.claimants.delete(prev.name);
    }

    this.byPubkey.set(pubkey, {name, at});
    let claimants = this.claimants.get(name);
    if (!claimants) {
      claimants = new Map();
      this.claimants.set(name, claimants);
    }
    claimants.set(pubkey, at);
    return true;
  }

  /** Debounced persist: schedules a save if one isn't already pending. */
  private schedulePersist(): void {
    if (this.persistTimer !== undefined) {
      return; // a persist is already pending; it will capture this change too
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    const obj: Record<string, Claim> = {};
    for (const [pubkey, claim] of this.byPubkey) obj[pubkey] = claim;
    await this.storage?.setItem(this.bookKey, JSON.stringify(obj));
  }

  /** Ensure any pending persist is flushed immediately (e.g. on shutdown). */
  async flush(): Promise<void> {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persist();
  }
}
