/**
 * User-configurable media settings (currently the Blossom upload server).
 *
 * `MEDIA_BLOSSOM_ENDPOINT` in config.ts is only the build-time DEFAULT. A user can point Stiq at
 * their own Blossom host from Settings; that choice is persisted (SecureStorage) and overrides the
 * default. The live value is mirrored into a module-level accessor so `mediaService` can read it
 * synchronously without threading it through every layer — same pattern as the media-service
 * singleton.
 *
 * The relay still stores no media: uploads go to whatever Blossom host is set here, referenced
 * from posts via NIP-94 `imeta` (sha256-pinned). An `.onion` host keeps uploads inside Tor.
 */
import type {SecureStorage} from '../keys/keystore';
import {MEDIA_BLOSSOM_ENDPOINT} from '../config';
import {classifyUrl} from '../util/url';

const ENDPOINT_KEY = 'stiq.media.blossomEndpoint';

// Live endpoint, read synchronously by mediaService. Seeded with the build default; replaced by
// the persisted value on load() and by the user on setEndpoint().
let currentEndpoint: string = MEDIA_BLOSSOM_ENDPOINT;

/** The Blossom endpoint in effect right now (user override, else the build default). */
export function getBlossomEndpoint(): string {
  return currentEndpoint;
}

/** Set the in-memory endpoint only (no persistence). For the store and tests. */
export function setBlossomEndpointRuntime(url: string): void {
  currentEndpoint = url;
}

/** Trim and drop any trailing slash(es). An empty string clears the endpoint (uploads disabled). */
export function normalizeEndpoint(raw: string): string {
  const t = raw.trim();
  return t ? t.replace(/\/+$/, '') : '';
}

export interface EndpointValidation {
  /** False only when the input is a non-empty, non-http(s) string. Empty is valid (= disabled). */
  valid: boolean;
  kind: 'onion' | 'clearnet' | 'invalid' | 'empty';
  message: string;
}

/** Validate/classify a user-entered Blossom URL for inline UI feedback. */
export function validateEndpoint(raw: string): EndpointValidation {
  const url = normalizeEndpoint(raw);
  if (!url) {
    return {valid: true, kind: 'empty', message: 'No server set — image upload is disabled.'};
  }
  const info = classifyUrl(url);
  if (info.kind === 'invalid') {
    return {valid: false, kind: 'invalid', message: 'Enter a valid http:// or https:// URL.'};
  }
  if (info.kind === 'onion') {
    return {valid: true, kind: 'onion', message: 'Onion host — uploads stay inside Tor.'};
  }
  return {
    valid: true,
    kind: 'clearnet',
    message: 'Clearnet host — uploads leave Tor via an exit node. An .onion server is safer.',
  };
}

/**
 * Persistent store for the user's Blossom endpoint. Owned by AppRuntime; loaded at init() and
 * updated when the user saves a new value in Settings.
 */
export class MediaSettingsStore {
  constructor(private readonly storage: SecureStorage | null) {}

  /** Load the persisted endpoint into the live accessor (falls back to the build default). */
  async load(): Promise<void> {
    if (!this.storage) {
      setBlossomEndpointRuntime(MEDIA_BLOSSOM_ENDPOINT);
      return;
    }
    try {
      const saved = await this.storage.getItem(ENDPOINT_KEY);
      setBlossomEndpointRuntime(saved ?? MEDIA_BLOSSOM_ENDPOINT);
    } catch {
      setBlossomEndpointRuntime(MEDIA_BLOSSOM_ENDPOINT);
    }
  }

  getEndpoint(): string {
    return getBlossomEndpoint();
  }

  /** Normalize, apply to the live accessor, and persist. */
  async setEndpoint(raw: string): Promise<void> {
    const url = normalizeEndpoint(raw);
    setBlossomEndpointRuntime(url);
    await this.storage?.setItem(ENDPOINT_KEY, url);
  }
}
