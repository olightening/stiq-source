/**
 * Native transport-string parity guard (T14-S2) — compile-time + runtime.
 *
 * The transport strings are a cross-language contract: the TypeScript `TransportType` union and the
 * raw strings the Rust FFI switches on (arti-ffi/src/pt.rs's `KNOWN_TRANSPORTS` const and
 * `binary_for()`'s match arms) must not drift apart. There is no shared source of truth across the
 * JS↔Rust boundary, so this test pins both ends by hand.
 *
 * The relationship is a SUBSET, not an equality, and the asymmetry is deliberate:
 *
 *   TransportType  ⊂  KNOWN_TRANSPORTS
 *   (what JS can send)  (what Rust accepts)
 *
 * The direction that can actually break a user is JS sending a string Rust rejects — `configure()`
 * fails the connect outright on an unknown transport. That direction is pinned at COMPILE TIME
 * below. The other direction (Rust knowing a name JS never sends) is inert: it costs nothing at
 * runtime, and is pinned at runtime below purely so the gap stays visible and intentional instead
 * of rotting into "someone forgot".
 *
 * Today exactly one string sits in that gap: `meek_lite`. pt.rs accepts it and libLyrebird.so
 * already serves it (lyrebird registers meek_lite through the same transports.Init() as obfs4, so
 * it costs no extra binary), but no TypeScript surface can produce the string — see the subset note
 * on `TransportType` in ./types for why, and for what admitting it would cost (every
 * `Record<TransportType, …>` in the app gains an arm, including `TRANSPORT_LABEL` in
 * app/screens/ConnectionSheet.tsx, outside the tor module). It is not in BRIDGE_LADDER and has no
 * default bridge list either; there is no public meek_lite bridge source to ship.
 *
 * TWO native ends now pin against this file: the C-tor engine is back as the `ctor` product
 * flavor (StiqTorModule.kt), so the same four TransportType strings are ALSO the arms of its
 * Kotlin when()/ClientTransportPlugin switch — pinned as an EQUALITY in the second describe
 * below (C-tor/IPtProxy has no meek_lite arm, so there is no subset gap on that side).
 */
import type {TransportType} from './types';

// The exact transport strings the native layer (arti-ffi/src/pt.rs KNOWN_TRANSPORTS) accepts.
// 'direct' means no pluggable transport is configured at all.
const NATIVE_TRANSPORT_STRINGS = [
  'direct',
  'webtunnel',
  'obfs4',
  'snowflake',
  'meek_lite',
] as const;

type NativeTransportString = (typeof NATIVE_TRANSPORT_STRINGS)[number];

// Every TransportType member, as a Record so tsc fails here if the union grows a member and this
// file is not updated — a plain array would compile fine while silently under-listing.
const ALL_TRANSPORT_TYPES: Record<TransportType, true> = {
  direct: true,
  webtunnel: true,
  obfs4: true,
  snowflake: true,
};

// THE load-bearing assertion, and it is a compile-time one: every string JS can put in
// TorStartConfig.transport must be one pt.rs accepts. Rename or add a TransportType member without
// updating NATIVE_TRANSPORT_STRINGS (and pt.rs) and this line fails tsc.
const _check: readonly NativeTransportString[] = Object.keys(
  ALL_TRANSPORT_TYPES,
) as TransportType[];

describe('transport string contract (JS TransportType ↔ Rust arti-ffi/src/pt.rs)', () => {
  it('every TransportType is a string the native layer accepts (compile-time guard is wired)', () => {
    // Referencing _check keeps the compile-time assertion "used"; the runtime check confirms the
    // Record really did enumerate the union rather than silently producing a short list.
    expect([..._check].sort()).toEqual(['direct', 'obfs4', 'snowflake', 'webtunnel']);
    for (const t of _check) {
      expect(NATIVE_TRANSPORT_STRINGS).toContain(t);
    }
  });

  it("the non-'direct' TransportType members are the three PT names JS can request", () => {
    const pluggable = (Object.keys(ALL_TRANSPORT_TYPES) as TransportType[]).filter(
      t => t !== 'direct',
    );
    expect([...pluggable].sort()).toEqual(['obfs4', 'snowflake', 'webtunnel']);
  });

  it('records meek_lite as native-only: pt.rs accepts it, TransportType deliberately does not', () => {
    // Not an oversight — see this file's header and ./types. If meek_lite is ever exposed to JS,
    // this test must be deleted in the same change that adds it to TransportType, which forces
    // whoever does it to read why it was withheld.
    expect(NATIVE_TRANSPORT_STRINGS).toContain('meek_lite');
    expect(Object.keys(ALL_TRANSPORT_TYPES)).not.toContain('meek_lite');
  });

  it("includes 'direct' (no pluggable transport configured)", () => {
    expect(NATIVE_TRANSPORT_STRINGS).toContain('direct');
    expect(ALL_TRANSPORT_TYPES.direct).toBe(true);
  });
});

/**
 * The ctor flavor's side of the same contract (T14-S2 restored): the strings the Kotlin
 * StiqTorModule.kt switches on (startPt()'s `when (transport)` and buildTorrc()'s
 * `ClientTransportPlugin $transport ...`) — an EQUALITY with TransportType, unlike the Rust
 * subset above: IPtProxy serves exactly obfs4/snowflake/webtunnel, and 'direct' is the
 * buildTorrc else-branch.
 */
const KOTLIN_TRANSPORT_STRINGS = ['direct', 'webtunnel', 'obfs4', 'snowflake'] as const;
// Compile-time both ways: every Kotlin arm is a TransportType, and (via the Record above) every
// TransportType is a Kotlin arm.
const _kotlinCheck: readonly TransportType[] = KOTLIN_TRANSPORT_STRINGS;

describe('transport string contract (JS TransportType ↔ Kotlin StiqTorModule, ctor flavor)', () => {
  it('the Kotlin arm list and TransportType are the same set (compile-time guard is wired)', () => {
    expect([..._kotlinCheck].sort()).toEqual(
      [...(Object.keys(ALL_TRANSPORT_TYPES) as TransportType[])].sort(),
    );
  });

  it("the non-'direct' members are exactly the three PT strings the Kotlin when() switches on", () => {
    const pluggable = KOTLIN_TRANSPORT_STRINGS.filter(t => t !== 'direct');
    expect([...pluggable].sort()).toEqual(['obfs4', 'snowflake', 'webtunnel']);
  });
});
