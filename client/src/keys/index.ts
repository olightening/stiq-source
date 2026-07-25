/**
 * Secure key storage / identity public API (PLAN.md Step 7).
 */
export {
  KeyStore,
  InMemorySecureStorage,
  type SecureKeyStore,
  type SecureStorage,
  type UnsignedEvent,
} from './keystore';
export {Identity, type IdentityInfo} from './identity';
export {createSecureStorage, getNativeKeystore} from './nativeKeystore';
