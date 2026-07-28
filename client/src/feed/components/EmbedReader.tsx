/**
 * EmbedReader — the full READ view for a self-contained embed that has no published event to open:
 * a `stiq:draft:…` (an unpublished piece of writing, access-gated — see below) or a `stiq:msg:…` (a
 * decrypted snapshot of a PRIVATE channel/group post). Both "travel as an embed" and are read here,
 * NOT as a post. Opened by the host when a draft/msg embed card is tapped (MainScreen.openEmbedTarget),
 * which decodes the raw token and hands it here. All carried strings were already sanitized/clamped at
 * decode (draftEmbed.ts / msgEmbed.ts), so this component only lays them out.
 *
 * THE `msg` BRANCH (a private-space message quote) is UNCHANGED by Phase 5/6/7: no access control, no
 * comments, its own "Save to embed" onward action. See {@link MsgReaderBody}.
 *
 * THE `draft` BRANCH is now a state machine over `getDraftAccessState(draftId)` (feed/draftAccess.ts's
 * module doc has the full model — request → approve → deliver, mirroring the private-space join
 * flow):
 *  - a v1 token (`draftEmbed.ts`'s retired self-contained format) parses to the string `'legacy'` —
 *    rendered as an explicit "no longer available" state, never a silent misrender or a crash.
 *  - `'none'` / `'pending'` → TEASER ONLY: identity header, title, the v2 token's own short excerpt,
 *    and a Request-access button (→ "Requested · waiting for the owner" once pending). No body, no
 *    comments, no fork — there is nothing to fork yet.
 *  - `'approved'` / `'owner'` → the full article: identity header, article-size body (fetched +
 *    decrypted via `getMyDraftDelivery`; an owner reads their own live local draft instead, via
 *    `onGetOwnerDraftSnapshot`), the SAME comment system posts use (keyed on the draft's stable
 *    `shareId`, gated behind this SAME access check), and a "Save a copy to my drafts" fork action —
 *    deliberately the ONLY onward action (no "re-share this exact embed" anywhere; forking changes
 *    ownership, starting a fresh `shareId` at its own next share).
 * See {@link DraftReaderBody} / {@link LegacyDraftBody}.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {colors, radius} from '../../ui/theme';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {SwipeBackView} from '../../ui/SwipeBack';
import {useSwipeOptOut} from '../../ui/swipeOptOut';
import {RichText} from './RichText';
import {ThreadView} from './ThreadView';
import {CommentComposer} from './CommentComposer';
import {shortenNpub, safeNpubEncode} from '../../util/npub';
import {paragraphAlign} from '../../ui/textDirection';
import {resolveAuthor} from '../../blind/identity';
import {decodeGradient, type GradientSpec} from '../../media/gradient';
import {countComments, type CommentNode} from '../thread';
import type {DraftRef} from '../draftEmbed';
import {DRAFT_COMMENT_ROOT_KIND, type DraftDeliverySnapshot} from '../draftAccess';
import type {MsgRef} from '../../channels/msgEmbed';
import type {PictureRules} from '../pictureRules';
import type {Profile} from '../../profile/profile';

/** What the reader is showing — exactly one of `draft`/`msg`, plus the raw token for save-onward.
 *  `draft` now carries the v2 `'legacy'` discriminant too (draftEmbed.ts's `parseDraftEmbed` result
 *  type) so a v1 token renders the explicit "no longer available" state below rather than being
 *  forced into a shape it no longer matches. */
export interface EmbedReaderTarget {
  token: string;
  draft?: DraftRef | 'legacy';
  msg?: MsgRef;
}

/** Mirrors `AppRuntime.getDraftAccessState`'s return union — kept as an inline literal (not a shared
 *  type import) to match how every other cross-layer callback shape in this app is declared. */
type DraftAccessState = 'owner' | 'none' | 'pending' | 'approved';

export interface EmbedReaderProps {
  target: EmbedReaderTarget | null;
  onClose: () => void;
  /** Save a `msg` embed onward to the viewer's own picker. Draft-branch only ever calls this for
   *  `target.msg` — a draft's onward action is forking a delivered COPY (`onForkDraft`), never
   *  resaving the same pointer token (that would just be "re-share this exact embed"). */
  onSaveEmbed?: (target: EmbedReaderTarget) => void;
  /** Reflects that a `msg` embed is already in the viewer's picker (shows "Saved ✓", disables the tap). */
  saved?: boolean;
  /** Tapping the identity header opens the author's profile. Gated on the ref carrying an author. */
  onAuthorPress?: (pubkey: string) => void;

  // ── Draft access control (Phase 5§D/E) — mirror the like-named AppRuntime methods 1:1; see
  // feed/draftAccess.ts's module doc for the request → approve → deliver model these read/drive. ──
  onGetDraftAccessState?: (draftId: string) => Promise<DraftAccessState>;
  onGetMyDraftDelivery?: (draftId: string, ownerPubkey?: string) => Promise<DraftDeliverySnapshot | null>;
  onRequestDraftAccess?: (draftId: string, ownerPubkey: string) => Promise<void>;
  /**
   * Monotonic counter that moves whenever anything access-relevant lands (`AppSnapshot
   * .storeVersions.draftAccess`). The access check re-runs on every change, which is what makes an
   * approval arriving while this reader is ALREADY OPEN unlock it in place, instead of stranding the
   * viewer on "Requested · waiting for the owner" until they back out and re-enter.
   *
   * Do not drop this on the grounds that "it re-renders anyway": before it existed the re-check
   * fired only because App.tsx passes the draft callbacks as inline arrows, so their identity
   * changed every render. Wrapping those in `useCallback` — an ordinary perf change, and this app is
   * actively receiving one — would have silently killed the live unlock with no test failing.
   */
  accessVersion?: number;
  /** An OWNER's own live draft, read straight from the local, already-loaded DraftStore echo — an
   *  owner is never their own requester, so there is no `DraftDelivery` to fetch (sync; no round-trip). */
  onGetOwnerDraftSnapshot?: (shareId: string) => DraftDeliverySnapshot | null;
  /** Fork the approved/owned content into the viewer's own Drafts ("Save a copy to my drafts") — the
   *  only onward path once unlocked; ownership genuinely changes (a fresh `shareId` at ITS next share). */
  onForkDraft?: (ref: DraftRef, snapshot: DraftDeliverySnapshot) => void;

  // ── Phase 7§B: a draft's comment thread, gated identically to the body — absent, not merely
  // disabled, unless `getDraftAccessState` resolves 'owner'/'approved'. ──
  onGetDraftThread?: (shareId: string) => CommentNode[];
  onGetDraftCommentCount?: (shareId: string) => number;
  /** Build + publish a comment — the SAME signature `App.tsx` wires to `runtime.comment` for real
   *  posts; a draft just supplies a synthetic root (`{id: shareId, pubkey: draft.author ?? '', kind:
   *  DRAFT_COMMENT_ROOT_KIND}`, see feed/draftAccess.ts) instead of a published post/message ref. */
  onComment?: (
    content: string,
    rootId: string,
    rootPubkey: string,
    rootKind: number,
    parentId: string,
    parentPubkey: string,
    parentKind: number,
  ) => void;
  /** Resolves a commenter's name/gradient (comment authors carry no identity of their own — unlike the
   *  draft's OWN header, which is fully offline off the token). */
  onGetProfile?: (pubkey: string) => Profile;
  allowVoice?: boolean;
  pictureRules?: PictureRules;
  picturesSpentBytes?: number;
  /** The viewer's own identity, for the comment composer's expanded-editor byline. */
  myGradient?: GradientSpec | null;
  myPubkey?: string;
}

function authorLine(pubkey?: string, name?: string): string {
  if (name) return name;
  if (pubkey) return shortenNpub(safeNpubEncode(pubkey), {lead: 10, tail: 4});
  return '';
}

export function EmbedReader({
  target,
  onClose,
  onSaveEmbed,
  saved,
  onAuthorPress,
  onGetDraftAccessState,
  onGetMyDraftDelivery,
  onRequestDraftAccess,
  accessVersion,
  onGetOwnerDraftSnapshot,
  onForkDraft,
  onGetDraftThread,
  onGetDraftCommentCount,
  onComment,
  onGetProfile,
  allowVoice,
  pictureRules,
  picturesSpentBytes,
  myGradient,
  myPubkey,
}: EmbedReaderProps): React.JSX.Element {
  const msg = target?.msg;
  const draftTarget = target?.draft;

  return (
    <Modal visible={!!target} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.page}>
        {/* SafeAreaView stays put as the opaque backdrop (s.page: colors.bg, flex:1) — only its
            children slide via SwipeBackView, so a swipe-back drag reveals real app background
            instead of a transparent hole onto this Modal's bare Dialog window. */}
        <SwipeBackView onBack={onClose}>
          <View style={s.header}>
            <Press onPress={onClose} hitSlop={10} style={s.headerSide}>
              <Text style={s.headerLeft}>‹ Back</Text>
            </Press>
            <Text style={s.headerEyebrow}>{msg ? 'PRIVATE POST' : 'DRAFT'}</Text>
            {/* Drafts deliberately have NO save-onward path — forking is their only onward action
                (Phase 5§E's locked decision), so this stays gated on `msg`. */}
            {msg && onSaveEmbed && target ? (
              <Press
                onPress={() => { if (!saved) onSaveEmbed(target); }}
                hitSlop={10}
                disabled={saved}
                style={[s.headerSide, s.headerRight]}
                accessibilityLabel="save this embed">
                <Text style={[s.headerSave, saved && s.headerSaved]}>{saved ? 'Saved ✓' : 'Save to embed'}</Text>
              </Press>
            ) : (
              <View style={[s.headerSide, s.headerRight]} />
            )}
          </View>

          {msg ? (
            <MsgReaderBody msg={msg} />
          ) : draftTarget === 'legacy' ? (
            <LegacyDraftBody />
          ) : draftTarget ? (
            <DraftReaderBody
              // Remount fresh per token — every hook below (access state, fetched snapshot, CW reveal,
              // reply target) is scoped to ONE draft; reusing the instance across a different token
              // opened in the same session would otherwise leak the previous draft's resolved state.
              key={target?.token}
              draft={draftTarget}
              onAuthorPress={onAuthorPress}
              onGetDraftAccessState={onGetDraftAccessState}
              onGetMyDraftDelivery={onGetMyDraftDelivery}
              onRequestDraftAccess={onRequestDraftAccess}
              accessVersion={accessVersion}
              onGetOwnerDraftSnapshot={onGetOwnerDraftSnapshot}
              onForkDraft={onForkDraft}
              onGetDraftThread={onGetDraftThread}
              onGetDraftCommentCount={onGetDraftCommentCount}
              onComment={onComment}
              onGetProfile={onGetProfile}
              allowVoice={allowVoice}
              pictureRules={pictureRules}
              picturesSpentBytes={picturesSpentBytes}
              myGradient={myGradient}
              myPubkey={myPubkey}
            />
          ) : null}
        </SwipeBackView>
      </SafeAreaView>
    </Modal>
  );
}

/** The `msg` branch — a decrypted, self-contained quote from a private space. Untouched by Phase
 *  5/6/7: no access control, no comments, plain body size. Kept as its own component purely so the
 *  draft state machine below can freely use hooks without this branch's (hook-free) render mixing in. */
function MsgReaderBody({msg}: {msg: MsgRef}): React.JSX.Element {
  const author = authorLine(msg.author, msg.name);
  const where = msg.spaceName ? `from ${msg.spaceName}` : 'from a private space';
  return (
    <ScrollView style={s.flex} contentContainerStyle={s.content}>
      <Text style={s.where}>{where}</Text>
      {!!author && (
        <View style={s.authorRow}>
          <GradientAvatar gradient={msg.gradient} seed={msg.author} size={22} />
          <Text style={s.authorName} numberOfLines={1}>{author}</Text>
          <Text style={s.notPublished}>· not published</Text>
        </View>
      )}
      {!!msg.body && <RichText content={msg.body} style={s.body} paragraphSpacing={14} />}
      <Text style={s.footNote}>
        This post was shared from a private space as an embed — read-only, with no likes or comments here.
      </Text>
    </ScrollView>
  );
}

/** A v1 (retired) draft token — broken by design, never grandfathered. Explicit state, never a
 *  silent misrender of stale/missing fields. */
function LegacyDraftBody(): React.JSX.Element {
  return (
    <View style={s.legacyWrap}>
      <Text style={s.legacyTitle}>No longer available</Text>
      <Text style={s.legacyText}>
        This shared draft uses an old format and is no longer available.
      </Text>
    </View>
  );
}

interface DraftReaderBodyProps {
  draft: DraftRef;
  onAuthorPress?: (pubkey: string) => void;
  onGetDraftAccessState?: (draftId: string) => Promise<DraftAccessState>;
  onGetMyDraftDelivery?: (draftId: string, ownerPubkey?: string) => Promise<DraftDeliverySnapshot | null>;
  onRequestDraftAccess?: (draftId: string, ownerPubkey: string) => Promise<void>;
  /** See {@link EmbedReaderProps.accessVersion} — drives the live re-check while open. */
  accessVersion?: number;
  onGetOwnerDraftSnapshot?: (shareId: string) => DraftDeliverySnapshot | null;
  onForkDraft?: (ref: DraftRef, snapshot: DraftDeliverySnapshot) => void;
  onGetDraftThread?: (shareId: string) => CommentNode[];
  onGetDraftCommentCount?: (shareId: string) => number;
  onComment?: EmbedReaderProps['onComment'];
  onGetProfile?: (pubkey: string) => Profile;
  allowVoice?: boolean;
  pictureRules?: PictureRules;
  picturesSpentBytes?: number;
  myGradient?: GradientSpec | null;
  myPubkey?: string;
}

/** The identity header shared by BOTH the teaser and the full view (Phase 6): one Pressable wrapping
 *  a circular `GradientAvatar` + Display Name + "· Draft" — modeled on the post-detail byline
 *  (`MainScreen.tsx`'s article byline), but without its npub/date/vote furniture, which a draft (no
 *  published timestamp, no score) has no equivalent of. Absent entirely when the token carries no
 *  author — there is no identity to lead with. */
function DraftIdentityHeader({
  draft,
  onAuthorPress,
}: {
  draft: DraftRef;
  onAuthorPress?: (pubkey: string) => void;
}): React.JSX.Element | null {
  if (!draft.author) return null;
  const canOpen = !!onAuthorPress;
  const name = draft.authorName?.trim() || shortenNpub(safeNpubEncode(draft.author), {lead: 10, tail: 4});
  return (
    <Pressable
      style={s.byline}
      onPress={canOpen ? () => onAuthorPress!(draft.author!) : undefined}
      disabled={!canOpen}
      hitSlop={6}
      accessibilityRole={canOpen ? 'button' : undefined}>
      <GradientAvatar gradient={draft.authorGradient} seed={draft.author} size={32} />
      <Text style={s.bylineName} numberOfLines={1}>{name}</Text>
      <Text style={s.bylineDot}>{' · Draft'}</Text>
    </Pressable>
  );
}

/**
 * The draft state machine (Phase 5§E/6/7§B). Kept as its own component (remounted per-token by the
 * `key` above) so its hooks are always called unconditionally — the teaser/full-view SWITCH below is
 * a render branch inside one mounted component, not a conditional hook call.
 */
function DraftReaderBody({
  draft,
  onAuthorPress,
  onGetDraftAccessState,
  onGetMyDraftDelivery,
  onRequestDraftAccess,
  accessVersion,
  onGetOwnerDraftSnapshot,
  onForkDraft,
  onGetDraftThread,
  onGetDraftCommentCount,
  onComment,
  onGetProfile,
  allowVoice,
  pictureRules,
  picturesSpentBytes,
  myGradient,
  myPubkey,
}: DraftReaderBodyProps): React.JSX.Element {
  // `null` = still resolving (first render, before the async access check lands) — treated as
  // "not yet unlocked" below so the teaser is what a viewer sees while it settles, never a flash of
  // the wrong state.
  const [access, setAccess] = useState<DraftAccessState | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [snapshot, setSnapshot] = useState<DraftDeliverySnapshot | null>(null);
  const [forked, setForked] = useState(false);
  // Content-warning reveal gate on the delivered snapshot — matches the app's standing CW posture.
  const [revealed, setRevealed] = useState(false);
  const [replyTarget, setReplyTarget] = useState<CommentNode | null>(null);
  const optOut = useSwipeOptOut();

  const refreshAccess = useCallback((): void => {
    if (!onGetDraftAccessState) { setAccess('none'); return; }
    void onGetDraftAccessState(draft.id).then(setAccess).catch(() => setAccess('none'));
  }, [draft.id, onGetDraftAccessState]);
  // `accessVersion` is the load-bearing dependency here, NOT `refreshAccess` — it is what re-runs
  // the check when an approval lands while this reader is already open. See the prop's own doc for
  // why relying on the callback's identity changing was a trap rather than a design.
  useEffect(() => { refreshAccess(); }, [refreshAccess, accessVersion]);

  const unlocked = access === 'owner' || access === 'approved';

  // Fetch the real content once unlocked — an owner reads their own live local draft (sync, no
  // round-trip); an approved requester decrypts their `DraftDelivery` (async).
  useEffect(() => {
    if (access === 'owner') {
      setSnapshot(onGetOwnerDraftSnapshot?.(draft.id) ?? null);
      return;
    }
    if (access === 'approved') {
      let cancelled = false;
      if (!onGetMyDraftDelivery) { setSnapshot(null); return; }
      void onGetMyDraftDelivery(draft.id, draft.author).then(s => { if (!cancelled) setSnapshot(s); });
      return () => { cancelled = true; };
    }
    setSnapshot(null);
    return undefined;
  }, [access, draft.id, draft.author, onGetOwnerDraftSnapshot, onGetMyDraftDelivery]);

  const identityHeader = <DraftIdentityHeader draft={draft} onAuthorPress={onAuthorPress} />;

  if (!unlocked) {
    // ── Teaser: identity header, title, the v2 token's own excerpt, Request access. Nothing else —
    // no body, no comments, no fork; there is nothing behind the pointer to show yet. ──
    const canRequest = !!draft.author && !!onRequestDraftAccess;
    return (
      <ScrollView style={s.flex} contentContainerStyle={s.content}>
        {identityHeader}
        {!!draft.title && <Text style={[s.title, paragraphAlign(draft.title)]}>{draft.title}</Text>}
        {!!draft.excerpt && <Text style={[s.excerpt, paragraphAlign(draft.excerpt)]}>{draft.excerpt}</Text>}
        {canRequest ? (
          <Pressable
            style={[s.reqButton, (access !== 'none' || requesting) && s.reqButtonDisabled]}
            disabled={access === null || access === 'pending' || requesting}
            onPress={() => {
              setRequesting(true);
              void onRequestDraftAccess!(draft.id, draft.author!)
                .then(refreshAccess)
                .finally(() => setRequesting(false));
            }}
            accessibilityLabel="request access to this draft">
            <Text style={[s.reqButtonText, access === 'pending' && s.reqButtonTextPending]}>
              {access === 'pending' ? 'Requested · waiting for the owner' : 'Request access'}
            </Text>
          </Pressable>
        ) : !draft.author ? (
          <Text style={s.reqUnavailable}>
            This draft's owner couldn't be identified — access can't be requested.
          </Text>
        ) : null}
      </ScrollView>
    );
  }

  // ── Approved / owner: the full article + the SAME comment system posts use, gated behind this
  // same `unlocked` check — absent entirely otherwise, never merely disabled (Phase 7§B). ──
  const shareId = draft.id;
  const draftRootPubkey = draft.author ?? '';
  const bodyTitle = snapshot?.ti ?? draft.title;
  const cw = snapshot?.cw;
  const showBody = !cw || revealed;
  const nodes = onGetDraftThread?.(shareId) ?? [];
  const commentCount = onGetDraftCommentCount ? onGetDraftCommentCount(shareId) : countComments(nodes);

  const header = (
    <View style={s.articleHeader}>
      {identityHeader}
      {!!bodyTitle && <Text style={[s.title, paragraphAlign(bodyTitle)]}>{bodyTitle}</Text>}
      {snapshot?.l ? (
        <View style={s.labelChip}><Text style={s.labelChipText}>{snapshot.l}</Text></View>
      ) : null}
      {cw ? (
        <View style={s.cwBox}>
          <Text style={s.cwLabel}>CONTENT WARNING</Text>
          <Text style={s.cwReason}>{cw}</Text>
          {!revealed && (
            <Pressable style={s.cwReveal} onPress={() => setRevealed(true)}>
              <Text style={s.cwRevealText}>Show content</Text>
            </Pressable>
          )}
        </View>
      ) : null}
      {showBody && (
        snapshot ? (
          <RichText content={snapshot.b} style={s.articleBody} paragraphSpacing={15} />
        ) : (
          <Text style={s.loadingText}>Loading…</Text>
        )
      )}
      {snapshot && onForkDraft ? (
        <Pressable
          style={[s.forkButton, forked && s.forkButtonDone]}
          disabled={forked}
          onPress={() => { onForkDraft(draft, snapshot); setForked(true); }}
          accessibilityLabel="save a copy of this draft to your drafts">
          <Text style={[s.forkButtonText, forked && s.forkButtonDoneText]}>
            {forked ? 'Saved to your Drafts ✓' : 'Save a copy to my drafts'}
          </Text>
        </Pressable>
      ) : null}
      <View style={s.commentsHead}>
        <Text style={s.commentsEyebrow}>COMMENTS</Text>
        <Text style={s.commentsNum}>{commentCount}</Text>
        <View style={s.commentsRule} />
      </View>
    </View>
  );

  return (
    <>
      <ThreadView
        nodes={nodes}
        opPubkey={draftRootPubkey || undefined}
        onReply={node => setReplyTarget(node)}
        onAuthorPress={onAuthorPress}
        getAuthorName={ev => {
          const a = resolveAuthor(ev);
          return a.name ?? onGetProfile?.(a.pubkey)?.name ?? null;
        }}
        getAuthorGradient={ev => {
          const a = resolveAuthor(ev);
          return (a.gradient ? decodeGradient(a.gradient) : undefined) ?? onGetProfile?.(a.pubkey)?.gradient;
        }}
        listHeader={header}
      />
      {onComment && (
        // Wrapped in a plain View (CommentComposer's own props don't forward touch handlers) so the
        // swipe-back drag stands down for any touch landing on it: the composer's TextInput does its
        // own selection-handle drag, which never joins JS responder negotiation, so without this the
        // page swipe would win that drag instead.
        <View {...optOut}>
          <CommentComposer
            placeholder={replyTarget ? 'Reply to comment…' : 'Add a comment…'}
            submitLabel={replyTarget ? 'Reply' : 'Comment'}
            allowVoice={allowVoice}
            pictureRules={pictureRules}
            picturesSpentBytes={picturesSpentBytes}
            myGradient={myGradient}
            myPubkey={myPubkey}
            rootTitle={bodyTitle || undefined}
            onSubmit={text => {
              const parent = replyTarget
                ? {id: replyTarget.event.id, pubkey: replyTarget.event.pubkey, kind: replyTarget.event.kind}
                : {id: shareId, pubkey: draftRootPubkey, kind: DRAFT_COMMENT_ROOT_KIND};
              onComment(text, shareId, draftRootPubkey, DRAFT_COMMENT_ROOT_KIND, parent.id, parent.pubkey, parent.kind);
              setReplyTarget(null);
            }}
          />
        </View>
      )}
    </>
  );
}

const s = StyleSheet.create({
  page: {flex: 1, backgroundColor: colors.bg},
  flex: {flex: 1},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerSide: {minWidth: 96, justifyContent: 'center'},
  headerRight: {alignItems: 'flex-end'},
  headerLeft: {fontSize: 16, color: colors.textSecondary},
  headerEyebrow: {flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '800', letterSpacing: 1, color: colors.accent},
  headerSave: {fontSize: 15, fontWeight: '600', color: colors.accent},
  headerSaved: {color: colors.textMuted},

  content: {paddingHorizontal: 18, paddingTop: 16, paddingBottom: 48},
  // Same horizontal rhythm as `content`, but as a FlatList `ListHeaderComponent` (the approved-view
  // article riding atop the comment list) it owns no bottom padding of its own — commentsHead's
  // margins already provide the seam before the first comment row.
  articleHeader: {paddingHorizontal: 18, paddingTop: 16},
  where: {fontSize: 12, color: colors.textMuted, marginBottom: 6},
  title: {fontSize: 24, fontWeight: '700', color: colors.textPrimary, lineHeight: 30, marginBottom: 10},
  authorRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14},
  authorName: {fontSize: 14, fontWeight: '600', color: colors.textSecondary, flexShrink: 1},
  notPublished: {fontSize: 12.5, color: colors.textMuted},

  // Identity header (Phase 6) — GradientAvatar (circle) + Display Name + "· Draft", both teaser and
  // full view. Bigger/plainer than the msg branch's compact authorRow: this is a standalone byline,
  // not a small inline credit.
  byline: {flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16},
  bylineName: {fontSize: 15.5, fontWeight: '600', color: colors.textPrimary, flexShrink: 1},
  bylineDot: {fontSize: 13.5, color: colors.textMuted},

  excerpt: {fontSize: 15, lineHeight: 22, color: colors.textSecondary, marginBottom: 20},

  reqButton: {alignSelf: 'flex-start', backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 20, paddingVertical: 12},
  reqButtonDisabled: {backgroundColor: colors.surfaceAlt},
  reqButtonText: {fontSize: 14.5, fontWeight: '600', color: '#fff'},
  reqButtonTextPending: {color: colors.textSecondary},
  reqUnavailable: {fontSize: 13, color: colors.textMuted, fontStyle: 'italic'},

  labelChip: {alignSelf: 'flex-start', backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3, marginBottom: 12},
  labelChipText: {fontSize: 11, fontWeight: '700', letterSpacing: 0.4, color: colors.textSecondary},

  cwBox: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    padding: 12,
    marginBottom: 14,
  },
  cwLabel: {fontSize: 10, fontWeight: '800', letterSpacing: 0.8, color: colors.warning},
  cwReason: {fontSize: 14, color: colors.textSecondary, marginTop: 4},
  cwReveal: {marginTop: 10, alignSelf: 'flex-start', backgroundColor: colors.surfaceHover, borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 8},
  cwRevealText: {fontSize: 13.5, fontWeight: '600', color: colors.textPrimary},

  body: {color: colors.textPrimary, fontSize: 16, lineHeight: 24},
  // Article body (Phase 6, approved view only) — matches MainScreen.tsx's `articleBody` exactly.
  articleBody: {fontSize: 17, lineHeight: 29.24, letterSpacing: -0.05, color: colors.textPrimary, fontWeight: '400'},
  loadingText: {fontSize: 14, color: colors.textMuted, marginTop: 4},

  forkButton: {alignSelf: 'flex-start', backgroundColor: colors.surfaceAlt, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 11, marginTop: 22},
  forkButtonDone: {backgroundColor: colors.surfaceHover},
  forkButtonText: {fontSize: 14, fontWeight: '600', color: colors.textPrimary},
  forkButtonDoneText: {color: colors.textMuted},

  // Footer = separation line + "COMMENTS N" (Phase 6) — matches MainScreen.tsx's commentsHead/
  // commentsEyebrow/commentsNum/commentsRule exactly.
  commentsHead: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18, marginBottom: 14},
  commentsEyebrow: {fontSize: 11, fontWeight: '700', letterSpacing: 0.99, color: colors.textSecondary},
  commentsNum: {fontSize: 11, fontWeight: '700', color: colors.textMuted},
  commentsRule: {flex: 1, height: 1, backgroundColor: colors.border},

  footNote: {fontSize: 12, color: colors.textMuted, marginTop: 24, lineHeight: 17, fontStyle: 'italic'},

  legacyWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32},
  legacyTitle: {fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 8, textAlign: 'center'},
  legacyText: {fontSize: 14, lineHeight: 20, color: colors.textSecondary, textAlign: 'center'},
});
