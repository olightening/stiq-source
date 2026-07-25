/**
 * User bans — a richer, reversible "hide user" (multi-level moderation, human layer).
 *
 * A moderator bans a user with a fixed message; while the ban is active, the user's posts are
 * auto-hidden everywhere and logged with that message. Bans are kind-1984 stiq-actions targeting
 * a pubkey (`p` tag), so they're append-only and reversible (a later `unban` from any moderator
 * lifts it — latest action wins), exactly like the rest of the moderation model.
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import {moderatorPubkeySet} from './moderators';
import {stiqActionOf} from './report';

export interface BanInfo {
  /** The fixed message the moderator attached to the ban. */
  message: string;
  /** When the ban was issued (unix seconds). */
  since: number;
  /** Optional expiry (unix seconds); absent = permanent. */
  until?: number;
  /** Hex pubkey of the banning moderator. */
  moderatorPubkey: string;
}

/**
 * Active bans by author pubkey, from moderators' kind-1984 ban/unban actions (latest wins).
 * Expired bans (past `ban-until`) are excluded. Pass `nowSec` so the result is deterministic.
 */
export function bannedAuthors(
  store: EventStore,
  npubs: readonly string[] | undefined,
  nowSec: number,
): Map<string, BanInfo> {
  const mods = moderatorPubkeySet(npubs);
  const latest = new Map<string, {ts: number; ev: Event; action: 'ban' | 'unban'}>();
  for (const r of store.query({kinds: [Kind.Report]})) {
    if (!mods.has(r.pubkey)) continue;
    const sa = stiqActionOf(r);
    if (sa !== 'ban' && sa !== 'unban') continue;
    const p = r.tags.find(t => t[0] === 'p')?.[1];
    if (!p) continue;
    const seen = latest.get(p);
    if (!seen || r.created_at > seen.ts) latest.set(p, {ts: r.created_at, ev: r, action: sa});
  }
  const out = new Map<string, BanInfo>();
  for (const [p, v] of latest) {
    if (v.action !== 'ban') continue; // latest action is a lift
    const untilTag = v.ev.tags.find(t => t[0] === 'ban-until')?.[1];
    const until = untilTag ? parseInt(untilTag, 10) : undefined;
    if (until && Number.isFinite(until) && until <= nowSec) continue; // expired
    out.set(p, {message: v.ev.content, since: v.ev.created_at, until, moderatorPubkey: v.ev.pubkey});
  }
  return out;
}

/** A banned user plus their pubkey — the array shape the moderator console renders. */
export interface BannedMember extends BanInfo {
  pubkey: string;
}

/** Active bans as an array (newest first), for the moderator console's "Banned members" list. */
export function bannedMembers(
  store: EventStore,
  npubs: readonly string[] | undefined,
  nowSec: number,
): BannedMember[] {
  return [...bannedAuthors(store, npubs, nowSec).entries()]
    .map(([pubkey, info]) => ({pubkey, ...info}))
    .sort((a, b) => b.since - a.since);
}
