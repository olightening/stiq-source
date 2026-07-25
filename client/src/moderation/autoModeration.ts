/**
 * Deterministic client-side auto-moderation — the "automatic" layer of multi-level moderation.
 *
 * The organizer's rules are public (kind-30078) and post content is immutable, so every client
 * can independently re-evaluate each post and reach the SAME verdict. A post that breaks a soft
 * rule (missing a required label, or over the max length) is auto-hidden and surfaced in the mod
 * log marked "Automatic" — no event is written, so the verdict propagates instantly, works
 * offline, and can't be forged. A moderator can override a false positive with a normal restore
 * (the only event ever written for an auto-hide).
 *
 * Retroactivity contract (must match the relay): a post is judged only against rules that were
 * already in force when it was created — `created_at >= postRulesAt` — so tightening a rule never
 * retroactively hides older, then-legal posts. (Over-max posts created AFTER the rule are also
 * rejected by the relay at write time; this is the client backstop for a jailbroken client.)
 */
import type {Event} from 'nostr-tools/pure';
import {Kind} from '../nostr/events';
import type {EventStore} from '../nostr/store';
import {moderatorPubkeySet} from './moderators';
import {reportedPostId, stiqActionOf} from './report';
import {isStiqComment} from '../feed/comments';
import {evaluatePost, type PostRules} from '../feed/postRules';
import {bodyForMeasure} from '../feed/inlineMedia';
import {LABEL_NAMESPACE} from '../feed/labels';
import {resolveContent} from '../blind/blindPost';

export interface AutoModConfig {
  postRules: PostRules;
  /** created_at of the active post-rules doc; posts older than this are exempt (no retro-hide). */
  postRulesAt: number;
  /** Pubkeys with an active moderator ban — their posts are hidden (computed by the caller). */
  bannedAuthors?: ReadonlySet<string>;
}

export interface AutoHide {
  /** Why the post was auto-hidden (drives the mod-log reason text). */
  code: 'too-long' | 'label-required';
}

/** The label id on an event's NIP-32 stiq.type tag, or null. */
function labelOf(ev: Event): string | null {
  for (const t of ev.tags) {
    if (t[0] === 'l' && t[2] === LABEL_NAMESPACE && t[1]) return t[1];
  }
  return null;
}

/**
 * Ids whose LATEST visibility action (by an authorized pubkey) is a restore — these override an
 * auto-hide. Exported so per-space auto-moderation reuses the identical restore-override logic,
 * passing the space's admin set instead of the community moderator roster.
 */
export function restoredIds(store: EventStore, mods: ReadonlySet<string>): Set<string> {
  const latest = new Map<string, {ts: number; restore: boolean}>();
  for (const r of store.query({kinds: [Kind.Report]})) {
    if (!mods.has(r.pubkey)) continue;
    const id = reportedPostId(r);
    if (!id) continue;
    const sa = stiqActionOf(r);
    if (sa && sa !== 'restore') continue; // only hide / restore affect visibility
    const seen = latest.get(id);
    if (!seen || r.created_at > seen.ts) latest.set(id, {ts: r.created_at, restore: sa === 'restore'});
  }
  const out = new Set<string>();
  for (const [id, v] of latest) if (v.restore) out.add(id);
  return out;
}

/** True when the rules actually constrain anything (else auto-mod is a no-op). */
function rulesEnforceAnything(r: PostRules): boolean {
  return r.note.max > 0 || r.article.max > 0 || r.note.labelRequired || r.article.labelRequired;
}

/**
 * The set of feed posts (id → why) that the organizer's rules auto-hide right now. Pure over the
 * store + config, so all clients agree. Comments (kind-1 stiq-comment) are skipped — post rules
 * apply to feed posts (kind-1 notes and kind-30023 articles) only.
 */
export function autoHiddenPosts(
  store: EventStore,
  cfg: AutoModConfig,
  npubs?: readonly string[],
): Map<string, AutoHide> {
  const out = new Map<string, AutoHide>();
  if (!rulesEnforceAnything(cfg.postRules)) return out;
  const restored = restoredIds(store, moderatorPubkeySet(npubs));

  for (const ev of store.query({kinds: [Kind.Post, Kind.Article]})) {
    if (ev.created_at < cfg.postRulesAt) continue; // no retroactive hiding
    if (restored.has(ev.id)) continue;
    if (ev.kind === Kind.Post && isStiqComment(ev)) continue; // comments aren't feed posts
    // A sealed post's ciphertext must never be measured as if it were prose — its true length is
    // unknown until this device unlocks its content epoch, so it is exempted from THIS pass rather
    // than judged on ciphertext bytes (a false "too-long"/"label-required" verdict). Not a stuck
    // state: autoHiddenPosts is re-derived on every mod-log build, so the verdict lands the moment
    // the key does.
    const body = resolveContent(ev);
    if (body.locked) continue;
    const postKind = ev.kind === Kind.Article ? 'article' : 'note';
    // Measure PROSE only — strip inline picture/voice tokens so a base64 blob's thousands of chars
    // don't count against the note limit (matches the composer's bodyForMeasure gate). Otherwise a
    // perfectly normal picture post trips "too-long" and is auto-hidden to the log.
    const violations = evaluatePost(
      {kind: postKind, body: bodyForMeasure(body.text), label: labelOf(ev)},
      cfg.postRules,
    );
    // Min-length is a compose-time guardrail only; over-max + missing-required-label auto-hide.
    if (violations.includes('label-required')) out.set(ev.id, {code: 'label-required'});
    else if (violations.includes('too-long')) out.set(ev.id, {code: 'too-long'});
  }
  return out;
}

/** Human-readable mod-log reason for an automatic hide. */
export function autoHideReason(code: AutoHide['code']): string {
  return code === 'label-required'
    ? 'Auto-removed: missing a required label'
    : 'Auto-removed: over the length limit';
}
