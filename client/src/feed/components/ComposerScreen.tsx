/**
 * ComposerScreen — the reworked full-screen Post Editor (design_handoff_post_editor).
 *
 * A two-step flow: **Write** (title + rich-text body, gated by a live size-rule meter) → **Details**
 * (label, tags, content warning) → **Publish**. One idea drives everything: a post is a Note or an
 * Article, and which one it is follows only from whether you give it a title (`modeOf`). That single
 * distinction cascades into the header, the body placeholder, the meter rule, and whether a Label is
 * required.
 *
 * The meter (Write step) and the Drafts status chip share one rule set — `editorRules.ts` — so the
 * live editor and a saved draft can never disagree. Required fields are *calm*: neutral grey guidance
 * that turns green when satisfied, and a blocked Next/Publish shakes the offending region rather than
 * reddening it.
 *
 * The rich-text body reuses the existing sandboxed WebView editor (RichEditor); formatting is
 * selection-only (its bubble), and Link/Embed are a persistent Insert bar here in RN.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as nip19 from 'nostr-tools/nip19';
import {Press} from '../../ui/Press';
import {withNostrScheme} from '../../channels/savedEmbeds';
import {hasEmbedToken, labelEmbedTokens} from '../embedTokens';
import {stripBlockMarkdown} from '../plainText';
import {colors, radius} from '../../ui/theme';
import {paragraphAlign} from '../../ui/textDirection';
import {GradientAvatar, type AvatarShape} from '../../ui/GradientAvatar';
import type {GradientSpec} from '../../media/gradient';
import {safeNpubEncode} from '../../util/npub';
import type {DraftStoreApi, Draft, DraftLocation} from '../drafts';
import {newDraftId, inProgressDraftId} from '../drafts';
import {normalizeTag} from '../tags';
import {labelMetaFor, normalizeLabels, DEFAULT_LABELS, type PostLabel, type LabelConfig} from '../labels';
import {scopeAppliesTo, DEFAULT_POST_RULES, type PostRules} from '../postRules';
import {
  countStats,
  limitsFromRules,
  modeOf,
  universalLimits,
  validateDetails,
  validateMedia,
  validateUniversalBody,
  validateWrite,
  type WriteState,
} from '../editorRules';
import {normalizeTagPolicy, type TagPolicy} from '../tagPolicy';
import {RichEditor, type RichEditorHandle, type RichEditorBlock, type RichEditorCommand} from './RichEditor';
import type {PostingGuidelines} from '../postingGuidelines';
import {guidelinesSeenVersion, markGuidelinesSeen} from '../guidelinesSeen';
import {fonts} from '../../ui/typography';
import {VoiceComposer} from './VoiceComposer';
import {encodeInlineVoice} from '../voice';
import {PictureComposer} from './PictureComposer';
import {DEFAULT_PICTURE_RULES, type PictureRules} from '../pictureRules';
import {extractInlinePictures, base64ByteLength, MAX_PICTURE_BYTES} from '../picture';
import {mediaSourceTail} from '../mediaBlob';
import {bodyForMeasure, countInlineMedia} from '../inlineMedia';
import {MediaRefs} from '../mediaRefs';
import {Icon} from '../../ui/icons';

export interface ComposerScreenProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Publish the composed post. This MUST start the write and return promptly — it must NOT return a
   * promise tied to the write's completion (relay/Tor work). The wiring behind it renders the post
   * durably into the feed (with a 'sending' ring) before its first await and finishes the rest in the
   * background; the composer closes as soon as the write is UNDER WAY and never waits for, or claims,
   * an outcome (see doPublish). PUBLISH_CEILING_MS enforces this rather than trusting it.
   *
   * MAY return a promise that REJECTS to mean **the write never started** — a synchronous gate
   * declined it (App.tsx's rate limit) and has already told the user why. The composer then stays
   * open with its text and draft intact, since nothing was published. Anything else — a void return
   * or a resolving promise — means the write is under way and the composer closes.
   *
   * REQUIRED for the feed flow and for plain `bodyOnly`. Optional only because `messageMode` has no
   * submit path at all — its pill is Done, and the message is posted by the composer bubble's ↑
   * (see the `messageMode` doc). A messageMode caller passing one would be describing a send that
   * never happens, so they pass none.
   */
  onSubmit?: (content: string, tags: string[], title?: string, label?: PostLabel, contentWarning?: string) => void | Promise<unknown>;
  draftStore?: DraftStoreApi;
  /** Pre-fill from a saved draft. */
  initialDraft?: Draft;
  /** Organizer-defined tag policy. Controls which tags are shown and whether free input is allowed. */
  tagPolicy?: TagPolicy;
  /** Organizer-defined post labels — the chips shown in the label picker. */
  labels?: LabelConfig;
  /** Organizer-defined per-post-type length/label rules — the source of the meter's size rules. */
  postRules?: PostRules;
  /**
   * Organizer posting guidelines — powers the collapsible rules banner (auto-open once per covenant
   * version) + the ⓘ byline button + the full covenant sheet. null/absent hides all three.
   */
  postingGuidelines?: PostingGuidelines | null;
  /** Stable per-community key for the banner's local seen-state (the member's per-community pubkey). */
  guidelinesSeenKey?: string;
  /** The viewer's gradient identity, for the "Posting to the community" byline. */
  myGradient?: GradientSpec | null;
  /**
   * The viewer's own pubkey (hex) — derives a stable per-user byline avatar seed when `myGradient`
   * is unset, so an un-gradiented user doesn't share one identical fallback swatch with everyone
   * else. Only used for the feed byline (ignored when `space` is set).
   */
  myPubkey?: string;
  /** Real name of the community/space credited in the feed byline ("Posting to <b>{communityName}</b>"). */
  communityName?: string;
  /**
   * When posting INTO a channel/group rather than the feed, the byline shows this space's own
   * identity — its own gradient, rendered in its own shape (square/octagon/hexagon/diamond) — in
   * place of the poster's gradient circle, and its name in place of `communityName`.
   */
  space?: {name: string; gradient?: GradientSpec | null; shape: AvatarShape};
  /** Byline leading verb — default "Posting to"; a DM/comment caller overrides with "Message to" /
   * "Replying in" so the sentence reads correctly for that surface. */
  bylineVerb?: string;
  /** Saved (bookmarked) posts the author can embed as a reference via the 🔖 Embed button. */
  savedPosts?: {id: string; title: string; snippet: string; name?: string; gradient?: GradientSpec | null}[];
  /** Remove a post from the saved list (the ✕ on an Embed-picker row). */
  onRemoveSaved?: (id: string) => void;
  /**
   * Saved self-contained embed TOKENS (event cards — "Add to my embeds") offered in the same 🔖
   * picker: tapping one inserts `uri` verbatim into the body, where it renders as a live card.
   */
  savedEmbedTokens?: {id: string; label: string; title: string; uri: string; private?: boolean}[];
  /** Remove a saved embed token (the ✕ on its picker row). */
  onRemoveSavedToken?: (id: string) => void;
  /** When set, the composer is promoting a channel post to the feed — shows this banner. */
  promoteNote?: string;
  /** When set, shows a 🎙️ Voice insert that records an inline voice clip embedded into the body. */
  allowVoice?: boolean;
  /** Open the drafts list from the byline so a saved draft can be resumed. */
  onOpenDrafts?: () => void;
  /** Organizer picture limits — gates the "Add picture" insert + enforces size/allowance in the UI. */
  pictureRules?: PictureRules;
  /** Picture token bytes the member has already spent this period (for the allowance gate). */
  pictureSpentBytes?: number;
  /**
   * Body-only mode (the Events description editor): hides the title row and byline, skips the
   * Details step entirely, and the meter validates against the ARTICLE word ceiling only — no
   * floor, no note/article flip, empty allowed (the field is optional). Over the ceiling BLOCKS
   * (the event-doc wire clamps hard, unlike an article's soft advisory). The right pill reads
   * Done: it flushes the editor, hands the markdown to `onSubmit(body, [])`, and closes. Cancel
   * offers a discard confirm when the body changed. Pair with `initialBody`; `draftStore` is
   * ignored in this mode.
   */
  bodyOnly?: boolean;
  /** Header title override (bodyOnly mode). */
  headerTitle?: string;
  /** Seed body for bodyOnly mode — re-seeded on every open. */
  initialBody?: string;
  /** Editor placeholder override. */
  bodyPlaceholder?: string;
  /** Override byline visibility independent of `bodyOnly` (e.g. show it in the Events description
   * editor, which is bodyOnly but should NOT be byline-less). Default: shown for the full post flow,
   * hidden for plain bodyOnly. Always shown when `messageMode` is set. */
  showByline?: boolean;
  /**
   * Message mode — the "expand to editor" variant used by channels, groups, DMs and comments.
   *
   * It is THE SAME editor the feed uses — same rich body, same Aa block sheet (headings, quote,
   * pullquote, footer, lists, tasks, collapsible details), same insert bar (link, saved embeds,
   * table, picture, voice, paste), same undo/redo — with three deliberate subtractions:
   *
   *  - **No title.** A message has no headline, and the note-vs-article distinction it drives is a
   *    feed concept.
   *  - **No length UI.** No meter, no `n / max`, no word floor. The organizer's caps still apply
   *    (they are the relay's rule) but are surfaced as a quiet advisory, never as a running counter
   *    over someone's shoulder while they write.
   *  - **No two-step.** No Next → Details → Publish. One screen, one pill: **Done**.
   *
   * And one difference that is not a subtraction: **Done is not Send.** It closes with the body
   * synced back through `onChangeDraft`; the message is posted by the classic ↑ button on the
   * composer bubble, the same way a message typed without ever opening this editor is. The editor is
   * a bigger way to WRITE, never a second way to PUBLISH — see handleDone for why that matters.
   *
   * The body is CONTROLLED (`value` + `onChangeDraft`) and syncs on every keystroke, which is what
   * makes Cancel safe to close with no confirm: nothing can be lost, because the caller already has
   * the latest text.
   *
   * `tags`/`labels`/`title`/Details are unused in this mode.
   */
  messageMode?: boolean;
  /** Controlled body for `messageMode` (ignored otherwise). */
  value?: string;
  /**
   * Fires on every body edit in `messageMode`, and once more on Done with the flushed markdown.
   * This is how the writing gets back to the caller — there is no submit path in this mode.
   */
  onChangeDraft?: (md: string) => void;
  /** Right-pill label for plain `bodyOnly` (default 'Done'). Ignored in `messageMode`, which is
   *  always 'Done' because it does not send. */
  submitLabel?: string;
  /**
   * `messageMode` only (No.7/Phase 4): the caller's channel/group/DM location. Paired with
   * `draftStore`, this makes the screen a real DraftStore participant instead of a dumb controlled
   * text box — autosave and the long-press "Drafts" save now write a `Draft` carrying this
   * `location`, keyed by the STABLE {@link inProgressDraftId} rather than a fresh per-session id, so
   * there is exactly one resumable in-progress draft per location no matter which composer (the
   * compact bubble outside this screen, or this full editor) last touched it — both converge on the
   * same row. `onSubmit` additionally deletes it (mirrors `doPublish`'s publish-time delete). Ignored
   * outside `messageMode`; a `messageMode` caller with no location (a comment thread has none to key
   * on) falls back to `onLongPressDrafts` for the long-press instead.
   */
  draftLocation?: DraftLocation;
  /**
   * `messageMode` only: long-press "Drafts" in the byline. When `draftStore` (+ `draftLocation`) is
   * wired, this screen self-saves via `saveDraftNow` and this prop is unused — kept only as the
   * fallback for a `messageMode` caller with no location to key a DraftStore slot on (e.g.
   * `CommentComposer`, which still flushes its own draft/slot state directly). Ignored outside
   * `messageMode`.
   */
  onLongPressDrafts?: () => void;
}

const AUTOSAVE_DEBOUNCE_MS = 800;
const SLIDE_MS = 260;
/**
 * Hard ceiling on the ONLY thing publishing still waits for: onSubmit's refusal verdict (see the
 * `onSubmit` prop doc + doPublish). It does NOT bound the write — the composer stopped waiting on
 * that entirely, which is what killed the "publish tap hangs for seconds" bug.
 *
 * A conforming onSubmit answers within a microtask (it either starts the write and returns, or
 * rejects synchronously from a gate), so this never fires in practice and is generous at 2s. It is
 * here as ENFORCEMENT, not decoration: an onSubmit re-wired to return a promise tied to the write
 * (e.g. AppRuntime.post()'s, which awaits a multi-second Tor blind-token draw) would otherwise hang
 * the composer open — reintroducing the exact bug this flow was rewritten to kill. Trusting that
 * contract in a comment is how it broke last time; this is the part that can't be ignored.
 *
 * On ceiling we CLOSE, which is the correct fallback rather than a guess: the post is already
 * rendered durably in the feed, and its send indicator ('sending' → 'failed' + Retry) reports the
 * true outcome. Closing still cannot show a false "Posted": the app's only success confirmation is
 * App.tsx's Toast, which fires off a relay-confirmed delivery (AppSnapshot.postsDelivered) and is
 * unreachable from this screen — there is no success claim here for a ceiling to trip.
 */
const PUBLISH_CEILING_MS = 2_000;

/** True when the body carries an inserted reference/voice/embed token (event/space/private-post/draft)
 * so an embed-only body isn't "empty". The embed set lives in feed/embedTokens.ts — the same list
 * that exempts a token from the length meter — so a new embed kind can never render as a chip while
 * still tripping the empty-body gate (bug #12). */
export function bodyHasEmbed(md: string): boolean {
  return hasEmbedToken(md) || /\[\[voice:[^\]]+\]\]/.test(md);
}

/**
 * Sum of the REAL base64 payload weight (`InlinePicture.weightBytes`) of every picture currently in
 * a compact, PLACEHOLDER-bearing body — computed WITHOUT reassembling the body's full (≤48 KB/picture)
 * base64. `body` holds `MediaRefs` placeholders (see mediaRefs.ts); `extractInlinePictures` already
 * finds each `[[pic:…]]` token cheaply from the short placeholder tail alone (a few bytes), so this
 * only pays for a regex scan of the compact body, not a reconstruction of the real one. Each token's
 * REAL tail is then read straight off `media`'s ref map (O(1) lookup) rather than rebuilt.
 *
 * Exactly matches `extractInlinePictures(media.reassemble(body)).reduce((n, p) => n + p.weightBytes,
 * 0)` — including the same oversized-token exclusion — for every body `media` produced via
 * `toPlaceholder`/`ingest`: a token whose tail isn't a known ref (already real, e.g. a token that
 * never went through the placeholder map) falls back to its own tail, identical to what `reassemble`
 * would have left it as. Self-corrects when a picture is deleted from `body` — a removed placeholder
 * is simply no longer found by the scan.
 */
export function pendingPictureBytes(body: string, media: MediaRefs): number {
  let total = 0;
  for (const p of extractInlinePictures(body)) {
    // `mediaSourceTail` is just "the token's tail, whichever form it took" — the composer only ever
    // holds inline/placeholder tails (a body is split into blobs at PUBLISH, not while typing), so
    // this is the same string this line always read; only the accessor moved onto MediaSource.
    const tail = mediaSourceTail(p.source);
    const realTail = media.realTailFor(tail) ?? tail;
    if (base64ByteLength(realTail) > MAX_PICTURE_BYTES) { continue; } // mirrors extractInlinePictures' own cap
    total += realTail.length;
  }
  return total;
}

/** A light plain-text reduction of the markdown body for the Details preview snippet. Media and
 * embed tokens reduce to their placeholder labels (feed/embedTokens.ts owns the embed set) —
 * otherwise a raw base64 payload leaks straight into the preview text. */
export function previewText(md: string): string {
  // Media/embed tokens become their LABELS here (this preview is the author's own recap, so "🖼
  // picture" is the useful answer), then the shared markdown reduction flattens the rest — the same
  // one every other excerpt surface uses, so a Details-step recap and a DM inbox row can't drift.
  return stripBlockMarkdown(
    labelEmbedTokens(
      md
        .replace(/\[\[voice:[^\]]+\]\]/g, '🎙 voice clip')
        .replace(/\[\[pic:[^\]]+\]\]/g, '🖼 picture'),
    ),
  );
}

const METER_TRACK: Record<WriteState, string> = {
  empty: colors.borderLight,
  ok: colors.success,
  under: colors.accent,
  over: colors.danger,
  long: colors.warning,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Jun 30" — the covenant stamp format (no locale machinery; Hermes intl is unreliable). */
function shortDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/**
 * The block-style sheet's rows (design_handoff_post_editor_v2 #blockSheet): Heading/Subheading are
 * H2/H3 FOLDED into this sheet — they are no longer standalone bubble buttons. `cmd` is what the
 * editor page runs; `block` is the page-reported state that marks the row current.
 */
interface BlockRowDef {
  cmd: RichEditorCommand;
  block: RichEditorBlock;
  glyph: string;
  label: string;
  note?: string;
  serifGlyph?: boolean;
}
const BLOCK_ROWS_TEXT: BlockRowDef[] = [
  {cmd: 'body', block: 'body', glyph: 'Aa', label: 'Body'},
  {cmd: 'h2', block: 'h2', glyph: 'H2', label: 'Heading'},
  {cmd: 'h3', block: 'h3', glyph: 'H3', label: 'Subheading'},
  {cmd: 'quote', block: 'quote', glyph: '❝', label: 'Blockquote', serifGlyph: true},
  {cmd: 'pull', block: 'pull', glyph: '❞', label: 'Pullquote', serifGlyph: true},
  {cmd: 'footer', block: 'footer', glyph: '﹏', label: 'Footer', note: 'small print'},
];
const BLOCK_ROWS_LIST: BlockRowDef[] = [
  {cmd: 'bullet', block: 'ul', glyph: '•', label: 'Bullet list'},
  {cmd: 'number', block: 'ol', glyph: '1.', label: 'Numbered list'},
  {cmd: 'task', block: 'task', glyph: '☑', label: 'Task list'},
  {cmd: 'details', block: 'details', glyph: '▸', label: 'Details', note: 'collapsible'},
];

export function ComposerScreen({
  visible,
  onClose,
  onSubmit,
  draftStore,
  initialDraft,
  tagPolicy: tagPolicyProp,
  labels: labelsProp,
  postRules = DEFAULT_POST_RULES,
  postingGuidelines = null,
  guidelinesSeenKey = 'community',
  myGradient,
  myPubkey,
  communityName,
  space,
  bylineVerb = 'Posting to',
  savedPosts = [],
  onRemoveSaved,
  savedEmbedTokens = [],
  onRemoveSavedToken,
  promoteNote,
  allowVoice,
  onOpenDrafts,
  pictureRules = DEFAULT_PICTURE_RULES,
  pictureSpentBytes = 0,
  bodyOnly: bodyOnlyProp = false,
  headerTitle,
  initialBody,
  bodyPlaceholder,
  showByline,
  messageMode = false,
  value: controlledValue,
  onChangeDraft,
  submitLabel,
  draftLocation,
  onLongPressDrafts,
}: ComposerScreenProps): React.JSX.Element {
  // messageMode implies the bodyOnly-shaped single-step layout (no title/tags/label/CW/Details) — every
  // existing `bodyOnly` check below (title hidden, Details skipped, Done pill, draftStore ignored, …)
  // therefore applies to messageMode too, with no further changes needed at each call site.
  const bodyOnly = bodyOnlyProp || messageMode;
  const displayByline = messageMode || showByline || !bodyOnly;
  // Inline media (picture/voice) tokens carry multi-KB base64 that must NOT cross the RichEditor
  // WebView bridge — it silently drops large payloads, so a media note fails to post (see
  // INLINE_MEDIA_POST_FAILURE.md §0). The editor holds only a compact placeholder token; the full
  // token lives here and is reassembled at the publish / draft-save boundary. `content` therefore holds
  // PLACEHOLDER tokens throughout; it is reassembled to real base64 only when leaving this screen.
  const mediaRefs = useRef(new MediaRefs());

  const [step, setStep] = useState<1 | 2>(1);
  const [savedPickerOpen, setSavedPickerOpen] = useState(false);
  const [title, setTitle] = useState(initialDraft?.title ?? '');
  const [content, setContent] = useState(() => mediaRefs.current.ingest(initialDraft?.content ?? ''));
  const [tagDraft, setTagDraft] = useState('');
  const [tags, setTags] = useState<string[]>(initialDraft?.tags ?? []);
  const [label, setLabel] = useState<PostLabel | undefined>(initialDraft?.label ?? undefined);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkTitle, setLinkTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [pictureOpen, setPictureOpen] = useState(false);
  const [titleFocused, setTitleFocused] = useState(false);
  // Content warning (NIP-36): when enabled, adds a content-warning tag and the reason text.
  const [cwMode, setCwMode] = useState(Boolean(initialDraft?.contentWarning));
  const [cwText, setCwText] = useState(initialDraft?.contentWarning ?? '');
  // A publish is in flight: from the Publish tap until the composer closes (or the write is refused
  // and we re-arm). Disables the Publish pill and guards a double-tap across the async editor flush.
  // There is no publish OVERLAY any more — publishing closes the composer instead of narrating an
  // outcome it doesn't wait for (see doPublish).
  const [publishing, setPublishing] = useState(false);
  // v2: the block-style sheet (opened by the bar's Aa chip or the bubble's Aa button), the block the
  // caret sits in (page-reported, marks the sheet's current row), and the organizer rules surfaces.
  const [blockSheetOpen, setBlockSheetOpen] = useState(false);
  const [curBlock, setCurBlock] = useState<RichEditorBlock>('body');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [covenantOpen, setCovenantOpen] = useState(false);
  // Long-press "Drafts" confirmation — briefly flips the label to "Saved ✓" (not the global Toast,
  // which is reserved for relay-confirmed post delivery; see ui/Toast.tsx's own docstring on why).
  const [justSaved, setJustSaved] = useState(false);

  const edRef = useRef<RichEditorHandle>(null);
  // bodyOnly dirty check: the content state exactly as seeded on open (placeholder form).
  const initialContentRef = useRef('');
  const draftId = useRef(initialDraft?.id ?? newDraftId());
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ceilingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const W = Dimensions.get('window').width;
  const slide = useRef(new Animated.Value(0)).current; // 0 = Write, 1 = Details
  const meterShake = useRef(new Animated.Value(0)).current;
  const labelShake = useRef(new Animated.Value(0)).current;
  const tagsShake = useRef(new Animated.Value(0)).current;

  const tagPolicy = useMemo(() => normalizeTagPolicy(tagPolicyProp), [tagPolicyProp]);
  const labels = useMemo(() => normalizeLabels(labelsProp) ?? DEFAULT_LABELS, [labelsProp]);
  const limits = useMemo(() => limitsFromRules(postRules), [postRules]);

  // Reset the whole form whenever the composer opens (fresh post, or a resumed draft) — and also
  // when a DIFFERENT draft is resumed while the composer is already open (Drafts opened from inside
  // the composer): the host used to force that case with `key={draft.id}` remounts, which rebuilt
  // the entire WebView editor on every resume (Phase 3.5); keying the reset on the draft id here
  // replaces the remount with a plain state re-seed.
  useEffect(() => {
    if (!visible) return;
    setStep(1);
    slide.setValue(0);
    setPublishing(false);
    setJustSaved(false);
    // Cancel any autosave still pending from a previous session BEFORE swapping the media map, so a
    // stale debounced save can't fire against the fresh (empty) map and persist a dangling placeholder.
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (savedFlashTimer.current) { clearTimeout(savedFlashTimer.current); savedFlashTimer.current = null; }
    // Fresh media map per open; ingest a resumed draft's real base64 tokens into placeholders so the
    // editor bridge only ever carries the compact form.
    mediaRefs.current = new MediaRefs();
    if (initialDraft) {
      setTitle(initialDraft.title);
      const seeded = mediaRefs.current.ingest(initialDraft.content);
      setContent(seeded);
      initialContentRef.current = seeded;
      setTags(initialDraft.tags);
      setLabel(initialDraft.label ?? undefined);
      setCwMode(Boolean(initialDraft.contentWarning));
      setCwText(initialDraft.contentWarning ?? '');
      draftId.current = initialDraft.id;
    } else {
      setTitle('');
      const seeded =
        messageMode && controlledValue
          ? mediaRefs.current.ingest(controlledValue)
          : bodyOnly && initialBody
            ? mediaRefs.current.ingest(initialBody)
            : '';
      setContent(seeded);
      initialContentRef.current = seeded;
      setTags([]);
      setTagDraft('');
      setLabel(undefined);
      setCwMode(false);
      setCwText('');
      // messageMode with a wired location gets the STABLE per-location id (No.7/Phase 4) instead of
      // a fresh random one, so this screen's own autosave/saveDraftNow always converge on the exact
      // same Draft row the compact composer's own slot already writes to — never a second, orphaned
      // draft appearing alongside it just because the full editor was opened this time.
      draftId.current = messageMode && draftLocation ? inProgressDraftId(draftLocation) : newDraftId();
    }
    setBlockSheetOpen(false);
    setCovenantOpen(false);
    setRulesOpen(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialDraft?.id]);

  // Auto-open the rules banner exactly once per covenant version (first visit to the space, or the
  // organizer bumped the version) — thereafter it lives behind the byline's ⓘ button.
  useEffect(() => {
    if (!visible || !postingGuidelines) return;
    let alive = true;
    void guidelinesSeenVersion(guidelinesSeenKey).then(seen => {
      if (alive && postingGuidelines.version > seen) setRulesOpen(true);
    });
    return () => { alive = false; };
  }, [visible, postingGuidelines, guidelinesSeenKey]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (ceilingTimer.current) clearTimeout(ceilingTimer.current);
      if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    },
    [],
  );

  // Note vs Article — derived from the title, never a toggle. Everything downstream keys off this.
  // bodyOnly pins 'article' so the media cap and placeholder follow the article rules (see below).
  const postKind = bodyOnly ? 'article' : modeOf(title);

  // Drop a chosen label when it stops being offered for the current post type (e.g. an article-only
  // label after the title is cleared back to a note).
  useEffect(() => {
    if (!label) return;
    const def = labels.find(l => l.id === label);
    if (!def || !scopeAppliesTo(def.appliesTo, postKind)) setLabel(undefined);
  }, [label, labels, postKind]);

  // Drop community tags scoped to the other post type when the type flips (free-text tags are kept).
  useEffect(() => {
    setTags(prev => {
      const next = prev.filter(t => scopeAppliesTo(tagPolicy.tagScopes[t] ?? 'all', postKind));
      return next.length === prev.length ? prev : next;
    });
  }, [postKind, tagPolicy]);

  const scheduleSave = useCallback(
    (t: string, c: string, tgs: string[], lbl: PostLabel | undefined, cw: string | undefined) => {
      if (!draftStore) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        // Persist the REAL media tokens, not the editor's placeholders (which reference this session's
        // in-memory map and would be dangling on resume).
        const savedContent = mediaRefs.current.reassemble(c);
        // Refuse to persist a DANGLING placeholder: if the media map was swapped out from under this
        // debounced save (composer reopened / "Write another" fired within the debounce window),
        // reassemble can't resolve the ref and would overwrite the draft with an un-decodable token,
        // silently losing the real media. Skip the write rather than corrupt the draft.
        if (mediaRefs.current.hasUnresolvedRef(savedContent)) return;
        void draftStore.save({
          id: draftId.current,
          title: t,
          content: savedContent,
          tags: tgs,
          label: lbl ?? null,
          contentWarning: cw,
          savedAt: Date.now(),
          // undefined outside messageMode (feed drafts stay location-less — "absent ⇒ feed").
          location: draftLocation,
        });
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [draftStore, draftLocation],
  );
  const save = useCallback(
    (over: Partial<{title: string; content: string; tags: string[]; label: PostLabel | undefined; cw: string | undefined}>) => {
      scheduleSave(
        over.title ?? title,
        over.content ?? content,
        over.tags ?? tags,
        'label' in over ? over.label : label,
        'cw' in over ? over.cw : cwMode && cwText.trim() ? cwText : undefined,
      );
    },
    [scheduleSave, title, content, tags, label, cwMode, cwText],
  );

  const handleTitleChange = (t: string): void => {
    setTitle(t);
    save({title: t});
  };
  const handleContentChange = (c: string): void => {
    setContent(c);
    // messageMode: no internal DraftStore (draftStore is unused in this mode) — instead push every
    // edit straight back to the caller, mirroring the retired FullMessageEditor's onChangeDraft. This
    // is what keeps the caller's own draft state / autosave slot in sync live, which in turn is what
    // makes Cancel safe to close immediately with no confirm (see handleCancel).
    if (messageMode) onChangeDraft?.(mediaRefs.current.reassemble(c));
    save({content: c});
  };

  // ── size-rule meter + step gates ────────────────────────────────────────────
  // Measure the body with every non-prose token (embed cards / voice / pictures) stripped, so a chip
  // never spends the note's character budget — a note carrying a ~2 KB event card is measured on its
  // prose alone, exactly as the relay measures it. An embed- or picture-only body still counts as
  // non-empty.
  const stats = useMemo(
    () =>
      countStats(
        bodyForMeasure(content),
        bodyHasEmbed(content) || extractInlinePictures(content).length > 0,
      ),
    [content],
  );
  // Picture bytes already in THIS unsent body — added to the member's period spend so the allowance
  // gate accounts for pictures already dropped into the post (and self-corrects if one is deleted).
  // `content` holds compact placeholders (MediaRefs), so this is a cheap scan of the SHORT refs —
  // each real weight is read off the media map rather than reassembling the full (≤48 KB/picture)
  // body on every keystroke (see `pendingPictureBytes`).
  const pendingPicBytes = useMemo(
    () => pendingPictureBytes(content, mediaRefs.current),
    [content],
  );
  const write = useMemo(() => {
    if (!bodyOnly) return validateWrite(postKind, stats, limits);
    // bodyOnly: the article word CEILING only — no floor, empty allowed (the field is optional),
    // and over the ceiling BLOCKS (the doc wire clamps hard where an article would only warn).
    if (stats.empty) {
      return {ok: true, state: 'empty' as WriteState, count: 0, denom: limits.articleMax, ratio: 0, msg: `Up to ${limits.articleMax} words`};
    }
    const v = validateWrite('article', stats, {...limits, articleMin: 0});
    if (v.state === 'long') {
      return {...v, ok: false, state: 'over' as WriteState, msg: `${v.count - v.denom} over the ${v.denom}-word limit — shorten`};
    }
    return v.state === 'ok' ? {...v, msg: `${limits.articleMax - stats.words} words left`} : v;
  }, [bodyOnly, postKind, stats, limits]);
  // Inline media (pictures + voice) is exempt from the length meter above, but capped by COUNT:
  // a note carries at most 1, an article the organizer's larger number. Gate Next on it and disable
  // the insert chips at the cap (below) so a body can't exceed what the relay will accept.
  const mediaCount = useMemo(() => countInlineMedia(content), [content]);
  const media = useMemo(() => validateMedia(postKind, mediaCount, limits), [postKind, mediaCount, limits]);
  const atMediaCap = media.max > 0 && mediaCount >= media.max;
  // messageMode's caps: the organizer's LONG-BODY numbers, read raw (0 ⇒ unbounded) rather than
  // through `limits`, whose 2000-word design default would invent a ceiling the relay does not
  // enforce. Surfaced as a one-line advisory, never as a counter — see the render site.
  const universal = useMemo(
    () => validateUniversalBody(stats.words, mediaCount, universalLimits(postRules)),
    [stats.words, mediaCount, postRules],
  );

  const visibleLabels = useMemo(
    () => labels.filter(l => scopeAppliesTo(l.appliesTo, postKind)),
    [labels, postKind],
  );
  const labelRequired = postKind === 'article' && visibleLabels.length > 0;
  const details = validateDetails(postKind, tags, label ?? null, labelRequired);

  const shake = useCallback((v: Animated.Value): void => {
    v.setValue(0);
    Animated.sequence([
      Animated.timing(v, {toValue: 1, duration: 50, useNativeDriver: true}),
      Animated.timing(v, {toValue: -1, duration: 50, useNativeDriver: true}),
      Animated.timing(v, {toValue: 0.6, duration: 50, useNativeDriver: true}),
      Animated.timing(v, {toValue: 0, duration: 50, useNativeDriver: true}),
    ]).start();
  }, []);

  const goToStep = useCallback(
    (next: 1 | 2): void => {
      Keyboard.dismiss();
      setStep(next);
      Animated.timing(slide, {
        toValue: next === 2 ? 1 : 0,
        duration: SLIDE_MS,
        easing: Easing.bezier(0.3, 0.85, 0.3, 1),
        useNativeDriver: true,
      }).start();
    },
    [slide],
  );

  const handleNext = (): void => {
    if (write.ok && media.ok) {
      goToStep(2);
    } else {
      shake(meterShake);
    }
  };

  const handleBack = (): void => goToStep(1);

  // ── tags ────────────────────────────────────────────────────────────────────
  const atTagLimit = tagPolicy.maxTags > 0 && tags.length >= tagPolicy.maxTags;
  const addTagValue = (raw: string): void => {
    const normalized = normalizeTag(raw);
    if (normalized && !tags.includes(normalized) && !atTagLimit) {
      const next = [...tags, normalized];
      setTags(next);
      save({tags: next});
    }
  };
  const addTagFromInput = (): void => {
    addTagValue(tagDraft);
    setTagDraft('');
  };
  const removeTag = (tag: string): void => {
    const next = tags.filter(t => t !== tag);
    setTags(next);
    save({tags: next});
  };
  const onTagKeyPress = (key: string): void => {
    const last = tags[tags.length - 1];
    if (key === 'Backspace' && tagDraft === '' && last) removeTag(last);
  };
  // Suggested tags = the organizer's community tags for this post type that aren't already added.
  const suggestions = useMemo(
    () =>
      tagPolicy.communityTags.filter(
        t => scopeAppliesTo(tagPolicy.tagScopes[t] ?? 'all', postKind) && !tags.includes(t),
      ),
    [tagPolicy, postKind, tags],
  );

  const setLabelChoice = (id: PostLabel): void => {
    const next = label === id ? undefined : id;
    setLabel(next);
    save({label: next});
  };
  const setCw = (on: boolean): void => {
    setCwMode(on);
    save({cw: on && cwText.trim() ? cwText : undefined});
  };

  // ── inserts ─────────────────────────────────────────────────────────────────
  const openLinkDialog = (): void => {
    setLinkTitle('');
    setLinkUrl('');
    setLinkDialogOpen(true);
  };
  const insertLink = (): void => {
    let url = linkUrl.trim();
    if (!url) return;
    if (!/^(https?:\/\/|stiq:)/i.test(url)) url = `https://${url}`;
    const text = linkTitle.trim() || url;
    // The user-reported "Add link says click to add and it won't do anything" bug: `edRef.current?.`
    // used to silently no-op whenever the ref was unavailable, dropping the link with no trace. The
    // ref itself is basically always set here (RichEditor is mounted unconditionally on this screen —
    // there is no non-rich/plain-TextInput fallback body to worry about), but a `?.` guard can still
    // paper over a genuine miss (e.g. an unmount race), so treat "ref missing" the same as "ref wedged"
    // and never let the link vanish: fall back to inserting the markdown form straight into the body.
    // (Ref PRESENT but the WebView not yet 'ready', or its bridge stalled by the delete-then-rewrite
    // race — see RichEditor.tsx — is handled at that lower layer: send() now QUEUES an eager command
    // instead of dropping it, so a normal "tap the instant the composer opens" no longer needs this
    // fallback at all.)
    if (edRef.current) {
      edRef.current.insertLink(text, url);
    } else {
      setContent(c => (c.trim() ? `${c}\n\n[${text}](${url})` : `[${text}](${url})`));
    }
    setLinkDialogOpen(false);
    setLinkTitle('');
    setLinkUrl('');
  };
  const insertSavedEmbed = (postId: string): void => {
    let uri: string;
    try {
      uri = withNostrScheme(nip19.neventEncode({id: postId}));
    } catch {
      setSavedPickerOpen(false);
      return;
    }
    edRef.current?.insertToken(uri);
    setSavedPickerOpen(false);
  };
  /**
   * Insert a saved embed token. A private-sourced token (a post from a private space) gets a one-tap
   * confirm first — its content travels inside the token, so posting it anywhere it can be seen is a
   * deliberate disclosure. Everything else inserts straight away.
   */
  const insertEmbedToken = (uri: string, isPrivate?: boolean): void => {
    setSavedPickerOpen(false);
    if (isPrivate) {
      Alert.alert(
        'Embed from a private space?',
        'This post is from a private space. Its content travels inside the embed — anyone who can see where you post it will be able to read it.',
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Insert anyway', style: 'destructive', onPress: () => edRef.current?.insertToken(uri)},
        ],
      );
      return;
    }
    edRef.current?.insertToken(uri);
  };

  // ── publish ─────────────────────────────────────────────────────────────────
  /**
   * Hand the finished body to onSubmit and CLOSE. There is deliberately no "Posting…" spinner and no
   * "Posted ✓" recap HERE — the confirmation exists, but it cannot live in this screen.
   *
   * The composer does not wait for the write to land: the wiring behind onSubmit renders the post
   * durably into the feed — with its 'sending' ring — before its first await, then draws+signs a
   * blind token over Tor, which can take many seconds. Waiting on that is what made the publish tap
   * hang for seconds while the post already sat in the feed behind the overlay. And a composer that
   * has stopped waiting has no honest way to report an outcome: a success card shown on a write
   * still in flight would claim "live in the community feed" for posts that go on to FAIL. So this
   * screen claims nothing and gets out of the way. Closing instantly is also what the tap should
   * feel like.
   *
   * The user is still TOLD, by the two surfaces that outlive this screen and therefore know the real
   * answer: the feed's durable send indicator ('sending' ring → 'failed' + Retry), and — once the
   * relay has actually taken the post, seconds later — App.tsx's root-level "✓ Posted" Toast, driven
   * off AppSnapshot.postsDelivered. A failure additionally raises App.tsx's one-shot Alert
   * (postFailureAlert). Note what stayed true: nothing in the publish path may re-introduce a
   * foreground wait to fetch that outcome, and no confirmation may be spoken by anything that
   * doesn't have it.
   *
   * The one verdict we DO wait for is a REFUSAL — onSubmit rejects when the write never started
   * (App.tsx's synchronous rate-limit gate, which has already alerted). Nothing was published, so we
   * keep the composer open with its text AND its draft intact and re-arm Publish; closing would
   * silently discard the post. That is why the draft is deleted on the closing path only, never up
   * front. PUBLISH_CEILING_MS bounds this wait.
   */
  const doPublish = (rawBody: string): void => {
    // Reassemble the editor's placeholders back into real base64 media tokens for the published event.
    const body = mediaRefs.current.reassemble(rawBody);
    if (!body.trim() && !title.trim()) { setPublishing(false); return; } // nothing to publish — re-arm
    // Unreachable from the feed/bodyOnly flows, which always wire onSubmit (it is optional in the
    // props ONLY for messageMode, which never reaches this function). Re-arm rather than latch
    // `publishing` forever if a future caller ever gets this wrong.
    if (!onSubmit) { setPublishing(false); return; }
    // The editor's flush ('flushed') fires onChange BEFORE this runs, which re-arms the debounced
    // autosave — cancel it now so a stale save can't later fire against a swapped media map and
    // persist a dangling placeholder (nor resurrect the draft deleted on the closing path below).
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    // Exactly one of {under way, refused, ceiling} may act (the same latch pattern as handlePublish).
    let settled = false;
    const clearCeiling = (): void => {
      if (ceilingTimer.current) { clearTimeout(ceilingTimer.current); ceilingTimer.current = null; }
    };
    const closeUnderWay = (): void => {
      if (settled) return;
      settled = true;
      clearCeiling();
      // Only now is the write actually under way — a refusal must keep the draft (see above).
      void draftStore?.delete(draftId.current);
      onClose();
    };
    ceilingTimer.current = setTimeout(closeUnderWay, PUBLISH_CEILING_MS);
    void Promise.resolve(
      onSubmit(
        body,
        tags,
        title.trim() || undefined,
        label,
        cwMode && cwText.trim() ? cwText.trim() : undefined,
      ),
    ).then(closeUnderWay, () => {
      // Refused before the write started; the caller already told the user why (e.g. "Limit
      // reached"). Keep everything and let them retry.
      if (settled) return;
      settled = true;
      clearCeiling();
      setPublishing(false);
    });
  };

  const handlePublish = (): void => {
    // Guard against double-publish: if a publish is already in flight, return immediately.
    if (publishing) return;

    if (!details.ok) {
      if (!details.tagsOk) shake(tagsShake);
      if (details.labelNeeded && !details.labelOk) shake(labelShake);
      return;
    }
    // Latch BEFORE the flush below, not in doPublish: the flush is an async round-trip, so a second
    // tap inside that window would otherwise pass this guard and start a SECOND publish (each call
    // owns its own `settled` latch, so neither would stop the other). Publishing used to raise a
    // blocking overlay here, which hid that window; closing on publish means nothing else covers it.
    // doPublish re-arms this if the body turns out empty or the write is refused.
    setPublishing(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // The flush round-trips to the RichEditor WebView, which can (a) call back with an EMPTY body
    // if the bridge is mid-race, or (b) never call back at all. Either would silently drop the post
    // — no submit, no Posting overlay. So: fall back to the last debounced editor state (`content`,
    // already known non-empty by the step-1 gate) when the flush is empty, and arm a timeout that
    // publishes that same state if the callback never fires. A `settled` latch makes whichever path
    // wins the only one that submits.
    let settled = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (body: string): void => {
      if (settled) return;
      settled = true;
      if (flushTimer) clearTimeout(flushTimer);
      doPublish(body.trim() ? body : content);
    };
    if (edRef.current) {
      edRef.current.requestMarkdown(finish);
      flushTimer = setTimeout(() => finish(content), 500);
    } else {
      finish(content);
    }
  };

  /**
   * The single-step right pill: flush the editor (same latch as handlePublish) and hand the markdown
   * back, then close.
   *
   * The two modes differ in WHO receives it, and that difference is the whole point:
   *
   *  - `bodyOnly` (the Events description editor) hands the body to `onSubmit`, because the caller
   *    has no other way to collect it — Done IS the apply.
   *
   *  - `messageMode` hands it to `onChangeDraft` and does nothing else. **Done is not Send.** A
   *    message is posted by the classic ↑ button on the composer bubble, exactly as it is for a
   *    message typed without ever opening this editor — so the editor is only ever a bigger way to
   *    WRITE, never a second way to PUBLISH. That keeps one send path per surface (the call sites'
   *    own `send()`, which already handle edit-vs-new, reply targets, token spend, and slot
   *    clearing) instead of two that have to be kept in agreement forever.
   *
   * Consequently messageMode does NOT delete the draft slot here: nothing was sent, and the writing
   * must survive until the bubble actually sends it — or until the next time the editor is opened.
   */
  const handleDone = (): void => {
    let settled = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (raw: string): void => {
      if (settled) return;
      settled = true;
      if (flushTimer) clearTimeout(flushTimer);
      // An empty flush means the bridge raced, not that the user cleared the body — fall back to the
      // last debounced state. A genuinely emptied body still round-tripped through onChangeDraft on
      // the keystroke that emptied it, so the caller already has it.
      const body = mediaRefs.current.reassemble(raw.trim() ? raw : content);
      if (messageMode) onChangeDraft?.(body);
      else void onSubmit?.(body, []);
      onClose();
    };
    if (edRef.current) {
      edRef.current.requestMarkdown(finish);
      flushTimer = setTimeout(() => finish(content), 500);
    } else {
      finish(content);
    }
  };

  const saveDraftNow = (): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    void draftStore?.save({
      id: draftId.current,
      title,
      content: mediaRefs.current.reassemble(content),
      tags,
      label: label ?? null,
      contentWarning: cwMode && cwText.trim() ? cwText.trim() : undefined,
      savedAt: Date.now(),
      location: draftLocation,
    });
  };

  // Long-press "Drafts": flush the current writing to the drafts list immediately (creating or
  // updating in place), then flash "Saved ✓" for a beat. Post mode always owns a DraftStore
  // directly (saveDraftNow). messageMode does too now, WHEN the caller wired one — self-saving is
  // what lets the byline announce "Saved ✓" on its own authority rather than trusting a delegate to
  // have actually flushed something. Only a messageMode caller with no draftStore (no location to
  // key a slot on, e.g. a comment thread) falls back to the pre-Phase-4 `onLongPressDrafts` delegate.
  const handleDraftsLongPress = (): void => {
    if (messageMode && !draftStore) onLongPressDrafts?.();
    else saveDraftNow();
    setJustSaved(true);
    if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    savedFlashTimer.current = setTimeout(() => { setJustSaved(false); savedFlashTimer.current = null; }, 1500);
  };

  const handleCancel = (): void => {
    if (messageMode) {
      // Every keystroke already round-tripped through onChangeDraft (handleContentChange) into the
      // caller's own draft state / autosave slot — nothing is lost by closing immediately, so unlike
      // plain bodyOnly there is no confirm here (matches the retired FullMessageEditor's Cancel).
      onClose();
      return;
    }
    if (bodyOnly) {
      // No draft store in this mode — the caller holds the value; Done is the only way to apply.
      if (content === initialContentRef.current) {
        onClose();
        return;
      }
      Alert.alert('Discard changes?', 'Your edits will be lost.', [
        {text: 'Discard', style: 'destructive', onPress: onClose},
        {text: 'Keep writing', style: 'cancel'},
      ]);
      return;
    }
    const dirty = title.trim().length > 0 || content.trim().length > 0;
    if (!dirty || !draftStore) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      onClose();
      return;
    }
    Alert.alert('Discard this post?', 'Save it as a draft or discard it.', [
      {text: 'Save as draft', onPress: () => { saveDraftNow(); onClose(); }},
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          void draftStore?.delete(draftId.current);
          onClose();
        },
      },
      {text: 'Keep writing', style: 'cancel'},
    ]);
  };

  // ── organizer rules banner + block sheet ────────────────────────────────────
  // Collapsing the banner (via ⓘ) records the covenant version as seen, so it stays tucked until
  // the organizer publishes a new version (the community_rules "first visit" contract).
  const toggleRules = (): void => {
    if (rulesOpen && postingGuidelines) markGuidelinesSeen(guidelinesSeenKey, postingGuidelines.version);
    setRulesOpen(!rulesOpen);
  };
  const pickBlock = (cmd: RichEditorCommand): void => {
    setBlockSheetOpen(false);
    edRef.current?.cmd(cmd);
  };
  const renderBlockRow = (row: BlockRowDef): React.JSX.Element => {
    const current = curBlock === row.block;
    return (
      <Press key={row.block} variant="row" style={s.blockRow} onPress={() => pickBlock(row.cmd)} accessibilityLabel={row.label}>
        <Text style={[s.blockGlyph, row.serifGlyph && s.blockGlyphSerif, current && s.blockGlyphOn]}>{row.glyph}</Text>
        <Text style={[s.blockLabel, current && s.blockLabelOn]}>{row.label}</Text>
        {row.note ? <Text style={s.blockNote}>{row.note}</Text> : null}
        {current ? <Text style={s.blockCheck}>✓</Text> : null}
      </Press>
    );
  };

  const titleDir = paragraphAlign(title);
  // messageMode's pill is DONE, not Send — it dismisses back to the composer bubble with the draft
  // synced, and the bubble's ↑ does the posting (see handleDone). So it gates on nothing: an empty
  // body is a legitimate Done (the writer cleared it), and the bubble's ↑ already refuses to send
  // empty. Gating it on non-empty would trap someone who deleted everything behind a dead pill with
  // no way out but Cancel. The organizer's caps are surfaced as an advisory below the editor rather
  // than by disabling this, since they are the relay's rule to enforce, not a reason to strand a
  // draft inside a modal.
  const rightEnabled = messageMode
    ? true
    : step === 1 ? write.ok && media.ok : details.ok && !publishing;
  // A per-user seed for the byline's fallback gradient (when myGradient is unset) — without it every
  // un-gradiented user renders the identical fallback swatch (gradientFromSeed is deterministic).
  const mySeed = myPubkey ? safeNpubEncode(myPubkey) : 'me';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={step === 1 ? handleCancel : handleBack}>
      <SafeAreaView style={s.page}>
        {/* ── Nav bar: one left button, a centered title, one right pill ── */}
        <View style={s.header}>
          <Press onPress={step === 1 ? handleCancel : handleBack} hitSlop={10} style={s.headerSide}>
            <Text style={s.headerLeft}>{step === 1 ? 'Cancel' : '‹ Back'}</Text>
          </Press>
          <Text style={s.headerTitle}>
            {bodyOnly ? headerTitle ?? 'Write' : step === 2 ? 'Post details' : postKind === 'article' ? 'New article' : 'New post'}
          </Text>
          <View style={[s.headerSide, s.headerRight]}>
            <Press
              style={[s.pill, !rightEnabled && s.pillDisabled]}
              onPress={bodyOnly ? handleDone : step === 1 ? handleNext : handlePublish}
              disabled={!rightEnabled}
              hitSlop={10}>
              {/* messageMode is always 'Done' — a caller cannot relabel it 'Send'/'Save', because it
                  does not send (handleDone). Only plain bodyOnly honours an override. */}
              <Text style={s.pillText}>
                {messageMode ? 'Done' : bodyOnly ? submitLabel ?? 'Done' : step === 1 ? 'Next' : 'Publish'}
              </Text>
            </Press>
          </View>
        </View>

        {/* ── Byline: who & where + a Drafts entry ── */}
        {displayByline && <View style={s.byline}>
          <GradientAvatar
            gradient={space ? space.gradient : myGradient}
            seed={space ? space.name : mySeed}
            size={28}
            shape={space?.shape}
          />
          <Text style={s.bylineText} numberOfLines={1}>
            {bylineVerb} <Text style={s.bylineStrong}>{space ? space.name : communityName ?? 'the community'}</Text>
          </Text>
          <View style={s.flex} />
          {postingGuidelines && (
            <Press
              onPress={toggleRules}
              hitSlop={12}
              accessibilityLabel="Community rules"
              style={[s.rulesInfo, rulesOpen && s.rulesInfoOn]}>
              <Text style={[s.rulesInfoGlyph, rulesOpen && s.rulesInfoGlyphOn]}>i</Text>
            </Press>
          )}
          {onOpenDrafts && (draftStore || messageMode) && (
            <Press
              onPress={onOpenDrafts}
              onLongPress={handleDraftsLongPress}
              delayLongPress={500}
              accessibilityLabel="view drafts">
              <Text style={s.draftsLink}>{justSaved ? 'Saved ✓' : 'Drafts'}</Text>
            </Press>
          )}
        </View>}

        {promoteNote && (
          <View style={s.promoteNote}>
            <Text style={s.promoteNoteText}>💬 {promoteNote}</Text>
          </View>
        )}

        {/* ── The two steps in a 200%-wide track that slides horizontally ── */}
        <View style={s.stepsClip}>
          <Animated.View
            style={[
              s.stepsTrack,
              {width: W * 2, transform: [{translateX: slide.interpolate({inputRange: [0, 1], outputRange: [0, -W]})}]},
            ]}>
            {/* ── Step 1 — Write ── */}
            <View style={{width: W}}>
              <KeyboardAvoidingView
                style={s.flex}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <ScrollView
                  style={s.flex}
                  contentContainerStyle={s.writeScroll}
                  keyboardShouldPersistTaps="handled">
                  {/* Organizer rules banner — auto-open on first visit / new covenant version, then
                      tucked behind the byline's ⓘ. Content is the organizer-signed guidelines doc. */}
                  {postingGuidelines && rulesOpen && (
                    <View style={s.rulesCard}>
                      <View style={s.rulesHead}>
                        <Text style={s.rulesHeadTitle}>RULES OF THIS SPACE</Text>
                        <Text style={s.rulesHeadVer}>
                          covenant v{postingGuidelines.version} · {shortDate(postingGuidelines.updatedAt)}
                        </Text>
                      </View>
                      {(postingGuidelines.blurb.length > 0
                        ? postingGuidelines.blurb
                        : postingGuidelines.sections[0]?.items ?? []
                      ).map((line, i) => (
                        <View key={i} style={s.rulesItem}>
                          <Text style={s.rulesDot}>·</Text>
                          <Text style={s.rulesItemText}>{line}</Text>
                        </View>
                      ))}
                      <View style={s.rulesFoot}>
                        {postingGuidelines.sections.length > 0 ? (
                          <Press onPress={() => setCovenantOpen(true)} accessibilityLabel="Read the full covenant">
                            <Text style={s.rulesLink}>Read the full covenant ›</Text>
                          </Press>
                        ) : (
                          <View />
                        )}
                        <Text style={s.rulesBy}>set by the organizers</Text>
                      </View>
                    </View>
                  )}
                  {!bodyOnly && <TextInput
                    style={[s.titleInput, titleDir]}
                    placeholder="Title"
                    placeholderTextColor={colors.textMuted}
                    value={title}
                    onChangeText={handleTitleChange}
                    onFocus={() => setTitleFocused(true)}
                    onBlur={() => setTitleFocused(false)}
                    returnKeyType="next"
                  />}
                  {postKind === 'note' && titleFocused && (
                    <Text style={s.titleHint}>Leave blank for a quick note — type a title to write an article.</Text>
                  )}
                  <RichEditor
                    ref={edRef}
                    value={content}
                    onChange={handleContentChange}
                    placeholder={
                      bodyPlaceholder ??
                      (messageMode ? 'Write a message…' : postKind === 'article' ? 'Write your article…' : 'Share an idea with the community…')
                    }
                    minHeight={220}
                    maxHeight={Math.round(Dimensions.get('window').height * 0.5)}
                    onRequestLink={openLinkDialog}
                    onRequestBlockSheet={() => setBlockSheetOpen(true)}
                    onBlockState={setCurBlock}
                    // Chromeless body (no box) with the text aligned to the title's gutter — the
                    // ScrollView already provides the 16px left inset, so the editor pads 0 on X.
                    bordered={false}
                    theme={{padX: 0}}
                  />
                </ScrollView>

                {/* Size-rule meter — pinned under the writing area, gates Next. Hidden in messageMode:
                    a chat message isn't an article and was never word-ceilinged (rightEnabled above
                    already gates Send on non-empty + media caps only, matching the retired
                    FullMessageEditor's canSend). */}
                {!messageMode && <Animated.View
                  style={[
                    s.meter,
                    {transform: [{translateX: meterShake.interpolate({inputRange: [-1, 1], outputRange: [-6, 6]})}]},
                  ]}>
                  <View style={s.meterChip}>
                    <Text style={s.meterChipText}>{bodyOnly ? 'TEXT' : postKind === 'article' ? 'ARTICLE' : 'NOTE'}</Text>
                  </View>
                  <View style={s.meterTrack}>
                    <View
                      style={[
                        s.meterFill,
                        {width: `${Math.round(Math.max(0, Math.min(1, write.ratio)) * 100)}%`, backgroundColor: METER_TRACK[write.state]},
                      ]}
                    />
                  </View>
                  <Text
                    style={[s.meterMsg, write.state !== 'empty' && {color: METER_TRACK[write.state]}]}
                    numberOfLines={1}>
                    {write.msg}
                  </Text>
                  <Text style={[s.meterCount, write.state === 'over' && {color: colors.danger}]}>
                    <Text style={s.meterCountNum}>{write.count}</Text> / {write.denom}
                  </Text>
                </Animated.View>}

                {/* Insert bar (v2) — a row of equal icon chips + a right-anchored undo/redo history
                    group behind a hairline rule. Tools live HERE, never in the nav bar. Aa opens the
                    block-style sheet (Heading/Subheading/quote + the v2 blocks fold there); Paste
                    stays (reads the OS clipboard at the caret — the bubble's Paste needs a
                    selection, this works any time); audio/picture keep their organizer gating. Our
                    icon language: emoji via <Icon>, text symbols (Aa ▦ ↺ ↻) as plain <Text>. */}
                <View style={s.insertBar}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyboardShouldPersistTaps="always"
                    contentContainerStyle={s.insertScroll}>
                    <Press style={s.insertChip} accessibilityLabel="Text style" onPress={() => setBlockSheetOpen(true)}>
                      <Text style={s.insertAa}>Aa</Text>
                    </Press>
                    <Press style={s.insertChip} accessibilityLabel="Insert link" onPress={openLinkDialog}>
                      <Icon name="🔗" size={19} />
                    </Press>
                    <Press style={s.insertChip} accessibilityLabel="Embed a saved post" onPress={() => setSavedPickerOpen(true)}>
                      <Icon name="🔖" size={19} />
                    </Press>
                    {pictureRules.allow && (
                      <Press
                        style={s.insertChip}
                        accessibilityLabel="Add picture"
                        disabled={atMediaCap}
                        onPress={() => setPictureOpen(true)}>
                        <Icon name="🖼️" size={19} />
                      </Press>
                    )}
                    {allowVoice && (
                      <Press
                        style={s.insertChip}
                        accessibilityLabel="Record audio"
                        disabled={atMediaCap}
                        onPress={() => setVoiceOpen(true)}>
                        <Icon name="🎙️" size={19} />
                      </Press>
                    )}
                    <Press style={s.insertChip} accessibilityLabel="Insert table" onPress={() => edRef.current?.cmd('table')}>
                      <Text style={s.insertGlyph}>▦</Text>
                    </Press>
                    <Press style={s.insertChip} accessibilityLabel="Paste from clipboard" onPress={() => edRef.current?.paste()}>
                      <Icon name="📋" size={19} />
                    </Press>
                  </ScrollView>
                  <View style={s.insertHist}>
                    <Press style={s.insertChip} accessibilityLabel="Undo" onPress={() => edRef.current?.cmd('undo')}>
                      <Text style={s.histGlyph}>↺</Text>
                    </Press>
                    <Press style={s.insertChip} accessibilityLabel="Redo" onPress={() => edRef.current?.cmd('redo')}>
                      <Text style={s.histGlyph}>↻</Text>
                    </Press>
                  </View>
                </View>
                {/* Media-cap hint: pictures/voice don't count toward the length meter, but a post
                    carries at most `media.max` of them (1 per note, the organizer's number per
                    article). Show the cap; turn it red once the body is over it. */}
                {!messageMode && media.max > 0 && (media.error !== '' || atMediaCap) && (
                  <Text style={[s.mediaHint, !media.ok && {color: colors.danger}]} numberOfLines={1}>
                    {media.ok ? media.hint : media.error}
                  </Text>
                )}
                {/* messageMode: the organizer's caps still apply — they are the relay's rule — but
                    they are never narrated while writing. No meter, no "n / max", no words-left. One
                    quiet line appears only once the body is ACTUALLY over, and in a default community
                    (both caps 0) it never appears at all. */}
                {messageMode && !universal.ok && (
                  <Text style={[s.mediaHint, {color: colors.danger}]} numberOfLines={2}>
                    {universal.msg}
                  </Text>
                )}
              </KeyboardAvoidingView>
            </View>

            {/* ── Step 2 — Details ── */}
            <View style={{width: W}}>
              <ScrollView style={s.flex} contentContainerStyle={s.detailsScroll} keyboardShouldPersistTaps="handled">
                {/* Preview recap card */}
                <View style={s.preview}>
                  <Text style={s.previewEyebrow}>{postKind === 'article' ? 'ARTICLE' : 'NOTE'}</Text>
                  {postKind === 'article' && !!title.trim() && (
                    <Text style={[s.previewTitle, titleDir]} numberOfLines={2}>{title.trim()}</Text>
                  )}
                  <Text style={s.previewSnippet} numberOfLines={3}>
                    {previewText(content) || 'Your post preview appears here.'}
                  </Text>
                </View>

                {/* Label — hidden for Notes; shown & required for Articles. */}
                {postKind === 'article' && visibleLabels.length > 0 && (
                  <Animated.View
                    style={[
                      s.det,
                      {transform: [{translateX: labelShake.interpolate({inputRange: [-1, 1], outputRange: [-6, 6]})}]},
                    ]}>
                    <View style={s.detHead}>
                      <Text style={s.detEyebrow}>LABEL</Text>
                      <Text style={[s.detReq, label ? s.detOk : null]}>{label ? '✓ Labelled' : 'Required'}</Text>
                    </View>
                    <View style={s.chipWrap}>
                      {visibleLabels.map(l => {
                        const meta = labelMetaFor(l.id, labels);
                        const active = label === l.id;
                        const dim = !!label && !active;
                        return (
                          <Press
                            key={l.id}
                            onPress={() => setLabelChoice(l.id)}
                            style={[
                              s.labelChip,
                              {borderColor: meta.color},
                              active && {backgroundColor: meta.bg, borderColor: meta.color},
                              dim && s.chipDim,
                            ]}>
                            <Text style={[s.labelChipText, {color: meta.color}]}>{meta.text}</Text>
                          </Press>
                        );
                      })}
                    </View>
                    {!label && (
                      <Text style={s.detHint}>Articles need a label so readers know what kind of post this is.</Text>
                    )}
                  </Animated.View>
                )}

                {/* Tags — always required (≥1), with tap-to-add suggestions. */}
                <Animated.View
                  style={[
                    s.det,
                    {transform: [{translateX: tagsShake.interpolate({inputRange: [-1, 1], outputRange: [-6, 6]})}]},
                  ]}>
                  <View style={s.detHead}>
                    <Text style={s.detEyebrow}>TAGS</Text>
                    <Text style={[s.detReq, details.tagsOk ? s.detOk : null]}>
                      {details.tagsOk ? '✓ Tagged' : 'Required · at least one'}
                    </Text>
                  </View>
                  {tags.length > 0 && (
                    <View style={s.chipWrap}>
                      {tags.map(tag => (
                        <Press key={tag} style={s.tagChip} onPress={() => removeTag(tag)} accessibilityLabel={`remove ${tag}`}>
                          <Text style={s.tagChipText}>#{tag}</Text>
                          <Text style={s.tagChipX}>✕</Text>
                        </Press>
                      ))}
                    </View>
                  )}
                  {(tagPolicy.allowMemberTags || tags.length === 0) && (
                    <View style={s.tagInputRow}>
                      <TextInput
                        style={[s.tagInput, paragraphAlign(tagDraft)]}
                        placeholder="Add a tag…"
                        placeholderTextColor={colors.textMuted}
                        value={tagDraft}
                        onChangeText={setTagDraft}
                        onSubmitEditing={addTagFromInput}
                        onKeyPress={e => onTagKeyPress(e.nativeEvent.key)}
                        editable={tagPolicy.allowMemberTags && !atTagLimit}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="done"
                      />
                      <Press
                        style={[s.tagAdd, (!tagPolicy.allowMemberTags || atTagLimit) && s.pillDisabled]}
                        onPress={addTagFromInput}
                        disabled={!tagPolicy.allowMemberTags || atTagLimit}
                        accessibilityLabel="add tag">
                        <Text style={s.tagAddText}>+</Text>
                      </Press>
                    </View>
                  )}
                  {suggestions.length > 0 && (
                    <>
                      <Text style={s.suggestLabel}>SUGGESTED</Text>
                      <View style={s.chipWrap}>
                        {suggestions.map(tag => (
                          <Press key={tag} style={s.suggestChip} onPress={() => addTagValue(tag)} disabled={atTagLimit}>
                            <Text style={s.suggestChipText}>+ {tag}</Text>
                          </Press>
                        ))}
                      </View>
                    </>
                  )}
                  {!details.tagsOk && (
                    <Text style={s.detHint}>Add at least one topic tag so people can find this post.</Text>
                  )}
                </Animated.View>

                {/* Content warning */}
                <View style={s.cwRow}>
                  <View style={s.flex}>
                    <Text style={s.cwTitle}>⚠️ Content warning</Text>
                    <Text style={s.cwSub}>Blur this post behind a tap-to-reveal notice.</Text>
                  </View>
                  <Switch
                    value={cwMode}
                    onValueChange={setCw}
                    trackColor={{false: colors.surfaceHover, true: colors.accent}}
                    thumbColor={colors.onAccent}
                    accessibilityRole="switch"
                  />
                </View>
                {cwMode && (
                  <TextInput
                    style={[s.cwInput, paragraphAlign(cwText)]}
                    placeholder="Describe the warning (e.g. spoilers)"
                    placeholderTextColor={colors.textMuted}
                    value={cwText}
                    onChangeText={t => { setCwText(t); save({cw: t.trim() ? t : undefined}); }}
                    returnKeyType="done"
                  />
                )}
              </ScrollView>
            </View>
          </Animated.View>
        </View>

        {/* No publish overlay: publishing closes this screen immediately and the feed's durable send
            indicator reports the real outcome. A "Posting…" spinner would only re-block the tap, and
            a "Posted ✓" recap HERE would be a claim we can't back up — this screen never learns the
            outcome. The confirmation is App.tsx's Toast, which does. See doPublish. */}

        {/* ── Inline voice recorder — the sent clip embeds as an atomic chip in the body. ── */}
        {allowVoice && (
          <VoiceComposer
            visible={voiceOpen}
            onClose={() => setVoiceOpen(false)}
            onSend={voice => {
              edRef.current?.insertToken(mediaRefs.current.toPlaceholder(encodeInlineVoice(voice)));
              setVoiceOpen(false);
            }}
          />
        )}

        {/* ── Add-a-picture flow — the framed pixel-art embeds as an atomic chip in the body. ── */}
        {pictureRules.allow && (
          <PictureComposer
            visible={pictureOpen}
            onClose={() => setPictureOpen(false)}
            rules={pictureRules}
            spentBytes={pictureSpentBytes + pendingPicBytes}
            onAdd={token => edRef.current?.insertToken(mediaRefs.current.toPlaceholder(token))}
          />
        )}

        {/* ── Block-style sheet — opened by Aa (insert-bar chip or the bubble's style button).
            TEXT: Body / Heading(H2) / Subheading(H3) / Blockquote / Pullquote / Footer;
            LISTS: Bullet / Numbered / Task / Details. The caret's block carries a ✓. ── */}
        <Modal visible={blockSheetOpen} transparent animationType="fade" onRequestClose={() => setBlockSheetOpen(false)}>
          <Press variant="bare" style={s.savedBack} onPress={() => setBlockSheetOpen(false)} accessibilityRole="none">
            <Press variant="bare" style={s.blockSheet} onPress={() => {}} accessibilityRole="none">
              <View style={s.blockGrab} />
              <Text style={s.blockSheetTitle}>Block style</Text>
              <Text style={s.blockGroup}>TEXT</Text>
              {BLOCK_ROWS_TEXT.map(renderBlockRow)}
              <Text style={s.blockGroup}>LISTS</Text>
              {BLOCK_ROWS_LIST.map(renderBlockRow)}
              <Press style={s.blockCancel} onPress={() => setBlockSheetOpen(false)}>
                <Text style={s.blockCancelText}>Cancel</Text>
              </Press>
            </Press>
          </Press>
        </Modal>

        {/* ── Community covenant sheet — versioned, human-readable, with the last-change diff. ── */}
        {postingGuidelines && (
          <Modal visible={covenantOpen} transparent animationType="slide" onRequestClose={() => setCovenantOpen(false)}>
            <Press variant="bare" style={s.savedBack} onPress={() => setCovenantOpen(false)} accessibilityRole="none">
              <Press variant="bare" style={s.covSheet} onPress={() => {}} accessibilityRole="none">
                <View style={s.blockGrab} />
                <Text style={s.blockSheetTitle}>Community covenant</Text>
                <View style={s.covMeta}>
                  <Text style={s.covVer}>v{postingGuidelines.version}</Text>
                  <Text style={s.covDate}>updated {shortDate(postingGuidelines.updatedAt)} by the organizers</Text>
                </View>
                <ScrollView style={s.covScroll}>
                  {postingGuidelines.sections.map((sec, si) => (
                    <View key={si} style={s.covSec}>
                      <Text style={s.covSecH}>{sec.heading.toUpperCase()}</Text>
                      {sec.items.map((item, ii) => (
                        <View key={ii} style={s.rulesItem}>
                          <Text style={s.rulesDot}>·</Text>
                          <Text style={s.covItemText}>{item}</Text>
                        </View>
                      ))}
                    </View>
                  ))}
                  {postingGuidelines.diff && (
                    <View style={s.covSec}>
                      <Text style={s.covSecH}>WHAT CHANGED IN V{postingGuidelines.version}</Text>
                      <View style={s.covDiff}>
                        <Text style={s.covDiffHead}>
                          v{postingGuidelines.diff.from} → v{postingGuidelines.version} · {shortDate(postingGuidelines.updatedAt)} · announced to all members
                        </Text>
                        {postingGuidelines.diff.rows.map((row, ri) => (
                          <View key={ri} style={s.covDiffRow}>
                            <Text style={[s.covDiffSign, row.sign === '+' ? s.covDiffAdd : s.covDiffChg]}>{row.sign}</Text>
                            <Text style={s.covDiffText}>{row.text}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  )}
                </ScrollView>
                <Press style={s.blockCancel} onPress={() => setCovenantOpen(false)}>
                  <Text style={s.blockCancelText}>Close</Text>
                </Press>
              </Press>
            </Press>
          </Modal>
        )}

        {/* ── Embed picker — tap a saved post to insert it as a reference ── */}
        <Modal visible={savedPickerOpen} transparent animationType="fade" onRequestClose={() => setSavedPickerOpen(false)}>
          <Press variant="bare" style={s.savedBack} onPress={() => setSavedPickerOpen(false)} accessibilityRole="none">
            <Press variant="bare" style={s.savedSheet} onPress={() => {}} accessibilityRole="none">
              <View style={s.savedHead}>
                <Text style={s.savedHeadTitle}>EMBED · TAP TO INSERT</Text>
                <Text style={s.savedHeadNum}>
                  {savedPosts.length + savedEmbedTokens.length ? `${savedPosts.length + savedEmbedTokens.length} saved` : ''}
                </Text>
              </View>
              <ScrollView style={s.savedList}>
                {savedEmbedTokens.map(se => (
                  <View key={se.id} style={s.savedRow}>
                    <Press
                      variant="row"
                      style={s.savedRowMain}
                      onPress={() => insertEmbedToken(se.uri, se.private)}>
                      <Text style={s.savedKind}>{se.label}</Text>
                      <Text style={s.savedTitle} numberOfLines={1}>{se.title}</Text>
                    </Press>
                    {onRemoveSavedToken && (
                      <Press style={s.savedRemove} onPress={() => onRemoveSavedToken(se.id)} accessibilityLabel="remove-saved-embed">
                        <Text style={s.savedRemoveText}>✕</Text>
                      </Press>
                    )}
                  </View>
                ))}
                {savedPosts.length === 0 && savedEmbedTokens.length === 0 ? (
                  <Text style={s.savedEmpty}>Nothing saved yet.{'\n'}Save any post from its ⋯ menu, or add an event card from its Share sheet.</Text>
                ) : (
                  savedPosts.map(sp => (
                    <View key={sp.id} style={s.savedRow}>
                      <Press variant="row" style={s.savedRowMain} onPress={() => insertSavedEmbed(sp.id)}>
                        <Text style={s.savedKind}>Referenced post <Text style={s.savedWhere}>· in the community</Text></Text>
                        <Text style={s.savedTitle} numberOfLines={1}>{sp.title}</Text>
                        <Text style={s.savedSnip} numberOfLines={1}>{sp.snippet}</Text>
                      </Press>
                      {onRemoveSaved && (
                        <Press style={s.savedRemove} onPress={() => onRemoveSaved(sp.id)} accessibilityLabel="remove-saved">
                          <Text style={s.savedRemoveText}>✕</Text>
                        </Press>
                      )}
                    </View>
                  ))
                )}
              </ScrollView>
              <Press style={s.savedDone} onPress={() => setSavedPickerOpen(false)}>
                <Text style={s.savedDoneText}>Done</Text>
              </Press>
            </Press>
          </Press>
        </Modal>

        {/* ── Link dialog: URL + optional text ── */}
        <Modal visible={linkDialogOpen} transparent animationType="fade" onRequestClose={() => setLinkDialogOpen(false)}>
          <Press variant="bare" style={s.linkOverlay} onPress={() => setLinkDialogOpen(false)} accessibilityRole="none">
            <Press variant="bare" style={s.linkDialog} onPress={() => {}} accessibilityRole="none">
              <Text style={s.linkDialogTitle}>Add link</Text>
              <TextInput
                style={s.linkDialogInput}
                placeholder="https://…  or  stiq:…"
                placeholderTextColor={colors.textMuted}
                value={linkUrl}
                onChangeText={setLinkUrl}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <TextInput
                style={[s.linkDialogInput, paragraphAlign(linkTitle)]}
                placeholder="Text (optional) — what it says"
                placeholderTextColor={colors.textMuted}
                value={linkTitle}
                onChangeText={setLinkTitle}
              />
              <View style={s.linkActions}>
                <Press style={[s.linkBtn, s.linkCancel]} onPress={() => setLinkDialogOpen(false)}>
                  <Text style={s.linkCancelText}>Cancel</Text>
                </Press>
                <Press style={[s.linkBtn, s.linkAdd, !linkUrl.trim() && s.pillDisabled]} disabled={!linkUrl.trim()} onPress={insertLink}>
                  <Text style={s.linkAddText}>Add link</Text>
                </Press>
              </View>
            </Press>
          </Press>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  page: {flex: 1, backgroundColor: colors.bg},
  flex: {flex: 1},

  // Nav bar
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerSide: {minWidth: 78, justifyContent: 'center'},
  headerRight: {alignItems: 'flex-end'},
  headerLeft: {fontSize: 16, fontWeight: '400', color: colors.textSecondary},
  headerTitle: {flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600', color: colors.textPrimary},
  pill: {backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 8},
  pillDisabled: {backgroundColor: colors.surfaceHover, opacity: 0.65},
  pillText: {fontSize: 14, fontWeight: '600', color: colors.onAccent},

  // Byline
  byline: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4},
  bylineText: {fontSize: 14, color: colors.textMuted, flexShrink: 1},
  bylineStrong: {color: colors.textSecondary, fontWeight: '600'},
  draftsLink: {fontSize: 14, fontWeight: '600', color: colors.accent},

  promoteNote: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  promoteNoteText: {fontSize: 13, color: colors.textSecondary, lineHeight: 18},

  // Steps track
  stepsClip: {flex: 1, overflow: 'hidden'},
  stepsTrack: {flexDirection: 'row', flex: 1},

  // Write step
  writeScroll: {paddingHorizontal: 16, paddingTop: 6, paddingBottom: 12},
  titleInput: {fontSize: 25, fontWeight: '700', lineHeight: 31, color: colors.textPrimary, paddingTop: 10, paddingBottom: 8},
  titleHint: {fontSize: 12.5, color: colors.textMuted, marginBottom: 8, lineHeight: 17},

  // Meter
  meter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  meterChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceHover,
  },
  meterChipText: {fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8, color: colors.textSecondary},
  meterTrack: {width: 64, height: 4, borderRadius: 2, backgroundColor: colors.surfaceHover, overflow: 'hidden'},
  meterFill: {height: 4, borderRadius: 2},
  meterMsg: {flex: 1, fontSize: 11.5, color: colors.textMuted},
  meterCount: {fontSize: 12.5, color: colors.textSecondary},
  meterCountNum: {fontWeight: '700', color: colors.textPrimary},

  // Insert bar
  insertBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  // Icon-only chips: square-ish, centered, comfortable 36px touch target. The left group scrolls
  // when narrow; the history group is flex-none behind a hairline so undo/redo never scroll away.
  insertScroll: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 8},
  insertChip: {
    minWidth: 44,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  insertChipDisabled: {opacity: 0.35},
  insertAa: {fontSize: 15, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.3},
  insertGlyph: {fontSize: 17, color: colors.textPrimary, lineHeight: 20},
  insertHist: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 8, borderLeftWidth: 1, borderLeftColor: colors.border},
  histGlyph: {fontSize: 18, color: colors.textSecondary, lineHeight: 21},
  mediaHint: {fontSize: 11, color: colors.textMuted, paddingHorizontal: 16, paddingTop: 6},

  // ⓘ community-rules button (byline) — 22px circle, italic serif glyph; ≥44px hit area via hitSlop.
  rulesInfo: {width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.textMuted, alignItems: 'center', justifyContent: 'center'},
  rulesInfoOn: {borderColor: colors.accent, backgroundColor: colors.accentSoft},
  rulesInfoGlyph: {fontFamily: fonts.serif, fontStyle: 'italic', fontWeight: '700', fontSize: 12, color: colors.textMuted, lineHeight: 15},
  rulesInfoGlyphOn: {color: colors.link},

  // Rules banner card (the organizer's blurb) — first child of the write scroll.
  rulesCard: {borderWidth: 1, borderColor: colors.border, borderRadius: 14, backgroundColor: colors.surfaceAlt, padding: 13, marginTop: 6, marginBottom: 8},
  rulesHead: {flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8},
  rulesHeadTitle: {fontSize: 11, fontWeight: '700', letterSpacing: 0.8, color: colors.textSecondary},
  rulesHeadVer: {fontFamily: fonts.mono, fontSize: 10.5, color: colors.textMuted},
  rulesItem: {flexDirection: 'row', gap: 8, marginBottom: 5},
  rulesDot: {color: colors.accent, fontWeight: '700', lineHeight: 19},
  rulesItemText: {flex: 1, fontSize: 13, lineHeight: 19, color: colors.textSecondary},
  rulesFoot: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 4},
  rulesLink: {fontSize: 12.5, fontWeight: '600', color: colors.link},
  rulesBy: {fontSize: 11, color: colors.textMuted},

  // Block-style sheet (Aa) — the folded block vocabulary.
  blockSheet: {backgroundColor: colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderColor: colors.borderLight, paddingHorizontal: 12, paddingBottom: 16},
  blockGrab: {width: 38, height: 4, borderRadius: 2, backgroundColor: colors.borderLight, alignSelf: 'center', marginTop: 9, marginBottom: 4},
  blockSheetTitle: {textAlign: 'center', fontSize: 15, fontWeight: '600', color: colors.textPrimary, paddingTop: 4, paddingBottom: 12},
  blockGroup: {fontSize: 10, fontWeight: '700', letterSpacing: 0.8, color: colors.textMuted, paddingHorizontal: 11, paddingTop: 10, paddingBottom: 7},
  blockRow: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 9, paddingHorizontal: 11, borderRadius: 10},
  blockGlyph: {width: 24, textAlign: 'center', color: colors.textMuted, fontSize: 14},
  blockGlyphSerif: {fontFamily: fonts.serif, fontSize: 16},
  blockGlyphOn: {color: colors.accent},
  blockLabel: {flex: 1, fontSize: 15, color: colors.textPrimary},
  blockLabelOn: {fontWeight: '600'},
  blockNote: {fontSize: 11.5, color: colors.textMuted},
  blockCheck: {color: colors.accent, fontSize: 13},
  blockCancel: {marginTop: 12, paddingVertical: 13, borderRadius: 13, backgroundColor: colors.surfaceAlt, alignItems: 'center'},
  blockCancelText: {fontSize: 15, fontWeight: '600', color: colors.textPrimary},

  // Covenant sheet.
  covSheet: {backgroundColor: colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderColor: colors.borderLight, paddingHorizontal: 12, paddingBottom: 16, maxHeight: '78%'},
  covMeta: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingBottom: 12},
  covVer: {fontFamily: fonts.mono, fontSize: 11, color: colors.textSecondary, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3},
  covDate: {fontSize: 12, color: colors.textMuted},
  covScroll: {paddingHorizontal: 6},
  covSec: {paddingVertical: 12, paddingHorizontal: 2, borderTopWidth: 1, borderTopColor: colors.border},
  covSecH: {fontSize: 11, fontWeight: '700', letterSpacing: 0.8, color: colors.textSecondary, marginBottom: 8},
  covItemText: {flex: 1, fontSize: 13.5, lineHeight: 21, color: colors.textSecondary},
  covDiff: {marginTop: 9, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surfaceAlt, paddingHorizontal: 12, paddingVertical: 10},
  covDiffHead: {fontFamily: fonts.mono, fontSize: 10.5, color: colors.textMuted, marginBottom: 6},
  covDiffRow: {flexDirection: 'row', gap: 8, marginBottom: 3},
  covDiffSign: {fontFamily: fonts.mono, fontWeight: '700', fontSize: 12.5},
  covDiffAdd: {color: colors.success},
  covDiffChg: {color: colors.warning},
  covDiffText: {flex: 1, fontSize: 12.5, lineHeight: 19, color: colors.textSecondary},

  // Details step
  detailsScroll: {paddingHorizontal: 16, paddingTop: 12, paddingBottom: 48},
  preview: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceAlt,
    padding: 14,
    marginBottom: 20,
  },
  previewEyebrow: {fontSize: 10, fontWeight: '800', letterSpacing: 0.9, color: colors.textMuted},
  previewTitle: {fontSize: 17, fontWeight: '700', color: colors.textPrimary, marginTop: 6, lineHeight: 22},
  previewSnippet: {fontSize: 13.5, color: colors.textSecondary, marginTop: 6, lineHeight: 19},

  det: {marginBottom: 22},
  detHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10},
  detEyebrow: {fontSize: 11, fontWeight: '700', letterSpacing: 0.9, color: colors.textSecondary},
  detReq: {fontSize: 12, fontWeight: '500', color: colors.textMuted},
  detOk: {color: colors.success, fontWeight: '600'},
  detHint: {fontSize: 12, color: colors.textMuted, marginTop: 10, lineHeight: 17},

  chipWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chipDim: {opacity: 0.4},
  labelChip: {borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6},
  labelChipText: {fontSize: 11, fontWeight: '700', letterSpacing: 0.5},

  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.tagBg,
    borderRadius: radius.pill,
    paddingLeft: 11,
    paddingRight: 8,
    paddingVertical: 5,
  },
  tagChipText: {fontSize: 13.5, fontWeight: '500', color: colors.link},
  tagChipX: {fontSize: 11, color: colors.link, opacity: 0.8},
  tagInputRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10},
  tagInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    color: colors.textPrimary,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tagAdd: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tagAddText: {fontSize: 22, fontWeight: '400', color: colors.textSecondary, lineHeight: 24},
  suggestLabel: {fontSize: 10, fontWeight: '700', letterSpacing: 0.9, color: colors.textMuted, marginTop: 14, marginBottom: 8},
  suggestChip: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderLight,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  suggestChipText: {fontSize: 13, color: colors.textSecondary},

  cwRow: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4},
  cwTitle: {fontSize: 15, fontWeight: '500', color: colors.textPrimary},
  cwSub: {fontSize: 12.5, color: colors.textMuted, marginTop: 2},
  cwInput: {
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.warning,
    color: colors.textPrimary,
    fontSize: 14,
  },


  // Embed picker
  savedBack: {flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end'},
  savedSheet: {paddingHorizontal: 10, paddingBottom: 12},
  savedHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  savedHeadTitle: {fontSize: 11, fontWeight: '700', letterSpacing: 0.88, color: colors.textMuted},
  savedHeadNum: {fontSize: 11, fontWeight: '700', color: colors.textMuted},
  savedList: {
    maxHeight: 320,
    backgroundColor: colors.surface,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    overflow: 'hidden',
  },
  savedRow: {flexDirection: 'row', alignItems: 'stretch', borderTopWidth: 1, borderTopColor: colors.border},
  savedRowMain: {flex: 1, minWidth: 0, paddingLeft: 18, paddingRight: 8, paddingVertical: 13},
  savedRemove: {width: 48, alignItems: 'center', justifyContent: 'center', borderLeftWidth: 1, borderLeftColor: colors.border},
  savedRemoveText: {fontSize: 14, color: colors.textMuted},
  savedKind: {fontSize: 10, fontWeight: '700', letterSpacing: 0.6, color: colors.accent, textTransform: 'uppercase'},
  savedWhere: {color: colors.textMuted, fontWeight: '600', letterSpacing: 0},
  savedTitle: {fontSize: 14.5, fontWeight: '600', color: colors.textPrimary, marginTop: 4},
  savedSnip: {fontSize: 12.5, color: colors.textSecondary, marginTop: 2, lineHeight: 18},
  savedEmpty: {paddingVertical: 26, paddingHorizontal: 20, fontSize: 13.5, lineHeight: 20, color: colors.textMuted, textAlign: 'center'},
  savedDone: {
    marginTop: 8,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 15,
    alignItems: 'center',
  },
  savedDoneText: {fontSize: 16, fontWeight: '600', color: colors.accent},

  // Link dialog
  linkOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 16},
  linkDialog: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 8,
  },
  linkDialogTitle: {fontSize: 17, fontWeight: '600', color: colors.textPrimary},
  linkDialogInput: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    color: colors.textPrimary,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  linkActions: {flexDirection: 'row', gap: 8, marginTop: 6},
  linkBtn: {flex: 1, borderRadius: radius.pill, paddingVertical: 11, alignItems: 'center', justifyContent: 'center'},
  linkCancel: {backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border},
  linkCancelText: {color: colors.textPrimary, fontSize: 13, fontWeight: '600'},
  linkAdd: {backgroundColor: colors.accent},
  linkAddText: {color: colors.onAccent, fontSize: 13, fontWeight: '600'},
});
