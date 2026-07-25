/**
 * Deterministic client-side auto-moderation for SPACES (NIP-53 channels + NIP-29 groups) — the
 * space analogue of feed autoModeration.ts. A space's admins set content rules (spaceRules.ts);
 * every device independently re-evaluates each message against those rules and reaches the SAME
 * verdict, so a rule-breaking message is auto-removed everywhere with no event written. A space
 * admin can override a false positive with a normal restore (the only event ever written).
 *
 * The ONE difference from the feed evaluator: the restore-override authority is the SPACE's admin
 * set (owner + channel/group admins), not the community moderator roster — "space admins have mod
 * power inside their own space".
 *
 * Retroactivity contract: a message is judged only against rules already in force when it was
 * created (`created_at >= rulesAt`), so tightening a rule never retro-hides older, then-legal
 * messages. Encrypted (private-group) message bodies are ciphertext at this layer and cannot be
 * measured; content-length/link rules for them are enforced at the composer only (kind restrictions
 * still apply). Min-length is likewise a compose-time guardrail, never a post-hoc hide.
 */
import type {Event} from 'nostr-tools/pure';
import type {EventStore} from '../nostr/store';
import {restoredIds} from './autoModeration';
import {bodyForMeasure} from '../feed/inlineMedia';
import type {SpaceRuleSet} from '../channels/spaceRules';

export interface SpaceAutoModConfig {
  rules: SpaceRuleSet;
  /** created_at of the space's settings doc; messages older than this are exempt (no retro-hide). */
  rulesAt: number;
  /** Hex pubkeys who may restore in THIS space — owner + admins. */
  spaceAdmins: ReadonlySet<string>;
}

export interface SpaceAutoHide {
  code: 'too-long' | 'link-blocked' | 'kind-blocked';
}

/** Matches an http(s) URL or a bare `www.` host — good enough for a links-not-allowed rule. */
const URL_RE = /(https?:\/\/|www\.)\S+/i;

/** True when the message body was NIP-44-sealed (ciphertext) — content rules can't be measured. */
function isEncrypted(ev: Event): boolean {
  return ev.tags.some(t => t[0] === 'encrypted' && t[1] === 'nip44');
}

/** True when the rules actually constrain a message (else auto-mod is a no-op). */
function rulesEnforceAnything(r: SpaceRuleSet): boolean {
  return r.message.max > 0 || !r.allowLinks || (r.allowedKinds?.length ?? 0) > 0;
}

/**
 * The set of a space's messages (id → why) auto-hidden by the space's rules right now. `messages`
 * is the space's message list already resolved by the caller (folded edits, correct kinds) — for a
 * channel these are the kind-1311 broadcasts, for a group the kind-9 chat messages. Pure over the
 * inputs, so every device agrees.
 */
export function spaceAutoHidden(
  store: EventStore,
  messages: readonly Event[],
  cfg: SpaceAutoModConfig,
): Map<string, SpaceAutoHide> {
  const out = new Map<string, SpaceAutoHide>();
  if (!rulesEnforceAnything(cfg.rules)) return out;
  const restored = restoredIds(store, cfg.spaceAdmins);
  const kinds = cfg.rules.allowedKinds;
  for (const ev of messages) {
    if (ev.created_at < cfg.rulesAt) continue; // no retroactive hiding
    if (restored.has(ev.id)) continue;
    if (kinds && kinds.length > 0 && !kinds.includes(ev.kind)) {
      out.set(ev.id, {code: 'kind-blocked'});
      continue;
    }
    if (isEncrypted(ev)) continue; // ciphertext — content rules are composer-enforced for private spaces
    // Measure/scan PROSE only — strip inline picture/voice tokens so a base64 blob doesn't trip the
    // length limit (a normal picture message would otherwise be auto-removed to the log).
    const body = bodyForMeasure(ev.content);
    if (cfg.rules.message.max > 0 && body.length > cfg.rules.message.max) {
      out.set(ev.id, {code: 'too-long'});
      continue;
    }
    if (!cfg.rules.allowLinks && URL_RE.test(body)) {
      out.set(ev.id, {code: 'link-blocked'});
      continue;
    }
  }
  return out;
}

/** Human-readable mod-log reason for a space auto-hide. */
export function spaceAutoHideReason(code: SpaceAutoHide['code']): string {
  switch (code) {
    case 'too-long':
      return 'Auto-removed: over the length limit';
    case 'link-blocked':
      return 'Auto-removed: links are not allowed here';
    case 'kind-blocked':
      return 'Auto-removed: this post type is not allowed here';
  }
}
