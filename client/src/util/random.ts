/**
 * Cryptographic random bytes. Uses WebCrypto, available in Node and in RN once
 * `react-native-get-random-values` is imported at app entry (the same polyfill nostr-tools
 * relies on for key generation).
 */
interface WebCryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

export function randomBytes(n: number): Uint8Array {
  const webcrypto = (globalThis as unknown as {crypto: WebCryptoLike}).crypto;
  const bytes = new Uint8Array(n);
  webcrypto.getRandomValues(bytes);
  return bytes;
}

/**
 * A uniform float in [0, 1) drawn from the SAME CSPRNG as {@link randomBytes} — the drop-in
 * replacement for `Math.random()` wherever a draw must not be predictable or weakly seeded.
 *
 * Hermes seeds `Math.random` from a cheap, non-cryptographic source, which is fine for jitter but
 * not for anything a user is asked to treat as "random". Identity generation (the onboarding
 * gradient grid + handle suggestions — see media/gradient `randomGradient` and
 * profile/handleWords `randomHandle`) draws through here so two members on two phones are not
 * quietly steered onto the same identity by a shared, low-entropy seed.
 *
 * 48 bits (6 bytes) of entropy: far more than any caller's candidate space needs, exactly
 * representable in a double (2^48 < 2^53), and — since the largest value is 2^48-1 — strictly
 * less than 1, so `Math.floor(rand() * n)` can never land on the out-of-range index `n`.
 */
export function randomFloat(): number {
  const bytes = randomBytes(6);
  let x = 0;
  for (const byte of bytes) x = x * 256 + byte;
  return x / 2 ** 48;
}
