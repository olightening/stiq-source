/**
 * Sticky per-community enforcement flags — the persistence half of the 2026-07-28 caps-fallback
 * fix (OPEN_ITEMS §2.1c). Holds the last EXPLICITLY-advertised `enforced` block per community so
 * that a cold start, a community switch, or a reconnect whose NIP-11 fetch fails/regresses can
 * never silently downgrade the client below what the community's relay is known to enforce —
 * the split-brain that produced token-less space writes (rejected as "out of tokens") whenever
 * the relay WS was up but the capability fetch's own Tor circuit was not.
 *
 * Contract (enforced by AppRuntime, this module only persists):
 *   • a flag only ever CHANGES from an explicit advertisement (explicitEnforcedFlags);
 *   • absence — fetch failure, missing stiq block, missing field — keeps the stored value;
 *   • the store is per COMMUNITY (cid), because enforcement is the relay's property, not an
 *     account's; the cid-less fallback key only serves pre-community/legacy paths.
 *
 * Values are plain booleans/numbers (no secret), so AsyncStorage — not the keystore — is correct,
 * mirroring channels/membership.ts's loadDeliveredSpaceKeys pattern. Loads validate every field
 * defensively: a corrupted blob degrades to {} (the constant fallback stands), never a throw.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {EnforcedFlags} from '../nostr/capabilities';
import {stickyEnforcementKey} from './workspaceKeys';

export async function loadStickyEnforcement(cid?: string): Promise<Partial<EnforcedFlags>> {
  try {
    const raw = await AsyncStorage.getItem(stickyEnforcementKey(cid));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const p = parsed as Record<string, unknown>;
    const out: Partial<EnforcedFlags> = {};
    if (typeof p.blindRequired === 'boolean') out.blindRequired = p.blindRequired;
    if (typeof p.privateGroupReadAuth === 'boolean') out.privateGroupReadAuth = p.privateGroupReadAuth;
    if (typeof p.bytesPerToken === 'number' && Number.isFinite(p.bytesPerToken)) {
      out.bytesPerToken = p.bytesPerToken;
    }
    if (typeof p.contentEncryption === 'boolean') out.contentEncryption = p.contentEncryption;
    if (typeof p.readAuthRequired === 'boolean') out.readAuthRequired = p.readAuthRequired;
    if (typeof p.spaceTokensRequired === 'boolean') out.spaceTokensRequired = p.spaceTokensRequired;
    return out;
  } catch {
    return {};
  }
}

export async function saveStickyEnforcement(
  flags: Partial<EnforcedFlags>,
  cid?: string,
): Promise<void> {
  try {
    await AsyncStorage.setItem(stickyEnforcementKey(cid), JSON.stringify(flags));
  } catch {
    // best effort — worst case the next explicit advertisement re-persists
  }
}
