/**
 * memberRoll — the in-memory bound-npub roll for the active community.
 *
 * The organizer publishes the relay's authoritative bound-npub set as an encrypted
 * kind-30078 doc (d="stiq:member-roll", moderation/organizerConfig.ts currentMemberRoll).
 * The feed/moderation hot path needs a SYNCHRONOUS membership check per event (identity.ts
 * isOffRollBlindPost), so — exactly like ./communityKey — AppRuntime loads/derives the Set per
 * active community and this pure module holds it for synchronous readers. null until loaded (or
 * for a community whose organizer publishes no roll) → every check DEFERS, byte-identical to
 * pre-roll behavior; enforcement exists only while a decrypted roll is actually present.
 *
 * The Set handed in is expected to ALREADY include the organizer pubkey(s) and the member's own
 * pubkey (unioned by AppRuntime.applyMemberRoll): the organizer never publishes a kind-9011
 * binding (relay-side privileged, absent from membership.json), and a member's own fresh binding
 * may not have reached the organizer's roll yet — neither must ever be hidden.
 *
 * The version counter feeds derived-result caches (e.g. the RSVP tally cache): any cache keyed on
 * roll-dependent output must include getMemberRollVersion() in its key so a roll update
 * invalidates it. PURE module (no persistence, no React).
 */

let _roll: ReadonlySet<string> | null = null;
let _version = 0;

/** Publish the active community's roll for synchronous readers. Pass null to clear (community
 * switch / duress / roll withdrawn) — clearing also bumps the version. */
export function setActiveMemberRoll(roll: ReadonlySet<string> | null): void {
  _roll = roll;
  _version++;
}

/** The active roll, or null when none is loaded (⇒ defer all enforcement). */
export function getActiveMemberRoll(): ReadonlySet<string> | null {
  return _roll;
}

/** Monotonic counter bumped on every setActiveMemberRoll — a cache-key ingredient. */
export function getMemberRollVersion(): number {
  return _version;
}
