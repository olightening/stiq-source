/**
 * LockController routes a PIN entry (PLAN.md §3.5 / Step 11).
 *
 * - standard PIN → unlock normally.
 * - duress PIN  → run the wipe, THEN unlock to a now-blank app. To an observer this looks
 *   exactly like a normal unlock (the app simply opens); because the wipe already ran, what
 *   opens is an unconfigured, fresh-install state.
 * - invalid     → stay locked.
 *
 * The 'wiped' vs 'unlocked' outcome is for internal/test use only — the UI MUST render both
 * identically (open the app), never signalling that a wipe occurred.
 */
import type {AutoLock} from './autolock';
import type {PinVault} from './pin';

export type UnlockOutcome = 'unlocked' | 'wiped' | 'rejected';

export class LockController {
  constructor(
    private readonly pins: PinVault,
    private readonly autolock: AutoLock,
    private readonly onDuress: () => Promise<void>,
  ) {}

  async submitPin(pin: string): Promise<UnlockOutcome> {
    const result = await this.pins.verify(pin);
    if (result === 'standard') {
      this.autolock.unlock();
      return 'unlocked';
    }
    if (result === 'duress') {
      await this.onDuress();
      this.autolock.unlock(); // open the (now blank) app — indistinguishable from normal
      return 'wiped';
    }
    return 'rejected';
  }
}
