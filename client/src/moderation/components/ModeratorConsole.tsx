/**
 * ModeratorConsole — the moderator-only control surface.
 *
 * This UI exists ONLY for users the organizer has assigned as moderators: the parent renders it
 * solely when `snapshot.isModerator` is true (the organizer-signed `stiq:moderators` roster), and
 * every action here is additionally gated by the moderator's granted `scopes` (`stiq:permissions`).
 * Authority is enforced end-to-end regardless of UI — the relay and the client feed filter ignore
 * moderation events from anyone outside the roster — so this console is a convenience surface over
 * authority that already lives in the data model, never a back door to it.
 *
 * Moderation here REMOVES NOTHING (the user's locked "advisory" model). Every action publishes a
 * signed directive that tells clients how to *render* content — "posts from npub X belong in the
 * mod log, not the feed" — matched on the author's REAL npub (recovered from a blind post's
 * encrypted attribution), so a standing rule follows an author across the throwaway key each blind
 * post is signed with. Content always stays on the relay; every directive is public and reversible.
 *
 * Two work queues:
 *   • Reports — member reports awaiting review. Send the author to the log (a standing rule, with an
 *     optional pull of their past posts), log just the reported post, or dismiss (a local "reviewed,
 *     no action" that re-surfaces only if the item is reported again).
 *   • Logged — authors whose posts currently render in the mod log: those under an advisory standing
 *     rule (restore returns them to the feed) plus any legacy hard-bans (one-tap lift).
 */
import React, {useEffect, useMemo, useState} from 'react';
import {Modal, SafeAreaView, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Press} from '../../ui/Press';
import {SwipeBackView} from '../../ui/SwipeBack';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {safeNpubEncode, shortenNpub} from '../../util/npub';
import {GradientDot} from '../../ui/GradientDot';
import {colors} from '../../ui/theme';
import type {GradientSpec} from '../../media/gradient';
import {relTime as relTimeStyled} from '../../ui/relTime';
import type {ModScope} from '../organizerConfig';
import type {PendingReport} from '../queue';
import type {BannedMember} from '../bans';
import type {LoggedAuthor} from '../advisory';

const DISMISSED_KEY = 'stiq_mod_dismissed_reports';

export interface ModeratorConsoleProps {
  visible: boolean;
  onClose: () => void;
  /** Scopes the organizer granted this moderator (drives per-action gating). */
  scopes: readonly ModScope[];
  /** Member reports awaiting review (computed by the runtime; newest/most-reported first). */
  reports: PendingReport[];
  /** Legacy hard-bans still in effect (kept liftable; the advisory model supersedes issuing them). */
  bans: BannedMember[];
  /** Authors under an active advisory standing rule (their posts render in the mod log). */
  loggedAuthors: LoggedAuthor[];
  /** Resolve a peer's display name + gradient identity. */
  getProfile?: (pubkey: string) => {name?: string; gradient?: GradientSpec | null} | undefined;
  /** Advisory: send an author's posts to the mod log (standing rule). When `includePast` is set,
   *  also route their existing posts there in one batch. Reversible from the Logged tab. */
  onLogAuthor: (authorPubkey: string, includePast: boolean) => void;
  /** Advisory: send a single reported post/comment to the mod log (reversible). */
  onLogPost: (targetId: string, targetType: 'post' | 'comment', authorPubkey?: string) => void;
  /** Advisory: reverse a standing rule — the author's posts return to the feed. */
  onRestoreAuthor: (authorPubkey: string) => void;
  /** Lift a legacy hard-ban. */
  onUnban: (pubkey: string) => void;
  /** Open the reported post/comment in context (optional). */
  onViewPost?: (targetId: string) => void;
  /** Per-action rate-limit message (null = free to act), e.g. checkModLimit('ban'). */
  checkLimit?: (action: string) => string | null;
}

/** A row in the "Logged" tab: an author whose posts render in the mod log, and by which mechanism. */
interface LoggedRow {
  pubkey: string;
  /** Newest of (standing-rule time, ban time) — drives the sort + relative age. */
  since: number;
  /** An advisory standing rule (`log-user`) is active on this author. */
  advisory: boolean;
  /** A legacy hard-ban is active on this author (with its message/expiry), if any. */
  ban?: BannedMember;
}

const SCOPE_LABELS: Record<ModScope, string> = {
  'hide-post': 'Remove posts',
  'hide-comment': 'Remove comments',
  ban: 'Ban members',
  retag: 'Re-tag',
  pin: 'Pin',
  lock: 'Lock threads',
  restore: 'Restore',
};

function shortNpub(npub: string): string {
  return shortenNpub(npub, {lead: 12, tail: 4, minLen: 16});
}

/** Relative age, design-style: "now" / "25m" / "3h" / "2d". */
function relTime(tsSeconds: number, nowMs: number): string {
  return relTimeStyled(tsSeconds, 'log', nowMs);
}

type ConsoleTab = 'reports' | 'logged';

export function ModeratorConsole({
  visible,
  onClose,
  scopes,
  reports,
  bans,
  loggedAuthors,
  getProfile,
  onLogAuthor,
  onLogPost,
  onRestoreAuthor,
  onUnban,
  onViewPost,
  checkLimit,
}: ModeratorConsoleProps): React.JSX.Element {
  const [tab, setTab] = useState<ConsoleTab>('reports');
  // Locally-dismissed reports: target id → the unix-seconds at which this moderator dismissed it.
  // A dismissal sticks until a NEWER report on the same target arrives (latestAt > dismissedAt),
  // so "reviewed, no action" doesn't bury a freshly re-reported item. Acting on a report (log the
  // author or the post) dismisses it locally too, so it leaves the queue immediately.
  const [dismissed, setDismissed] = useState<Record<string, number>>({});
  // Per-report "＋ past posts" toggle for the "Send to log" action (report target id → on). Keyed by
  // target — not author — so two reports on the same author keep independent checkboxes.
  const [includePast, setIncludePast] = useState<Record<string, boolean>>({});
  useEffect(() => {
    void AsyncStorage.getItem(DISMISSED_KEY).then(raw => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as Record<string, number>;
        if (parsed && typeof parsed === 'object') setDismissed(parsed);
      } catch {
        /* ignore malformed */
      }
    });
  }, []);

  // One "now" per open so every relative time is consistent and stable across re-renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nowMs = useMemo(() => Date.now(), [visible, reports, bans, loggedAuthors]);

  const can = (scope: ModScope): boolean => scopes.includes(scope);
  const limitFor = (action: string): string | null => checkLimit?.(action) ?? null;

  const visibleReports = useMemo(
    () => reports.filter(r => (dismissed[r.targetId] ?? 0) < r.latestAt),
    [reports, dismissed],
  );

  // Unified "Logged" list: authors under an advisory standing rule folded together with any legacy
  // hard-bans, deduped by pubkey (an author can be both), newest first.
  const loggedRows = useMemo<LoggedRow[]>(() => {
    const byPubkey = new Map<string, LoggedRow>();
    for (const a of loggedAuthors) {
      byPubkey.set(a.pubkey, {pubkey: a.pubkey, since: a.since, advisory: true});
    }
    for (const b of bans) {
      const row = byPubkey.get(b.pubkey);
      if (row) {
        row.ban = b;
        row.since = Math.max(row.since, b.since);
      } else {
        byPubkey.set(b.pubkey, {pubkey: b.pubkey, since: b.since, advisory: false, ban: b});
      }
    }
    return [...byPubkey.values()].sort((x, y) => y.since - x.since);
  }, [loggedAuthors, bans]);

  const nameFor = (pubkey: string | undefined): string => {
    if (!pubkey) return 'a member';
    return getProfile?.(pubkey)?.name?.trim() || shortNpub(safeNpubEncode(pubkey));
  };

  const dismiss = (targetId: string): void => {
    setDismissed(prev => {
      const next = {...prev, [targetId]: Math.floor(Date.now() / 1000)};
      void AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
      return next;
    });
  };

  const togglePast = (targetId: string): void =>
    setIncludePast(prev => ({...prev, [targetId]: !prev[targetId]}));

  // Send an author to the log (standing rule, optionally with past posts), then clear the reported
  // item from this moderator's queue so acting on it gives immediate feedback.
  const logAuthor = (pubkey: string, targetId: string): void => {
    onLogAuthor(pubkey, !!includePast[targetId]);
    dismiss(targetId);
  };
  const logPost = (r: PendingReport): void => {
    onLogPost(r.targetId, r.targetType, r.authorPubkey);
    dismiss(r.targetId);
  };

  // Restore a logged author to the feed: reverse whichever mechanism(s) apply.
  const restoreRow = (row: LoggedRow): void => {
    if (row.advisory) onRestoreAuthor(row.pubkey);
    if (row.ban) onUnban(row.pubkey);
  };

  const grantedScopes = useMemo(
    () => (Object.keys(SCOPE_LABELS) as ModScope[]).filter(s => scopes.includes(s)),
    [scopes],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {/* SafeAreaView (not View): a Modal renders outside the app's root SafeAreaView, so it
          re-applies the top inset — otherwise the header flanks the Dynamic Island. */}
      <SafeAreaView style={s.root}>
        {/* SwipeBackView wraps the SafeAreaView's children so the opaque page background stays put
            as the backdrop while the content slides away — see
            PLAN_SWIPE_BACK_GESTURE_2026-07-27.md's "Modal-hosted pages" note. `onBack` is `onClose`,
            the same function the header's Done button already calls; `enabled` stays the default
            true — `tab` (reports/logged) is a plain segmented control, and this Modal's own
            onRequestClose already calls `onClose` directly rather than routing through `tab`, so
            there is no inner level for the swipe to peel first. */}
        <SwipeBackView onBack={onClose}>
          {/* header */}
          <View style={s.topbar}>
            <Text style={s.topTitle}>Moderator</Text>
            <View style={s.flex1} />
            <Press onPress={onClose} hitSlop={10} accessibilityLabel="Close moderator console">
              <Text style={s.done}>Done</Text>
            </Press>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.scroll}>
            {/* access — reinforces that authority is organizer-granted */}
            <View style={s.accessCard}>
              <View style={s.accessHeadRow}>
                <Text style={s.accessGlyph}>🛡️</Text>
                <View style={s.flex1}>
                  <Text style={s.accessTitle}>You are a moderator</Text>
                  <Text style={s.accessSub}>Assigned by the organizer · {grantedScopes.length} permission{grantedScopes.length === 1 ? '' : 's'}</Text>
                </View>
              </View>
              {grantedScopes.length > 0 ? (
                <View style={s.scopeRow}>
                  {grantedScopes.map(sc => (
                    <View key={sc} style={s.scopePill}>
                      <Text style={s.scopePillText}>{SCOPE_LABELS[sc]}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={s.accessNone}>The organizer hasn’t granted you any actions yet.</Text>
              )}
            </View>

            {/* segmented tabs */}
            <View style={s.segment}>
              <Press
                onPress={() => setTab('reports')}
                style={[s.segBtn, tab === 'reports' ? s.segActive : s.segInactive]}
                accessibilityState={{selected: tab === 'reports'}}>
                <Text style={[s.segText, tab === 'reports' ? s.segTextActive : s.segTextInactive]}>
                  Reports{visibleReports.length ? ` · ${visibleReports.length}` : ''}
                </Text>
              </Press>
              <Press
                onPress={() => setTab('logged')}
                style={[s.segBtn, tab === 'logged' ? s.segActive : s.segInactive]}
                accessibilityState={{selected: tab === 'logged'}}>
                <Text style={[s.segText, tab === 'logged' ? s.segTextActive : s.segTextInactive]}>
                  Logged{loggedRows.length ? ` · ${loggedRows.length}` : ''}
                </Text>
              </Press>
            </View>

            {tab === 'reports' ? (
              visibleReports.length === 0 ? (
                <Text style={s.empty}>No reports awaiting review.</Text>
              ) : (
                <View style={s.list}>
                  {visibleReports.map(r => {
                    const hideScope: ModScope = r.targetType === 'comment' ? 'hide-comment' : 'hide-post';
                    const canLogPost = can(hideScope);
                    const canLogAuthor = can('ban') && !!r.authorPubkey;
                    // Rate-limit keys match the emitted stiq-action so an organizer's caps count them.
                    const logPostLimit = canLogPost ? limitFor('log') : null;
                    const logAuthorLimit = canLogAuthor ? limitFor('log-user') : null;
                    const pastOn = !!includePast[r.targetId];
                    return (
                      <View key={r.targetId} style={s.card}>
                        <View style={s.cardTop}>
                          <GradientDot size={22} gradient={getProfile?.(r.authorPubkey ?? '')?.gradient} seed={safeNpubEncode(r.authorPubkey ?? r.targetId)} />
                          <Text style={s.cardName} numberOfLines={1}>{nameFor(r.authorPubkey)}</Text>
                          <View style={s.flex1} />
                          {r.thresholdReached && (
                            <View style={s.threshPill}>
                              <Text style={s.threshText}>THRESHOLD</Text>
                            </View>
                          )}
                          <Text style={s.cardAt}>{relTime(r.latestAt, nowMs)}</Text>
                        </View>

                        <View style={s.countRow}>
                          <Text style={s.countText}>
                            {r.reporterCount} report{r.reporterCount === 1 ? '' : 's'} · {r.targetType}
                          </Text>
                        </View>

                        <Text style={s.snippet} numberOfLines={3}>
                          {r.snippet || 'Reported content isn’t cached on this device.'}
                        </Text>

                        {r.reasons.length > 0 && (
                          <View style={s.reasonRow}>
                            {r.reasons.map(rc => (
                              <View key={rc.id} style={s.reasonChip}>
                                <View style={[s.reasonDot, {backgroundColor: rc.color}]} />
                                <Text style={s.reasonText}>{rc.name}</Text>
                              </View>
                            ))}
                          </View>
                        )}

                        {r.notes.length > 0 && (
                          <Text style={s.note} numberOfLines={2}>“{r.notes[0]}”</Text>
                        )}

                        {/* "＋ their past posts" — only meaningful with the standing-rule action. */}
                        {canLogAuthor && (
                          <Press
                            style={s.checkRow}
                            onPress={() => togglePast(r.targetId)}
                            accessibilityRole="checkbox"
                            accessibilityState={{checked: pastOn}}>
                            <View style={[s.checkBox, pastOn && s.checkBoxOn]}>
                              {pastOn && <Text style={s.checkMark}>✓</Text>}
                            </View>
                            <Text style={s.checkLabel}>Also move their past posts to the log</Text>
                          </Press>
                        )}

                        <View style={s.actionRow}>
                          {!!r.snippet && onViewPost && (
                            <Press style={s.ghostBtn} onPress={() => onViewPost(r.targetId)}>
                              <Text style={s.ghostText}>View</Text>
                            </Press>
                          )}
                          <Press style={s.ghostBtn} onPress={() => dismiss(r.targetId)}>
                            <Text style={s.ghostText}>Dismiss</Text>
                          </Press>
                          <View style={s.flex1} />
                          {canLogPost && (
                            <Press
                              style={s.warnBtn}
                              disabled={!!logPostLimit}
                              onPress={() => logPost(r)}>
                              <Text style={s.warnText}>Log post</Text>
                            </Press>
                          )}
                          {canLogAuthor && (
                            <Press
                              style={s.dangerBtn}
                              disabled={!!logAuthorLimit}
                              onPress={() => logAuthor(r.authorPubkey as string, r.targetId)}>
                              <Text style={s.dangerText}>Send to log</Text>
                            </Press>
                          )}
                        </View>
                        {(logPostLimit || logAuthorLimit) && (
                          <Text style={s.limitNote}>{logPostLimit || logAuthorLimit}</Text>
                        )}
                        {!canLogPost && !canLogAuthor && (
                          <Text style={s.limitNote}>Logging this needs a permission you don’t have. You can still dismiss it.</Text>
                        )}
                      </View>
                    );
                  })}
                </View>
              )
            ) : loggedRows.length === 0 ? (
              <Text style={s.empty}>No authors are in the moderation log.</Text>
            ) : (
              <View style={s.list}>
                {loggedRows.map(row => {
                  const restoreLimit = can('ban')
                    ? limitFor(row.advisory ? 'unlog-user' : 'unban')
                    : null;
                  return (
                    <View key={row.pubkey} style={s.card}>
                      <View style={s.cardTop}>
                        <GradientDot size={22} gradient={getProfile?.(row.pubkey)?.gradient} seed={safeNpubEncode(row.pubkey)} />
                        <Text style={s.cardName} numberOfLines={1}>{nameFor(row.pubkey)}</Text>
                        <View style={s.flex1} />
                        <Text style={s.cardAt}>{relTime(row.since, nowMs)}</Text>
                      </View>
                      <Text style={s.banMeta}>
                        {row.advisory
                          ? 'Standing rule · posts render in the log'
                          : 'Legacy ban'}
                        {row.ban
                          ? row.ban.until
                            ? ` · lifts ${relTime(row.ban.until, nowMs)} from now`
                            : row.advisory
                              ? ' · also legacy-banned'
                              : ' · permanent'
                          : ''}
                      </Text>
                      {!!row.ban?.message && (
                        <Text style={s.snippet} numberOfLines={3}>“{row.ban.message}”</Text>
                      )}
                      <View style={s.actionRow}>
                        <View style={s.flex1} />
                        {can('ban') ? (
                          <Press
                            style={s.ghostBtn}
                            disabled={!!restoreLimit}
                            onPress={() => restoreRow(row)}>
                            <Text style={s.ghostText}>Restore to feed</Text>
                          </Press>
                        ) : (
                          <Text style={s.limitNote}>Restoring isn’t in your permissions.</Text>
                        )}
                      </View>
                      {restoreLimit && <Text style={s.limitNote}>{restoreLimit}</Text>}
                    </View>
                  );
                })}
              </View>
            )}

            <Text style={s.footer}>
              🔒 Moderation removes nothing — every action publishes a signed, reversible directive that
              routes content to this log. Open the Moderation Log to review the full history.
            </Text>
          </ScrollView>
        </SwipeBackView>
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  flex1: {flex: 1},
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  topTitle: {fontSize: 18, fontWeight: '700', color: colors.textPrimary},
  done: {fontSize: 15, fontWeight: '600', color: colors.accent},
  scroll: {paddingBottom: 40},

  // access card
  accessCard: {
    margin: 14,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
  },
  accessHeadRow: {flexDirection: 'row', alignItems: 'center', gap: 11},
  accessGlyph: {fontSize: 22},
  accessTitle: {fontSize: 16, fontWeight: '700', color: colors.textPrimary},
  accessSub: {fontSize: 12, color: colors.textMuted, marginTop: 2},
  accessNone: {fontSize: 12.5, color: colors.textMuted, marginTop: 10},
  scopeRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12},
  scopePill: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
  },
  scopePillText: {fontSize: 11.5, color: colors.textSecondary, fontWeight: '600'},

  // segmented tabs
  segment: {flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingBottom: 12},
  segBtn: {flex: 1, borderRadius: 999, borderWidth: 1, paddingVertical: 8, alignItems: 'center'},
  segActive: {backgroundColor: colors.accent, borderColor: colors.accent},
  segInactive: {backgroundColor: 'transparent', borderColor: colors.borderLight},
  segText: {fontSize: 13, fontWeight: '600'},
  segTextActive: {color: '#ffffff'},
  segTextInactive: {color: colors.textSecondary},

  list: {paddingHorizontal: 14, gap: 10},
  empty: {textAlign: 'center', color: colors.textMuted, fontSize: 14, paddingVertical: 36, paddingHorizontal: 24},

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 13,
  },
  cardTop: {flexDirection: 'row', alignItems: 'center', gap: 8},
  cardName: {fontSize: 13.5, fontWeight: '600', color: colors.textPrimary, flexShrink: 1},
  cardAt: {fontSize: 11.5, color: colors.textMuted},
  threshPill: {backgroundColor: colors.dangerBg, borderRadius: 999, paddingVertical: 2, paddingHorizontal: 8, marginRight: 6},
  threshText: {fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4, color: colors.danger},
  countRow: {marginTop: 7},
  countText: {fontSize: 12, color: colors.textMuted, textTransform: 'capitalize'},
  snippet: {
    borderLeftWidth: 2,
    borderLeftColor: colors.borderLight,
    paddingLeft: 10,
    marginTop: 9,
    fontSize: 13.5,
    color: colors.textSecondary,
    lineHeight: 19,
    fontStyle: 'italic',
  },
  reasonRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10},
  reasonChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
  },
  reasonDot: {width: 8, height: 8, borderRadius: 4},
  reasonText: {fontSize: 11.5, color: colors.textSecondary},
  note: {marginTop: 9, fontSize: 12.5, color: colors.textMuted, fontStyle: 'italic'},

  // "＋ their past posts" checkbox row on a report card
  checkRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12},
  checkBox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxOn: {backgroundColor: colors.accent, borderColor: colors.accent},
  checkMark: {fontSize: 11, fontWeight: '800', color: '#ffffff', lineHeight: 14},
  checkLabel: {fontSize: 12.5, color: colors.textSecondary, flexShrink: 1},

  actionRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 13},
  ghostBtn: {borderRadius: 8, borderWidth: 1, borderColor: colors.borderLight, paddingVertical: 7, paddingHorizontal: 12},
  ghostText: {fontSize: 12.5, fontWeight: '600', color: colors.textSecondary},
  warnBtn: {borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt, paddingVertical: 7, paddingHorizontal: 12},
  warnText: {fontSize: 12.5, fontWeight: '600', color: colors.textPrimary},
  dangerBtn: {borderRadius: 8, backgroundColor: colors.dangerBg, paddingVertical: 7, paddingHorizontal: 14},
  dangerText: {fontSize: 12.5, fontWeight: '700', color: colors.danger},
  btnDisabled: {opacity: 0.4},
  limitNote: {fontSize: 11.5, color: colors.textMuted, marginTop: 8},
  banMeta: {fontSize: 12.5, color: colors.textSecondary, marginTop: 7, fontWeight: '600'},

  footer: {marginTop: 18, marginHorizontal: 16, fontSize: 12, color: colors.textMuted, lineHeight: 18},
});
