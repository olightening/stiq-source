/**
 * MediaService — the app-wide binding between deep UI components and the Tor transport.
 *
 * Components (ImagePlaceholderCard, the media pipeline) sit far below where the live TorManager is
 * created, so rather than thread it through every prop we expose a single service, set once at
 * startup (App.tsx) against the live manager. When it is unset (tests, or a build without the
 * native modules) components degrade to a safe offline state — they NEVER fall back to an
 * OS-stack fetch.
 */
import {NativeModules} from 'react-native';
import type {TorManager} from '../tor';
import type {ImageMeta} from '../nostr/imeta';
import {fetchImage, type FetchedImage, type FetchImageOptions} from './image';
import {resolveFinalUrl} from './torHttp';
import {encodeBlurhash} from './blurhashEncode';
import {uploadToBlossom, type AuthSigner, type ProcessedImage} from './upload';
import {base64ToBytes} from '../util/base64';
import {getBlossomEndpoint} from './mediaSettings';

interface StiqImageNative {
  process(
    base64: string,
    maxDim: number,
  ): Promise<{
    base64: string;
    mime: string;
    width: number;
    height: number;
    size: number;
    sha256: string;
    thumb: {width: number; height: number; rgbaBase64: string};
  }>;
  /** Decode + scale the WHOLE photo (no crop) to a width×height RGBA buffer (Stiq Pictures). */
  pixels(base64: string, maxSide: number): Promise<{width: number; height: number; rgbaBase64: string}>;
  /** Save a base64 PNG to the device Pictures collection (Stiq Pictures viewer "Save PNG"). */
  savePng(pngBase64: string, name: string): Promise<boolean>;
}

/** A full-photo RGBA source buffer for the pixel engine (framed by the JS cropper). */
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface MediaService {
  /** Whether Tor is currently connected (a fetch can succeed). */
  isConnected(): boolean;
  fetchImage(meta: ImageMeta, opts?: FetchImageOptions): Promise<FetchedImage>;
  resolveFinalUrl(url: string): Promise<{finalUrl: string; status: number}>;
  /** Whether outbound uploads are possible (a media host is configured + native present). */
  canUpload(): boolean;
  /** Sanitize + re-encode + hash + BlurHash an image (native StiqImage). */
  processImage(base64: string): Promise<ProcessedImage>;
  /** Decode a picked photo to a full-photo RGBA buffer for the Stiq Pictures pixel engine. */
  getPixels(base64: string, maxSide: number): Promise<RgbaImage>;
  /** Save a base64 PNG to the device Pictures collection; resolves true on success. */
  savePng(pngBase64: string, name: string): Promise<boolean>;
  /** Process then upload to the configured Blossom host over Tor; returns NIP-94 imeta. */
  uploadImage(base64: string, signAuth: AuthSigner): Promise<ImageMeta>;
}

let current: MediaService | null = null;

export function setMediaService(service: MediaService | null): void {
  current = service;
}

export function getMediaService(): MediaService | null {
  return current;
}

function stiqImage(): StiqImageNative | undefined {
  return (NativeModules as {StiqImage?: StiqImageNative}).StiqImage;
}

export function createMediaService(manager: TorManager): MediaService {
  const processImage = async (base64: string): Promise<ProcessedImage> => {
    const native = stiqImage();
    if (!native) {
      throw new Error('StiqImage native module not linked');
    }
    const r = await native.process(base64, 1280);
    const rgba = base64ToBytes(r.thumb.rgbaBase64);
    let blurhash: string | undefined;
    try {
      blurhash = encodeBlurhash(rgba, r.thumb.width, r.thumb.height, 4, 3);
    } catch {
      blurhash = undefined; // a missing blurhash is non-fatal
    }
    return {
      bytes: base64ToBytes(r.base64),
      mime: r.mime,
      width: r.width,
      height: r.height,
      sha256: r.sha256,
      blurhash,
    };
  };

  const getPixels = async (base64: string, maxSide: number): Promise<RgbaImage> => {
    const native = stiqImage();
    if (!native) {
      throw new Error('StiqImage native module not linked');
    }
    const r = await native.pixels(base64, maxSide);
    return {width: r.width, height: r.height, rgba: base64ToBytes(r.rgbaBase64)};
  };

  const savePng = async (pngBase64: string, name: string): Promise<boolean> => {
    const native = stiqImage();
    if (!native) {
      throw new Error('StiqImage native module not linked');
    }
    return native.savePng(pngBase64, name);
  };

  return {
    isConnected: () => manager.getSocksProxy() !== null,
    fetchImage: (meta, opts) => fetchImage(manager, meta, opts),
    resolveFinalUrl: url => resolveFinalUrl(manager, url),
    canUpload: () => Boolean(getBlossomEndpoint()) && Boolean(stiqImage()),
    processImage,
    getPixels,
    savePng,
    uploadImage: async (base64, signAuth) => {
      const processed = await processImage(base64);
      return uploadToBlossom(manager, getBlossomEndpoint(), processed, signAuth);
    },
  };
}
