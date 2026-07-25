/**
 * Pending binding-event store (timing-correlation defence, PLAN.md §3.3).
 *
 * After enrollment the binding event is NOT immediately sent to the relay.
 * It is stored here and published only when the user explicitly taps
 * "Connect to community." The user decides when — their unpredictable human
 * timing breaks any correlation the organizer could draw between the moment
 * they blind-signed and the moment a new npub appeared on the relay.
 *
 * Combined with the 6-hour timestamp quantization in enrollment.ts:
 *   - The organizer signs a blinded token at time T.
 *   - The binding event carries a timestamp rounded to the nearest 6h block ± one block.
 *   - The event reaches the relay whenever the user chooses to connect.
 *
 * The pending event is wiped by the duress wipe (duress.ts) along with everything else.
 */
import type {Event} from 'nostr-tools/pure';
import type {SecureStorage} from '../keys/keystore';

const PENDING_EVENT_KEY = 'stiq.pending.bindEvent';

export async function storePendingBind(
  storage: SecureStorage,
  bindingEvent: Event,
): Promise<void> {
  await storage.setItem(PENDING_EVENT_KEY, JSON.stringify(bindingEvent));
}

export async function loadPendingBind(
  storage: SecureStorage,
): Promise<Event | null> {
  const eventJson = await storage.getItem(PENDING_EVENT_KEY);
  if (!eventJson) {
    return null;
  }
  try {
    return JSON.parse(eventJson) as Event;
  } catch {
    return null;
  }
}

export async function hasPendingBind(storage: SecureStorage): Promise<boolean> {
  return (await storage.getItem(PENDING_EVENT_KEY)) !== null;
}

export async function clearPendingBind(storage: SecureStorage): Promise<void> {
  await storage.removeItem(PENDING_EVENT_KEY);
}
