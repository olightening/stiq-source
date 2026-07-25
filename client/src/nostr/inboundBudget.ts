/**
 * inboundBudget — shared per-window JS-thread time budget for RelayClient's inbound drain loop
 * (I3).
 *
 * Cold sync can run up to MAX_MIRRORS + 1 independent RelayClient instances live at once (one
 * primary plus up to MAX_MIRRORS reconcile-only secondaries, see MirrorSet), each draining its own
 * `inboundQueue` on the SAME JS thread. Before this module existed, every drain tick capped itself
 * against its OWN fixed per-client time slice — so N simultaneously-live clients could each spend
 * that slice inside the same wall-clock window, and aggregate draining scaled with N instead of
 * being bounded, starving touch/render work exactly during the burst (cold sync) when it matters
 * most.
 *
 * `InboundBudget` tracks ONE sliding window across every caller: `remaining(now)` rolls the window
 * over (fresh full budget) once `now` has moved past it, and `charge(ms)` records drain work
 * against whichever window is currently open. `sharedInboundBudget` is the ONE instance every
 * RelayClient drain loop consults — deliberately a plain stateless-from-the-caller's-view bucket
 * with no per-client registration, so a client connecting or disconnecting mid-sync never has
 * anything here to register, leak, or clean up.
 *
 * Exported as a class (rather than bare module-level state) so tests can construct an isolated
 * instance instead of reaching for a global reset hook.
 */

/** Wall-clock width of one accounting window. */
export const WINDOW_MS = 16;
/** Total drain work, across every live RelayClient, allowed per window. */
export const BUDGET_MS = 10;

export class InboundBudget {
  constructor(
    private readonly windowMs: number = WINDOW_MS,
    private readonly budgetMs: number = BUDGET_MS,
  ) {}

  private windowStart = 0;
  private spent = 0;

  /**
   * Remaining shared budget (ms) for the window containing `now`. Rolls over to a fresh, fully
   * refilled window first if `now` has moved past the current one — so a caller only ever needs to
   * call this (never a separate "tick" method) to stay in sync with wall-clock time.
   */
  remaining(now: number): number {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.spent = 0;
    }
    return Math.max(0, this.budgetMs - this.spent);
  }

  /** Record `ms` of drain work against whichever window is currently open. */
  charge(ms: number): void {
    if (ms > 0) {
      this.spent += ms;
    }
  }
}

/** The ONE instance every RelayClient drain loop shares — see the module doc above. */
export const sharedInboundBudget = new InboundBudget();
