/**
 * Moderator-roster publish state — the pure half, extracted so it is testable for real rather than
 * mirrored in a test file (the fate of most organizer-server.mjs logic, which can't be imported
 * without booting the whole dashboard).
 *
 * The distinction this module exists to make: `moderators.json` on the organizer's disk is NOT the
 * roster anyone enforces. The relay's authority checks and every client's hide/ban fold read the
 * last kind-30078 `stiq:moderators` event PUBLISHED to the relay. While those two disagree, a
 * moderator removed from the file keeps full power — accepted mod actions, honoured hides, the lot.
 *
 * Before 2026-07-29 they disagreed by default: `DELETE /api/moderators/:npub` rewrote the file and
 * stopped, and publishing was a separate button an operator had to know to press, with no reminder
 * and no indicator anywhere. Every other config tab saves+signs+publishes in one round trip. The
 * 2026-07-29 audit ranked the resulting silent-failed-revocation the highest-likelihood real-world
 * moderation-integrity incident, so add/remove now publish automatically — and when a publish
 * fails, `rosterUnpublished` is what lets the dashboard say so instead of looking healthy.
 */

/**
 * Whether the on-disk roster differs from the one last successfully published.
 *
 * @param {string[] | null} published the roster last published OK, or null if none this process
 * @param {string[]} current the roster on disk right now
 * @returns {boolean | null} true = a change is stranded (a removal may be un-enforced);
 *   false = the relay has been told; null = unknown (nothing published yet this process lifetime,
 *   so we cannot claim either way — the relay may well hold a correct roster from a previous run).
 */
export function rosterUnpublished(published, current) {
  if (published === null || published === undefined) return null;
  const a = [...published].sort();
  const b = [...current].sort();
  if (a.length !== b.length) return true;
  return a.some((v, i) => v !== b[i]);
}
