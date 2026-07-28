/**
 * DraftsScreen — the companion to the Post Editor (design_handoff_post_editor / Stiq Drafts.html).
 *
 * A grouped, filterable list of the posts you started but didn't publish. Each card's status chip is
 * computed from the SAME rule set as the live composer meter (`editorRules.draftStatus`), so a draft
 * and the editor can never disagree about whether it's ready. Deleting a draft fades the card and
 * shows an Undo toast; the store deletion only commits after the undo window closes.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {Press} from '../../ui/Press';
import {SwipeBackView} from '../../ui/SwipeBack';
import {colors, radius} from '../../ui/theme';
import {relTimeAgo} from '../../ui/relTime';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {labelMetaFor, normalizeLabels, DEFAULT_LABELS, type LabelConfig} from '../labels';
import {DEFAULT_LIMITS, draftStatus, measureBody, modeOf, type Limits} from '../editorRules';
import {newDraftId, type Draft} from '../drafts';
import {labelInlineMedia} from '../inlineMedia';

type Filter = 'all' | 'note' | 'article' | 'channel';
type Bucket = 'Today' | 'This week' | 'Older';

export interface DraftsScreenProps {
  visible: boolean;
  drafts: Draft[];
  /** Organizer size rules, so the status chip matches the composer meter. */
  limits?: Limits;
  /** Organizer label set, to render the label chip on a card. */
  labels?: LabelConfig;
  onClose: () => void;
  /** Start a fresh post (New). */
  onNew: () => void;
  /** Open a draft in the editor. */
  onOpen: (draft: Draft) => void;
  /** Commit a delete to the store (called after the undo window closes). */
  onDelete: (id: string) => void;
  /** Persist a duplicated draft to the store. */
  onDuplicate?: (draft: Draft) => void;
  /** Save this draft to the embed picker as a self-contained `stiq:draft:` token (share it as an embed). */
  onSaveEmbed?: (draft: Draft) => void;
  /** Owner's pending draft-access request count (Phase 5§F), keyed by the draft's stable `shareId` —
   *  drives the "Manage access (N pending)" menu label. Sync (the runtime derives it off already-
   *  cached local state, no relay round-trip) — matches the presentational, callback-only shape this
   *  component keeps everywhere else (no direct runtime access). */
  onGetPendingAccessCount?: (shareId: string) => number;
  /** Open the owner's "Manage access" queue for this draft — offered only once `draft.shareId` is
   *  set, i.e. the draft has actually been shared at least once (`onSaveEmbed` mints it). */
  onManageAccess?: (draft: Draft) => void;
}

const FILTERS: {key: Filter; label: string}[] = [
  {key: 'all', label: 'All'},
  {key: 'note', label: 'Notes'},
  {key: 'article', label: 'Articles'},
  {key: 'channel', label: 'Channels'},
];

const DAY = 86400_000;

function bucketOf(savedAt: number, now: number): Bucket {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (savedAt >= startOfToday) return 'Today';
  if (savedAt >= now - 7 * DAY) return 'This week';
  return 'Older';
}

export function DraftsScreen({
  visible,
  drafts,
  limits = DEFAULT_LIMITS,
  labels: labelsProp,
  onClose,
  onNew,
  onOpen,
  onDelete,
  onDuplicate,
  onSaveEmbed,
  onGetPendingAccessCount,
  onManageAccess,
}: DraftsScreenProps): React.JSX.Element {
  const labels = useMemo(() => normalizeLabels(labelsProp) ?? DEFAULT_LABELS, [labelsProp]);
  // Local, optimistic copy so delete can animate + be undone before it commits to the store.
  const [items, setItems] = useState<Draft[]>(drafts);
  const [filter, setFilter] = useState<Filter>('all');
  const [sheetFor, setSheetFor] = useState<Draft | null>(null);
  const [undo, setUndo] = useState<{item: Draft; index: number} | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed the local list only when the screen (re)opens, so an in-flight undo isn't clobbered.
  useEffect(() => {
    if (visible) {
      setItems(drafts);
      setFilter('all');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => () => { if (commitTimer.current) clearTimeout(commitTimer.current); }, []);

  const commitPendingNow = (): void => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    setUndo(prev => {
      if (prev) onDelete(prev.item.id);
      return null;
    });
  };

  const deleteDraft = (d: Draft): void => {
    // If a delete is already pending its undo window, commit it before starting a new one.
    commitPendingNow();
    const index = items.findIndex(x => x.id === d.id);
    setItems(list => list.filter(x => x.id !== d.id));
    setUndo({item: d, index: index < 0 ? 0 : index});
    commitTimer.current = setTimeout(() => {
      onDelete(d.id);
      setUndo(null);
    }, 3600);
  };

  const undoDelete = (): void => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    setUndo(cur => {
      if (cur) setItems(list => [...list.slice(0, cur.index), cur.item, ...list.slice(cur.index)]);
      return null;
    });
  };

  const duplicate = (d: Draft): void => {
    const copy: Draft = {...d, id: newDraftId(), savedAt: Date.now()};
    setItems(list => [copy, ...list]);
    onDuplicate?.(copy);
  };

  const now = Date.now();
  const filtered = items.filter(d => {
    if (filter === 'all') return true;
    // A comment draft belongs to a conversation, not the feed — group it with the other
    // "somewhere other than the feed" drafts rather than stranding it under the note/article modes.
    if (filter === 'channel') return d.location?.kind === 'channel' || d.location?.kind === 'comment';
    return modeOf(d.title) === filter;
  });
  const groups: {bucket: Bucket; rows: Draft[]}[] = (['Today', 'This week', 'Older'] as Bucket[])
    .map(bucket => ({bucket, rows: filtered.filter(d => bucketOf(d.savedAt, now) === bucket)}))
    .filter(g => g.rows.length > 0);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.page}>
        {/* SwipeBackView wraps the SafeAreaView's children so the opaque page background stays put
            as the backdrop while the content slides away — see
            PLAN_SWIPE_BACK_GESTURE_2026-07-27.md's "Modal-hosted pages" note. The nested action-sheet
            Modal below was already a direct child of this SafeAreaView and stays one here too; being
            a Modal itself it renders into its own native window, so this view's transform cannot
            affect it either way. `onBack` is `onClose`, the same function the header ‹ Back already
            calls, so the button, the hardware key and the swipe can never drift apart. */}
        <SwipeBackView onBack={onClose}>
          <View style={s.header}>
            <Press onPress={onClose} hitSlop={10} style={s.headerSide}>
              <Text style={s.headerLeft}>‹ Back</Text>
            </Press>
            <Text style={s.headerTitle}>Drafts</Text>
            <Press onPress={onNew} hitSlop={10} style={[s.headerSide, s.headerRight]}>
              <Text style={s.headerNew}>New</Text>
            </Press>
          </View>

          <View style={s.titleRow}>
            <Text style={s.h1}>Drafts</Text>
            <Text style={s.savedCount}>{items.length} saved</Text>
          </View>

          <View style={s.filterRow}>
            {FILTERS.map(f => {
              const active = filter === f.key;
              return (
                <Press key={f.key} onPress={() => setFilter(f.key)} style={[s.filterChip, active && s.filterChipActive]}>
                  <Text style={[s.filterText, active && s.filterTextActive]}>{f.label}</Text>
                </Press>
              );
            })}
          </View>

          {groups.length === 0 ? (
            <View style={s.empty}>
              <Text style={s.emptyTitle}>No drafts here</Text>
              <Text style={s.emptySub}>Drafts you don't publish will wait for you here.</Text>
            </View>
          ) : (
            <ScrollView style={s.flex} contentContainerStyle={s.listContent}>
              {groups.map(g => (
                <View key={g.bucket} style={s.group}>
                  <Text style={s.groupLabel}>{g.bucket}</Text>
                  {g.rows.map(d => (
                    <DraftCard
                      key={d.id}
                      draft={d}
                      labels={labels}
                      limits={limits}
                      now={now}
                      onPress={() => onOpen(d)}
                      onMenu={() => setSheetFor(d)}
                    />
                  ))}
                </View>
              ))}
            </ScrollView>
          )}

          {/* ── Undo toast ── */}
          {undo && (
            <View style={s.toast}>
              <Text style={s.toastText}>Draft deleted</Text>
              <Press onPress={undoDelete}>
                <Text style={s.toastUndo}>Undo</Text>
              </Press>
            </View>
          )}

          {/* ── Action sheet ── */}
          <Modal visible={!!sheetFor} transparent animationType="fade" onRequestClose={() => setSheetFor(null)}>
            <Press variant="bare" style={s.sheetBack} onPress={() => setSheetFor(null)} accessibilityRole="none">
              <Press variant="bare" style={s.sheet} onPress={() => {}} accessibilityRole="none">
                {sheetFor && (
                  <View style={s.sheetPeek}>
                    <Text style={s.sheetPeekKind}>{modeOf(sheetFor.title) === 'article' ? 'ARTICLE' : 'NOTE'}</Text>
                    <Text style={s.sheetPeekTitle} numberOfLines={1}>
                      {sheetFor.title.trim() || labelInlineMedia(sheetFor.content).trim() || '(empty draft)'}
                    </Text>
                  </View>
                )}
                <Press variant="row" style={s.sheetItem} onPress={() => { const d = sheetFor; setSheetFor(null); if (d) onOpen(d); }}>
                  <Text style={s.sheetItemText}>Continue editing</Text>
                </Press>
                <Press variant="row" style={s.sheetItem} onPress={() => { const d = sheetFor; setSheetFor(null); if (d) duplicate(d); }}>
                  <Text style={s.sheetItemText}>Duplicate</Text>
                </Press>
                {onSaveEmbed && (
                  <Press variant="row" style={s.sheetItem} onPress={() => { const d = sheetFor; setSheetFor(null); if (d) onSaveEmbed(d); }}>
                    <Text style={s.sheetItemText}>Save to embed</Text>
                  </Press>
                )}
                {/* Only once this draft has actually been shared (has a shareId) — Phase 5§F. */}
                {sheetFor?.shareId && onManageAccess && (
                  <Press variant="row" style={s.sheetItem} onPress={() => { const d = sheetFor; setSheetFor(null); if (d) onManageAccess(d); }}>
                    <Text style={s.sheetItemText}>
                      Manage access ({onGetPendingAccessCount?.(sheetFor.shareId) ?? 0} pending)
                    </Text>
                  </Press>
                )}
                <Press variant="row" style={s.sheetItem} onPress={() => { const d = sheetFor; setSheetFor(null); if (d) deleteDraft(d); }}>

                  <Text style={[s.sheetItemText, s.sheetDanger]}>Delete draft</Text>
                </Press>
                <Press style={[s.sheetItem, s.sheetCancel]} onPress={() => setSheetFor(null)}>
                  <Text style={s.sheetItemText}>Cancel</Text>
                </Press>
              </Press>
            </Press>
          </Modal>
        </SwipeBackView>
      </SafeAreaView>
    </Modal>
  );
}

function DraftCard({
  draft,
  labels,
  limits,
  now,
  onPress,
  onMenu,
}: {
  draft: Draft;
  labels: LabelConfig;
  limits: Limits;
  now: number;
  onPress: () => void;
  onMenu: () => void;
}): React.JSX.Element {
  const {kind, chars, words} = measureBody(draft.title, draft.content);
  const status = draftStatus(kind, chars, words, draft.label ?? null, limits);
  const meta = draft.label ? labelMetaFor(draft.label, labels) : null;
  const channel = draft.location?.kind === 'channel' ? draft.location : null;
  // A comment draft carries its ROOT POST, not a channel — same chip treatment, seeded on the root
  // so the swatch is stable per thread, with the eyebrow saying what it actually is.
  const comment = draft.location?.kind === 'comment' ? draft.location : null;
  const count = kind === 'article' ? `${words.toLocaleString()} words` : `${chars} chars`;

  return (
    <Press variant="row" style={s.card} onPress={onPress}>
      <View style={s.cardTopRow}>
        <Text style={s.cardEyebrow}>{comment ? 'COMMENT' : kind === 'article' ? 'ARTICLE' : 'NOTE'}</Text>
        {channel && (
          <View style={s.cardChannel}>
            <GradientAvatar seed={channel.channelId} size={14} />
            <Text style={s.cardChannelName} numberOfLines={1}>{channel.channelName}</Text>
          </View>
        )}
        {comment && (
          <View style={s.cardChannel}>
            <GradientAvatar seed={comment.rootId} size={14} />
            <Text style={s.cardChannelName} numberOfLines={1}>{comment.rootLabel}</Text>
          </View>
        )}
        {meta && (
          <View style={[s.cardLabel, {backgroundColor: meta.bg}]}>
            <Text style={[s.cardLabelText, {color: meta.color}]}>{meta.text}</Text>
          </View>
        )}
        <View style={s.flex} />
        <Text style={s.cardTime}>{relTimeAgo(Math.floor(draft.savedAt / 1000), now)}</Text>
      </View>

      {kind === 'article' && !!draft.title.trim() && (
        <Text style={s.cardTitle} numberOfLines={1}>{draft.title.trim()}</Text>
      )}
      <Text style={s.cardSnippet} numberOfLines={2}>
        {labelInlineMedia(draft.content).replace(/\s+/g, ' ').trim() || '(empty draft)'}
      </Text>

      {draft.tags.length > 0 && (
        <Text style={s.cardTags} numberOfLines={1}>
          {draft.tags.map(t => `#${t}`).join('  ·  ')}
        </Text>
      )}

      <View style={s.cardFooter}>
        <View style={s.cardStatus}>
          <View style={[s.statusDot, {backgroundColor: status.cls === 'ok' ? colors.success : colors.warning}]} />
          <Text style={[s.statusMsg, {color: status.cls === 'ok' ? colors.success : colors.warning}]}>{status.msg}</Text>
        </View>
        <Text style={s.cardCount}>{count}</Text>
        <Press hitSlop={10} onPress={onMenu} accessibilityLabel="Draft actions" style={s.cardMenu}>
          <Text style={s.cardMenuDots}>⋯</Text>
        </Press>
      </View>
    </Press>
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
  headerSide: {minWidth: 64, justifyContent: 'center'},
  headerRight: {alignItems: 'flex-end'},
  headerLeft: {fontSize: 16, color: colors.textSecondary},
  headerTitle: {flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600', color: colors.textPrimary},
  headerNew: {fontSize: 16, fontWeight: '600', color: colors.accent},

  titleRow: {flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6},
  h1: {fontSize: 27, fontWeight: '700', color: colors.textPrimary},
  savedCount: {fontSize: 13, color: colors.textMuted, paddingBottom: 4},

  filterRow: {flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10},
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterChipActive: {backgroundColor: colors.accent, borderColor: colors.accent},
  filterText: {fontSize: 13, fontWeight: '500', color: colors.textSecondary},
  filterTextActive: {color: colors.onAccent},

  listContent: {paddingHorizontal: 16, paddingBottom: 40},
  group: {marginTop: 10},
  groupLabel: {fontSize: 11, fontWeight: '700', letterSpacing: 0.8, color: colors.textMuted, marginBottom: 8, marginTop: 8},

  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    padding: 14,
    marginBottom: 10,
  },
  cardTopRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  cardEyebrow: {fontSize: 10, fontWeight: '800', letterSpacing: 0.8, color: colors.textMuted},
  cardChannel: {flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: 130},
  cardChannelName: {fontSize: 11.5, fontWeight: '600', color: colors.textSecondary},
  cardLabel: {borderRadius: radius.sm, paddingHorizontal: 7, paddingVertical: 2},
  cardLabelText: {fontSize: 9.5, fontWeight: '700', letterSpacing: 0.5},
  cardTime: {fontSize: 12, color: colors.textMuted},

  cardTitle: {fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginTop: 8},
  cardSnippet: {fontSize: 13.5, color: colors.textSecondary, marginTop: 6, lineHeight: 19},
  cardTags: {fontSize: 12, color: colors.textMuted, marginTop: 8},

  cardFooter: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12},
  cardStatus: {flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0},
  statusDot: {width: 7, height: 7, borderRadius: 4},
  statusMsg: {fontSize: 12.5, fontWeight: '500', flexShrink: 1},
  cardCount: {fontSize: 12, color: colors.textMuted},
  cardMenu: {paddingHorizontal: 6},
  cardMenuDots: {fontSize: 20, color: colors.textSecondary, lineHeight: 20},

  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, paddingBottom: 60},
  emptyTitle: {fontSize: 17, fontWeight: '600', color: colors.textSecondary},
  emptySub: {fontSize: 13.5, color: colors.textMuted, marginTop: 8, textAlign: 'center', lineHeight: 19},

  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceHover,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  toastText: {fontSize: 14, color: colors.textPrimary},
  toastUndo: {fontSize: 14, fontWeight: '700', color: colors.accent},

  sheetBack: {flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end'},
  sheet: {padding: 10, paddingBottom: 16, gap: 8},
  sheetPeek: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sheetPeekKind: {fontSize: 10, fontWeight: '800', letterSpacing: 0.8, color: colors.textMuted},
  sheetPeekTitle: {fontSize: 14.5, fontWeight: '600', color: colors.textPrimary, marginTop: 4},
  sheetItem: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 15,
    alignItems: 'center',
  },
  sheetItemText: {fontSize: 16, fontWeight: '600', color: colors.textPrimary},
  sheetDanger: {color: colors.danger},
  sheetCancel: {marginTop: 4},
});
