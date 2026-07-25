/**
 * CommentComposer — write a comment or reply. It is a thin wrapper over the shared
 * {@link MessageComposer}, so comments use the EXACT same bubble, `+` menu, and send button as
 * channels, group chat, and DMs. Commenters get the FULL standard `+`: Embed a post · Add a link ·
 * Add picture · Record voice · Expand to editor — the same set channels/DMs offer (picture and voice
 * appear only when the organizer allows them, exactly as on the other surfaces).
 */
import React, {useEffect, useState} from 'react';
import {
  ensureSavedEmbedsLoaded,
  listSavedEmbeds,
  savedEmbedUri,
  toSavedEmbedRow,
} from '../../channels/savedEmbeds';
import {MessageComposer} from './MessageComposer';
import {SavedEmbedSheet} from './SavedEmbedSheet';
import {ComposerScreen} from './ComposerScreen';
import {VoiceComposer} from './VoiceComposer';
import {PictureComposer} from './PictureComposer';
import {encodeInlineVoice} from '../voice';
import {extractInlinePictures} from '../picture';
import {DEFAULT_PICTURE_RULES, type PictureRules} from '../pictureRules';
import type {PostRules} from '../postRules';
import type {GradientSpec} from '../../media/gradient';
import type {SavedEmbedRow} from '../../channels/savedEmbeds';
import type {DraftLocation, DraftStoreApi} from '../drafts';

export interface CommentComposerProps {
  onSubmit: (content: string) => void;
  placeholder?: string;
  /** Context label — "Comment" for a new top-level comment, "Reply" when replying. Titles the editor. */
  submitLabel?: string;
  /** Looks up a referenced event so embeds show its name/snippet. Optional (generic titles without it). */
  onGetEvent?: (id: string) => {name?: string; content?: string} | null | undefined;
  /** Organizer picture limits — gates the "Add picture" action (same as channels/DMs). Omit → no picture. */
  pictureRules?: PictureRules;
  /** Picture token bytes the member has already spent this period (for the allowance gate). */
  picturesSpentBytes?: number;
  /** Organizer post rules — supplies the expanded editor's universal long-body caps (words + media).
   *  Absent ⇒ unbounded, which is also the relay's default. */
  postRules?: PostRules;
  /** Organizer-allowed voice — gates the "Record voice" action. Omit/false → no voice. */
  allowVoice?: boolean;
  /** The commenter's own gradient identity, for the expanded editor's byline. */
  myGradient?: GradientSpec | null;
  /** The commenter's own pubkey — a stable byline avatar seed when `myGradient` is unset. */
  myPubkey?: string;
  /** The post/thread being commented on, for the byline ("Replying to <b>{rootTitle}</b>"). */
  rootTitle?: string;
  /**
   * Makes a half-written comment survive leaving the thread. Pair BOTH: the expanded editor becomes
   * a real DraftStore participant keyed on {@link inProgressDraftId}, exactly as the channel/DM
   * composers already are, and the long-press "Drafts" gesture saves on its own authority instead of
   * falling back to the `onLongPressDrafts` delegate.
   *
   * Deliberately opt-in per call site. A persisted comment draft is only useful if the thread it
   * belongs to can be REOPENED from the Drafts list, and only the feed post thread has a proven
   * path for that (MainScreen's `resume`). The channel-post, Log and draft-embed comment surfaces
   * leave these unset and keep their previous behavior — better than listing a draft that dead-ends.
   */
  draftStore?: DraftStoreApi;
  draftLocation?: DraftLocation;
}

export function CommentComposer({
  onSubmit,
  placeholder = 'Add a comment…',
  submitLabel = 'Reply',
  onGetEvent,
  pictureRules,
  picturesSpentBytes,
  postRules,
  allowVoice,
  myGradient,
  myPubkey,
  rootTitle,
  draftStore,
  draftLocation,
}: CommentComposerProps): React.JSX.Element {
  const [content, setContent] = useState('');
  const [savedOpen, setSavedOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [pictureOpen, setPictureOpen] = useState(false);
  // Bump a version counter once the async load finishes so the synchronously-read list re-renders.
  const [, setSavedVer] = useState(0);
  useEffect(() => { void ensureSavedEmbedsLoaded().then(() => setSavedVer(v => v + 1)); }, []);

  const submit = (): void => {
    if (content.trim()) {
      onSubmit(content);
      setContent('');
    }
  };

  const appendEmbed = (uri: string): void =>
    setContent(prev => (prev.trim() ? `${prev.trimEnd()}\n${uri}` : uri));
  // Append an inline media token (picture/voice), space-joined — matches the channel/DM composers.
  const appendToken = (token: string): void =>
    setContent(prev => `${prev}${prev && !/\s$/.test(prev) ? ' ' : ''}${token} `);

  // The saved posts (and spaces/events/drafts/private posts), shaped for the full editor's embed
  // picker via the one shared row builder — a self-contained embed carries its own token; a plain post
  // resolves its name/snippet via onGetEvent (which keys on post ids, not coordinates/tokens).
  const editorEmbeds: SavedEmbedRow[] = listSavedEmbeds().map(item => {
    const selfContained =
      item.kind === 30311 || item.kind === 39000 || item.kind === 31923 || !!item.draftToken || !!item.msgToken;
    return toSavedEmbedRow(item, selfContained ? undefined : onGetEvent?.(item.id));
  });

  return (
    <>
      <MessageComposer
        value={content}
        onChangeText={setContent}
        placeholder={placeholder}
        onSend={submit}
        onEmbed={() => setSavedOpen(true)}
        onExpand={() => setEditorOpen(true)}
        onAddPicture={pictureRules?.allow ? () => setPictureOpen(true) : undefined}
        onRecordVoice={allowVoice ? () => setVoiceOpen(true) : undefined}
        accessibilitySend="submit-comment"
      />
      <SavedEmbedSheet
        visible={savedOpen}
        onClose={() => setSavedOpen(false)}
        getSummary={onGetEvent}
        onPick={item => { appendEmbed(savedEmbedUri(item)); setSavedOpen(false); }}
      />
      {allowVoice && (
        <VoiceComposer
          visible={voiceOpen}
          onClose={() => setVoiceOpen(false)}
          onSend={voice => { appendToken(encodeInlineVoice(voice)); setVoiceOpen(false); }}
        />
      )}
      {pictureRules?.allow && (
        <PictureComposer
          visible={pictureOpen}
          onClose={() => setPictureOpen(false)}
          rules={pictureRules ?? DEFAULT_PICTURE_RULES}
          // Include pictures already staged in this draft so one comment can't exceed the allowance.
          spentBytes={(picturesSpentBytes ?? 0) + extractInlinePictures(content).reduce((n, p) => n + p.weightBytes, 0)}
          onAdd={token => appendToken(token)}
        />
      )}
      {/* `+` → Expand: the same Post Editor v2 engine, message-mode, over the same draft. It does NOT
          submit — its pill is Done, which closes with the draft synced back through onChangeDraft,
          and the comment is posted by the composer bubble's ↑ above (`submit`). */}
      <ComposerScreen
        visible={editorOpen}
        onClose={() => setEditorOpen(false)}
        messageMode
        headerTitle={submitLabel}
        value={content}
        allowVoice={allowVoice}
        pictureRules={pictureRules}
        pictureSpentBytes={picturesSpentBytes}
        postRules={postRules}
        onChangeDraft={setContent}
        savedEmbedTokens={editorEmbeds}
        myGradient={myGradient}
        myPubkey={myPubkey}
        bylineVerb={submitLabel === 'Reply' ? 'Replying to' : 'Commenting on'}
        communityName={rootTitle ?? 'this post'}
        draftStore={draftStore}
        draftLocation={draftLocation}
      />
    </>
  );
}
