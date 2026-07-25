/**
 * ImagePlaceholderCard — secure, leak-free inbound image (Tiers 0/1/2).
 *
 * By default it shows the post's embedded BlurHash (Tier 0) — a colorful preview decoded
 * locally with ZERO network. Nothing is fetched until the user explicitly taps "Load". On
 * tap it pulls the bytes over Tor via the MediaService (Tier 1), which sniffs magic bytes,
 * rejects animated/oversized/wrong-type payloads, and verifies the sha256 pinned in the
 * post's `imeta` (Tier 2), then renders from an in-memory data URI — so the real image bytes
 * NEVER traverse the OS network stack and the reader's IP is never exposed.
 *
 * This replaces the old card, which downloaded the full image over CLEARNET just to blur it.
 */
import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Image, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors, radius, space, type as typeScale, weight} from '../../ui/theme';
import {BlurhashView} from '../../ui/BlurhashView';
import {getMediaService} from '../../media/mediaService';
import {getRenderedMedia, putRenderedMedia, subscribeRenderedMedia} from '../../media/renderedMediaCache';
import type {ImageMeta} from '../../nostr/imeta';
import {classifyUrl, prettyDomain} from '../../util/url';
import {REQUIRE_ONION_MEDIA} from '../../config';
import {Icon} from '../../ui/icons';

type LoadState =
  | {phase: 'idle'}
  | {phase: 'loading'}
  | {phase: 'loaded'; dataUri: string}
  | {phase: 'error'; reason: string};

export interface ImagePlaceholderCardProps {
  /** Either a bare URL or full NIP-94 metadata (blurhash, dim, sha256). */
  meta: ImageMeta;
}

/** Stable rendered-media cache key: the hash-pin when present (content-addressed), else the URL. */
function mediaCacheKey(meta: ImageMeta): string {
  return meta.sha256 ? `sha:${meta.sha256}` : `url:${meta.url}`;
}

export function ImagePlaceholderCard({meta}: ImagePlaceholderCardProps): React.JSX.Element {
  const [state, setState] = useState<LoadState>({phase: 'idle'});
  const info = classifyUrl(meta.url);
  const isClearnet = info.kind === 'clearnet';
  const aspect = meta.dim && meta.dim.height > 0 ? meta.dim.width / meta.dim.height : undefined;

  // When Settings clears the rendered-media cache, drop a loaded image back to the tap-to-load
  // placeholder — so a remote image must be re-fetched over Tor (nothing is auto-loaded).
  useEffect(
    () =>
      subscribeRenderedMedia(() =>
        setState(prev => (prev.phase === 'loaded' ? {phase: 'idle'} : prev)),
      ),
    [],
  );

  const load = async (): Promise<void> => {
    // Already-rendered this session? Repaint instantly from the RAM cache — no Tor round-trip.
    const cached = getRenderedMedia(mediaCacheKey(meta));
    if (cached) {
      setState({phase: 'loaded', dataUri: cached});
      return;
    }
    const service = getMediaService();
    if (!service) {
      setState({phase: 'error', reason: 'Connect Tor to load images'});
      return;
    }
    if (!service.isConnected()) {
      setState({phase: 'error', reason: 'Offline — image loads over Tor only'});
      return;
    }
    setState({phase: 'loading'});
    try {
      const img = await service.fetchImage(meta);
      putRenderedMedia(mediaCacheKey(meta), img.dataUri); // cache for instant re-open until cleared
      setState({phase: 'loaded', dataUri: img.dataUri});
    } catch (e) {
      setState({phase: 'error', reason: e instanceof Error ? e.message : 'failed to load'});
    }
  };

  if (state.phase === 'loaded') {
    // data: URI — rendered from in-memory bytes, no network fetch.
    return (
      <Press variant="row" onPress={() => setState({phase: 'idle'})} style={[s.frame, aspect ? {aspectRatio: aspect} : s.fixed]}>
        <Image source={{uri: state.dataUri}} style={StyleSheet.absoluteFill} resizeMode="cover" />
      </Press>
    );
  }

  const blocked = REQUIRE_ONION_MEDIA && isClearnet;

  return (
    <Press
      variant="row"
      style={[s.frame, aspect ? {aspectRatio: aspect} : s.fixed]}
      onPress={blocked || state.phase === 'loading' ? undefined : load}
      accessibilityLabel="image-placeholder">
      <BlurhashView hash={meta.blurhash} />
      <View style={s.overlay}>
        {state.phase === 'loading' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <View style={s.pill}>
            <Icon name={isClearnet ? '🌐' : '🔒'} size={typeScale.body}/>
            <Text style={s.pillText}>
              {blocked
                ? 'Clearnet image blocked'
                : state.phase === 'error'
                  ? 'Retry over Tor'
                  : 'Load image'}
            </Text>
          </View>
        )}
        <Text style={s.domain} numberOfLines={1}>
          {prettyDomain(meta.url)}
          {isClearnet ? ' · via exit node' : ' · onion'}
        </Text>
        {state.phase === 'error' && <Text style={s.error} numberOfLines={2}>{state.reason}</Text>}
      </View>
    </Press>
  );
}

const s = StyleSheet.create({
  frame: {
    width: '100%',
    borderRadius: radius.sm,
    // Vertical, matching the other inline media — nothing else spaces these apart from the text.
    marginVertical: space.sm,
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fixed: {height: 180},
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.32)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.xs,
    padding: space.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  pillText: {color: '#fff', fontSize: typeScale.caption, fontWeight: weight.semibold},
  domain: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: typeScale.micro,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  error: {color: '#ffd0d0', fontSize: typeScale.micro, textAlign: 'center'},
});
