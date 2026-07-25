/**
 * Relative-time formatting for dense lists — the ONE implementation for every surface.
 *
 * Historically this "now/5m/3h/2d" formatter was copy-pasted (with subtly divergent output) across
 * seven files. It is now unified here behind a `style` parameter so every call site keeps its EXACT
 * prior visible output — do not "simplify" the styles away, each maps to a real on-screen surface.
 *
 * `nowMs` is injectable for deterministic tests; it defaults to the wall clock.
 *
 * ── Style → surface map (what each one renders, and who used it) ──────────────────────────────────
 *   'short'        "now" / "5m" / "3h" / "2d" / "4mo"   — feed cards (rolls over to months).
 *                                                          Callers: MainScreen feed rows (relTimeShort).
 *   'short-days'   "now" / "5m" / "3h" / "2d" (…/"45d")  — same, but CAPS at days (no month unit).
 *                                                          Callers: channels primitives (format.relTimeShort),
 *                                                          CommentItem, MainScreen channel-list rows.
 *   'ago'          "just now" / "5m ago" / "3h ago" / "2d ago" — verbose, day-capped.
 *                                                          Callers: channels primitives (format.relativeTime),
 *                                                          ChannelPostView.
 *   'log'          "now" / "5m" / "3h" / "2d"            — like 'short-days' but rounds minutes and
 *                                                          clamps negative ages to 0 (moderation log
 *                                                          boundaries differ: 30s → "now", 40s → "1m").
 *                                                          Callers: LogScreen, ModeratorConsole.
 *
 * The floor-based styles ('short'/'short-days'/'ago') and the round-based style ('log') genuinely
 * disagree at sub-minute boundaries — that difference is intentional and preserved.
 */

export type RelTimeStyle = 'short' | 'short-days' | 'ago' | 'log';

/** Compact age: "now", "5m", "3h", "2d", "4mo" (months only in the 'short' style). */
export function relTimeShort(ts: number, nowMs: number = Date.now()): string {
  return relTime(ts, 'short', nowMs);
}

/** Verbose age with suffix: "just now", "5m ago", "3h ago", "2d ago" (day-capped). */
export function relTimeAgo(ts: number, nowMs: number = Date.now()): string {
  return relTime(ts, 'ago', nowMs);
}

/**
 * Unified relative-time formatter. Every surface routes here; `style` selects the exact output
 * that surface has always rendered (see the style→surface map above).
 */
export function relTime(ts: number, style: RelTimeStyle, nowMs: number = Date.now()): string {
  if (style === 'log') {
    // Moderation-log form: round minutes, clamp negative ages to 0.
    const mins = Math.max(0, Math.round((nowMs / 1000 - ts) / 60));
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }

  const diff = Math.floor(nowMs / 1000) - ts;
  if (style === 'ago') {
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // 'short' and 'short-days'
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (style === 'short' && diff >= 2592000) return `${Math.floor(diff / 2592000)}mo`;
  return `${Math.floor(diff / 86400)}d`;
}
