/**
 * CommentThread — the nested NIP-22 reply thread shown under a broadcast (in the feed row's expanded
 * state and on the single-post screen). Each node: avatar + name/npub/time header + body, with an
 * owner "Hide" moderation action and recursive children.
 */
import React from 'react';
import {Alert, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../../ui/Press';
import type {CommentNode} from '../../../feed/thread';
import {decodeGradient, type GradientSpec} from '../../../media/gradient';
import {GradientAvatar} from '../../../ui/GradientAvatar';
import {decodeNameHeader} from '../../../profile/displayName';
import {paragraphAlign} from '../../../ui/textDirection';
import {colors, DENSE_MAX_FONT_SCALE} from '../../tokens';
import {npubFor, shortNpub, relTimeShort} from './format';
import {resolveAuthor} from '../../../blind/identity';
import {resolveContent} from '../../../blind/blindPost';

export function CommentThread({
  nodes,
  depth = 0,
  canModerate,
  onModerate,
  getAuthorName,
  getAuthorGradient,
}: {
  nodes: CommentNode[];
  depth?: number;
  canModerate?: boolean;
  onModerate?: (id: string, authorPubkey: string, action: 'hide' | 'hideUser') => void;
  getAuthorName?: (pubkey: string) => string | undefined;
  getAuthorGradient?: (pubkey: string) => GradientSpec | undefined;
}): React.JSX.Element {
  return (
    <>
      {nodes.map(node => {
        // A comment may be a blind post (throwaway-signed) — resolve its real author before
        // deriving the avatar seed/name/gradient, or every blind comment renders anonymous
        // (retroactive: this fixes every comment already stored, not just new ones).
        const author = resolveAuthor(node.event);
        const npub = npubFor(author.pubkey);
        const name = (author.name ?? getAuthorName?.(author.pubkey))?.trim();
        // author.gradient is the raw attestation wire form (a string) — decode it to the same
        // GradientSpec shape getAuthorGradient returns before handing it to GradientAvatar.
        const gradient = (author.gradient ? decodeGradient(author.gradient) : undefined) ?? getAuthorGradient?.(author.pubkey);
        // Channel comments can't be sealed today (channels sign with the bound npub, never the
        // blind feedSigner) — resolveContent is a no-op passthrough for them. Routed through it
        // anyway as cheap, permanent insurance: it is only ever true "by an out-of-band fact"
        // (client code, not something this render can verify), and this guarantees a body that
        // somehow did arrive sealed renders '' rather than raw ciphertext.
        const body = decodeNameHeader(resolveContent(node.event).text).text;
        return (
          <View key={node.event.id} style={[s.node, {marginLeft: depth * 20}]}>
            <View style={s.row}>
              <GradientAvatar gradient={gradient} seed={npub} size={32} radius={6} />
              <View style={s.bodyWrap}>
                <View style={s.authorRow}>
                  {name ? <Text style={s.authorName} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{name}</Text> : null}
                  <Text style={s.authorNpub} numberOfLines={1} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{shortNpub(npub, 10, 4)}</Text>
                  <Text style={s.time} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>{relTimeShort(node.event.created_at)}</Text>
                </View>
                {/* Comment body is user content → align to its first-strong direction. */}
                <Text style={[s.content, paragraphAlign(body)]}>{body}</Text>
              </View>
            </View>
            {canModerate && onModerate && (
              <View style={s.modRow}>
                <Press
                  onPress={() =>
                    Alert.alert('Hide this comment?', 'It will be removed from your channel and logged.', [
                      {text: 'Cancel', style: 'cancel'},
                      {text: 'Hide', style: 'destructive', onPress: () => onModerate(node.event.id, author.pubkey, 'hide')},
                    ])
                  }>
                  <Text style={s.modAction} maxFontSizeMultiplier={DENSE_MAX_FONT_SCALE}>Hide</Text>
                </Press>
              </View>
            )}
            {node.children.length > 0 && (
              <CommentThread
                nodes={node.children}
                depth={depth + 1}
                canModerate={canModerate}
                onModerate={onModerate}
                getAuthorName={getAuthorName}
                getAuthorGradient={getAuthorGradient}
              />
            )}
          </View>
        );
      })}
    </>
  );
}

const s = StyleSheet.create({
  node: {marginTop: 8, marginLeft: 4},
  row: {flexDirection: 'row', gap: 8, alignItems: 'flex-start'},
  bodyWrap: {flex: 1, minWidth: 0},
  authorRow: {flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 3, flexWrap: 'nowrap'},
  authorName: {fontSize: 13, color: colors.textPrimary, fontWeight: '600', flexShrink: 1},
  authorNpub: {fontSize: 11, color: colors.textMuted, fontFamily: 'monospace', flexShrink: 1},
  time: {fontSize: 11, color: colors.textMuted},
  content: {fontSize: 17, color: colors.textPrimary, lineHeight: 22},
  modRow: {flexDirection: 'row', gap: 12, marginTop: 4, marginLeft: 40},
  modAction: {fontSize: 11, color: colors.danger},
});
