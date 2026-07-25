# src/keys — hardware-backed key storage (PLAN.md §3.3 / Step 7)

The secret key (`nsec`) is held by a `SecureKeyStore` and **never leaves it**: callers can
sign and read the public key, but there is no method to retrieve the private key.

## The secp256k1 reality (important)

iOS Secure Enclave and Android Keystore can hold keys and perform signatures — but only for
hardware curves (P-256/ECDSA, RSA). **Nostr signs with secp256k1 schnorr (BIP-340), which
no mobile secure element implements.** So we cannot sign "inside" the enclave.

What we do instead — the standard approach for Nostr mobile keys:

1. The `nsec` is stored **hardware-wrapped at rest**: encrypted by a non-exportable
   Keystore/Secure-Enclave key, behind a biometric gate (`SecureStorage`, native).
2. To sign, the key is decrypted into memory for the single `finalizeEvent` call, then the
   in-memory copy is **scrubbed immediately** (`sk.fill(0)` in `KeyStore.sign`'s `finally`).
3. There is no export path on the interface.

This is "non-exportable" in the practical sense: the raw key is never persisted in plaintext
(never in SQLite, never in logs), only ever hardware-encrypted at rest or transiently in RAM
during a signature.

## Pieces

| File | Role |
|---|---|
| `keystore.ts` | `SecureKeyStore` interface + `KeyStore` (over `SecureStorage`); `InMemorySecureStorage` (test/dev only). |
| `identity.ts` | `Identity` — wraps `KeyStore`, also remembers the bound relay; `reset()` is the duress/logout hook. |
| `nativeKeystore.ts` | `createSecureStorage()` — returns the native hardware store or **throws** (fail closed). |

`useSecretKey(fn)` gives transient in-memory access to the key for NIP-44/NIP-17 DM
encryption/decryption (`Identity.sealDM` / `Identity.readInbox`), scrubbing it afterwards —
the same transient-use model as `sign()`. There is still no *persistent* export.

## Onboarding handoff (Steps 6 → 7)

After `SessionManager.acceptInvite` (Step 6) yields an in-memory `Session`:

```ts
const identity = new Identity(createSecureStorage());
await identity.enroll(session.secretKey, session.relayUrl); // -> hardware-wrapped
sessions.clear();                                           // scrub the in-memory key
```

Thereafter the app signs via `identity.sign(...)` and never touches the raw key again.

## Native seam (complete during the native build)

Implement the `StiqKeystore` native module satisfying `SecureStorage`:

- **iOS** — Keychain item with a Secure-Enclave-protected access control,
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (device-only, no iCloud), biometric gate.
- **Android** — value encrypted with an Android Keystore key (StrongBox when available),
  `setUserAuthenticationRequired(true)` for the biometric gate.

All signing/dedupe/validation logic is exercised by `keystore.test.ts` / `identity.test.ts`
against the in-memory store; only the hardware encryption is native.
