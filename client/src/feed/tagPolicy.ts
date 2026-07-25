/**
 * Community tag policy — the organizer's control surface over what tags members can use.
 *
 * Delivered two ways:
 *  1. Embedded in the join code (`tp` field) so new members get it at enrollment.
 *  2. Live update via kind-30078 published by the organizer to the relay; the client
 *     subscribes and updates whenever the organizer changes the policy.
 *
 * Enforced two ways:
 *  1. Client-side: the composer hides the free-text tag input when `allowMemberTags` is
 *     false; community tags are shown first when `pinCommunityTags` is true.
 *  2. Relay-side: `allowed_tags` + `allow_member_tags` config fields in relay config
 *     (hard enforcement — events with out-of-policy tags are rejected at the relay).
 */

import {coercePostScope, type PostScope} from './postRules';

export const KIND_TAG_POLICY = 30078;
export const TAG_POLICY_D_TAG = 'stiq:tag-policy';

export interface TagPolicy {
  /** Organizer-vetted tags. Always surfaced in the composer tag picker. */
  communityTags: string[];
  /** Show community tags before free tags in the picker and feed chips. */
  pinCommunityTags: boolean;
  /** Members may type their own free-text tags in addition to community tags. */
  allowMemberTags: boolean;
  /** Max `t` tags allowed on a single post. 0 = unlimited. Enforced client + relay side. */
  maxTags: number;
  /** Per-community-tag post-type scope (composer-enforced). A tag absent from the map ⇒ 'all'. */
  tagScopes: Record<string, PostScope>;
}

export const DEFAULT_TAG_POLICY: TagPolicy = {
  communityTags: [],
  pinCommunityTags: true,
  allowMemberTags: true,
  maxTags: 0,
  tagScopes: {},
};

/**
 * Fill any missing fields of a (possibly old-shape / partial) TagPolicy from the defaults.
 *
 * A policy persisted by an older app version — or embedded in an older join code — can lack a
 * field that was added later (notably `tagScopes`, added with per-post-type tag scoping). Reading
 * such a record back and using `p.tagScopes[tag]` throws "Cannot convert undefined value to
 * object". Normalizing at every boundary where a policy enters from storage/the wire guarantees a
 * well-formed object regardless of when it was written. Unknown/malformed input ⇒ the defaults.
 */
export function normalizeTagPolicy(p: TagPolicy | null | undefined): TagPolicy {
  if (!p || typeof p !== 'object') return DEFAULT_TAG_POLICY;
  return {
    communityTags: Array.isArray(p.communityTags)
      ? p.communityTags.filter((t): t is string => typeof t === 'string')
      : [],
    pinCommunityTags: p.pinCommunityTags !== false,
    allowMemberTags: p.allowMemberTags !== false,
    maxTags:
      typeof p.maxTags === 'number' && p.maxTags > 0 && Number.isFinite(p.maxTags)
        ? Math.floor(p.maxTags)
        : 0,
    tagScopes: p.tagScopes && typeof p.tagScopes === 'object' ? p.tagScopes : {},
  };
}

/** Compact on-wire shape (join code `tp` field + kind-30078 content). */
interface TagPolicyWire {
  ct?: string[];
  pin?: boolean;
  mem?: boolean;
  max?: number;
  /** Per-tag scope. Only non-'all' entries are carried (absent ⇒ 'all'). */
  tsc?: Record<string, string>;
}

export function encodeTagPolicy(p: TagPolicy): TagPolicyWire {
  const tsc: Record<string, string> = {};
  // `?? {}` tolerates an old-shape policy that predates tagScopes (mirror of normalizeTagPolicy).
  for (const [tag, scope] of Object.entries(p.tagScopes ?? {})) {
    if (scope !== 'all') tsc[tag] = scope;
  }
  return {
    ct: p.communityTags,
    pin: p.pinCommunityTags,
    mem: p.allowMemberTags,
    max: p.maxTags,
    ...(Object.keys(tsc).length ? {tsc} : {}),
  };
}

export function parseTagPolicy(raw: unknown): TagPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as TagPolicyWire;
  const tagScopes: Record<string, PostScope> = {};
  if (w.tsc && typeof w.tsc === 'object') {
    for (const [tag, scope] of Object.entries(w.tsc)) {
      const s = coercePostScope(scope);
      if (s !== 'all') tagScopes[tag] = s;
    }
  }
  return {
    communityTags: Array.isArray(w.ct)
      ? w.ct.filter((t): t is string => typeof t === 'string')
      : [],
    pinCommunityTags: w.pin !== false,
    allowMemberTags: w.mem !== false,
    maxTags: typeof w.max === 'number' && w.max > 0 && Number.isFinite(w.max) ? Math.floor(w.max) : 0,
    tagScopes,
  };
}

/** Parse a kind-30078 event's content into a TagPolicy (null if malformed). */
export function parseTagPolicyEvent(content: string): TagPolicy | null {
  try {
    return parseTagPolicy(JSON.parse(content));
  } catch {
    return null;
  }
}
