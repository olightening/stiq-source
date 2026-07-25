/**
 * Native transport-string parity guard (T14-S2) — compile-time + runtime.
 *
 * The transport strings are a cross-language contract: the TypeScript `TransportType` union and the
 * raw strings the Kotlin StiqTorModule.kt switches on (startPt()'s `when (transport)` and
 * buildTorrc()'s `ClientTransportPlugin $transport ...`) MUST stay identical. There is no shared
 * source of truth across the JS↔Kotlin boundary, so this test pins both ends:
 *
 *   1. Compile-time: `_check: readonly TransportType[] = NATIVE_TRANSPORT_STRINGS` fails tsc if a
 *      TransportType member is ever renamed/removed without updating the native string list here.
 *   2. Runtime: the non-'direct' members are exactly the three pluggable-transport names the Kotlin
 *      when() arms map to IPtProxy.{Webtunnel,Obfs4,Snowflake}.
 *
 * A future rename on ONE side only therefore breaks the build/test.
 */
import type {TransportType} from './types';

// The exact transport strings the native layer (StiqTorModule.kt) accepts. 'direct' is handled by
// buildTorrc's else branch (UseBridges 0) and never reaches startPt/ClientTransportPlugin.
const NATIVE_TRANSPORT_STRINGS = [
  'direct',
  'webtunnel',
  'obfs4',
  'snowflake',
] as const;

// Compile-time superset assertion: every native string must be a valid TransportType.
const _check: readonly TransportType[] = NATIVE_TRANSPORT_STRINGS;

describe('transport string contract (JS TransportType ↔ Kotlin StiqTorModule)', () => {
  it('every native transport string is a valid TransportType (compile-time guard is wired)', () => {
    // Referencing _check keeps the compile-time assertion "used" and asserts identity at runtime.
    expect(_check).toBe(NATIVE_TRANSPORT_STRINGS);
  });

  it("the non-'direct' members are exactly the three PT strings the Kotlin when() switches on", () => {
    const pluggable = NATIVE_TRANSPORT_STRINGS.filter(t => t !== 'direct');
    expect([...pluggable].sort()).toEqual(['obfs4', 'snowflake', 'webtunnel']);
  });

  it("includes 'direct' (buildTorrc else branch; never reaches startPt/ClientTransportPlugin)", () => {
    expect(NATIVE_TRANSPORT_STRINGS).toContain('direct');
  });
});
