/**
 * DraftAccessScreen — the owner's "Manage access" queue for a shared draft (Phase 5§F).
 *
 * Modeled DIRECTLY on `GroupView.tsx`'s Join Requests section (`requestCard`, Approve/Deny wiring)
 * and its Members-list revoke treatment — reusing that visual + interaction language rather than
 * inventing a new one, per the plan. Two lists:
 *  - PENDING — requester identity + Approve/Decline (silent decline: {@link DraftAccessScreenProps.onDeny}
 *    mirrors `AppRuntime.denyDraftAccess`'s contract — nothing is ever published, the requester's own
 *    state just never resolves, and this screen shows THEM nothing either).
 *  - APPROVED — requester identity + a revoke "✕", mirroring `GroupView`'s Members-list revoke
 *    treatment. Revoking is FORWARD-ONLY (`AppRuntime.revokeDraftAccess`'s doc): it cannot erase a
 *    snapshot the requester's client already decrypted/cached, so the confirmation copy is careful
 *    to say only that they lose access to FUTURE updates and can't re-open it — never that the
 *    content is recalled.
 *
 * Purely a runtime-connected leaf like `EmbedReader` — rendered by `MainScreen` with the matching
 * `AppRuntime` methods forwarded 1:1 as props (mirrors how `EmbedReader` receives its
 * `onGetDraftAccessState`/`onRequestDraftAccess` etc.). Keeps its own small "resolved this session"
 * echo (mirrors `GroupView`'s `resolvedReqs`) so Approve/Decline/Revoke read back instantly even
 * before the parent's next render re-derives the live queue/granted lists off the runtime's own state.
 */
import React, {useEffect, useState} from 'react';
import {Alert, Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View} from 'react-native';
import {colors, type as typeScale, weight} from '../../ui/theme';
import {GradientAvatar} from '../../ui/GradientAvatar';
import {npubFor, shortNpub} from '../../channels/components/primitives';
import {relTimeShort} from '../../ui/relTime';

/** Mirrors `AppRuntime.getDraftAccessQueue`'s return shape (kept as an inline literal, not a shared
 *  type import — matches how every other cross-layer callback shape in this app is declared, e.g.
 *  `EmbedReader`'s `DraftAccessState`). The real runtime method also carries a `reqId` — unused here
 *  (this screen keys rows on `pubkey`, same as `GroupView`'s requestCard) — but since a WIDER actual
 *  return type is always structurally assignable to this narrower one, `onGetPending` still accepts
 *  `runtime.getDraftAccessQueue` verbatim. */
export interface DraftAccessPendingRequest {
  pubkey: string;
  at: number;
  name?: string;
}

/** Mirrors `AppRuntime.getDraftAccessGranted`'s return shape. */
export interface DraftAccessGrantedEntry {
  pubkey: string;
  at: number;
  name?: string;
}

export interface DraftAccessScreenProps {
  visible: boolean;
  /** The shared draft's stable `shareId` (Phase 5§B) — every read/write below is keyed on this. */
  draftId: string;
  /** The draft's title, when known locally (the owner's own `draftList` echo has it) — shown in the
   *  header. Absent when reached from a notification with only a bare draftId (Phase 5§G). */
  draftTitle?: string;
  onClose: () => void;

  // ── Mirrors the like-named `AppRuntime` methods 1:1 (Phase 5§D) — see feed/draftAccess.ts's module
  // doc for the request → approve → deliver model these read/drive. The two reads are SYNC (both
  // derive off the owner's own already-cached local doc/events, no relay round-trip); the three
  // actions are async writes. ──
  onGetPending?: (draftId: string) => DraftAccessPendingRequest[];
  onGetApproved?: (draftId: string) => DraftAccessGrantedEntry[];
  onApprove?: (draftId: string, requesterPubkey: string) => Promise<void>;
  onDeny?: (draftId: string, requesterPubkey: string) => Promise<void>;
  onRevoke?: (draftId: string, requesterPubkey: string) => Promise<void>;
}

function identityName(pubkey: string, name?: string): string {
  return name?.trim() || shortNpub(npubFor(pubkey), 11, 3);
}

export function DraftAccessScreen({
  visible,
  draftId,
  draftTitle,
  onClose,
  onGetPending,
  onGetApproved,
  onApprove,
  onDeny,
  onRevoke,
}: DraftAccessScreenProps): React.JSX.Element {
  // "Resolved this session" / "revoked this session" echoes — mirrors GroupView's `resolvedReqs`:
  // Approve/Decline/Revoke feel instant even though the parent only re-derives the live lists off
  // the runtime's state on its NEXT render. Reset whenever a DIFFERENT draft's queue opens, so a
  // stale resolution from one draft can never bleed into another's list.
  const [resolvedReqs, setResolvedReqs] = useState<Record<string, {state: 'approved' | 'declined'; name?: string; at: number}>>({});
  const [revoked, setRevoked] = useState<Set<string>>(new Set());
  useEffect(() => { setResolvedReqs({}); setRevoked(new Set()); }, [draftId]);

  const liveQueue = (onGetPending?.(draftId) ?? []).filter(rq => !resolvedReqs[rq.pubkey]);
  const resolvedCards = Object.entries(resolvedReqs).map(([pubkey, r]) => ({pubkey, ...r}));
  const pendingCount = liveQueue.length;
  const approved = (onGetApproved?.(draftId) ?? []).filter(g => !revoked.has(g.pubkey));

  const resolveReq = (rq: DraftAccessPendingRequest, state: 'approved' | 'declined'): void => {
    setResolvedReqs(r => ({...r, [rq.pubkey]: {state, name: rq.name, at: rq.at}}));
    if (state === 'approved') void onApprove?.(draftId, rq.pubkey);
    else void onDeny?.(draftId, rq.pubkey);
  };

  const confirmRevoke = (pubkey: string, name?: string): void => {
    Alert.alert(
      'Revoke access?',
      // Honest about the forward-only nature of a revoke (AppRuntime.revokeDraftAccess's doc): it
      // stops future delivery/re-opening — it does NOT reach into a device that already decrypted
      // and cached the writing.
      `${identityName(pubkey, name)} will lose access to any future updates and won't be able to open this draft again. If they already viewed or saved it, this can't undo that.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () => {
            setRevoked(prev => new Set(prev).add(pubkey));
            void onRevoke?.(draftId, pubkey);
          },
        },
      ],
    );
  };

  const requestCard = (rq: {pubkey: string; at: number; name?: string}, resolvedState?: 'approved' | 'declined'): React.JSX.Element => (
    <View key={rq.pubkey} style={s.reqCard}>
      <View style={s.reqHead}>
        <GradientAvatar seed={npubFor(rq.pubkey)} size={34} radius={17} />
        <View style={s.reqHeadText}>
          <Text style={s.reqName} numberOfLines={1}>{identityName(rq.pubkey, rq.name)}</Text>
          <Text style={s.reqNpub} numberOfLines={1}>{shortNpub(npubFor(rq.pubkey), 11, 3)}</Text>
        </View>
        <Text style={s.reqWhen}>{relTimeShort(rq.at)}</Text>
      </View>
      {!resolvedState ? (
        <View style={s.reqActions}>
          <Pressable style={s.reqApprove} onPress={() => resolveReq(rq, 'approved')} accessibilityLabel={`approve-${rq.pubkey}`}>
            <Text style={s.reqApproveText}>Approve</Text>
          </Pressable>
          <Pressable style={s.reqDecline} onPress={() => resolveReq(rq, 'declined')} accessibilityLabel={`deny-${rq.pubkey}`}>
            <Text style={s.reqDeclineText}>Decline</Text>
          </Pressable>
        </View>
      ) : resolvedState === 'approved' ? (
        <Text style={s.reqApproved}>✓ Approved — they'll receive the current draft</Text>
      ) : (
        <Text style={s.reqDeclined}>Declined quietly — they'll keep seeing "pending".</Text>
      )}
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.page}>
        <View style={s.header}>
          <Pressable onPress={onClose} hitSlop={10} style={s.headerSide}>
            <Text style={s.headerLeft}>‹ Back</Text>
          </Pressable>
          <Text style={s.headerTitle} numberOfLines={1}>Manage access</Text>
          <View style={[s.headerSide, s.headerRight]} />
        </View>

        <ScrollView style={s.flex} contentContainerStyle={s.scroll}>
          {!!draftTitle && <Text style={s.draftTitle} numberOfLines={2}>{draftTitle}</Text>}

          <View style={s.labelRow}>
            <Text style={s.label}>PENDING</Text>
            {pendingCount > 0 && (
              <View style={s.badge}><Text style={s.badgeText}>{pendingCount}</Text></View>
            )}
          </View>
          {liveQueue.length === 0 && resolvedCards.length === 0 ? (
            <View style={s.empty}><Text style={s.emptyText}>No pending requests.</Text></View>
          ) : (
            <>
              {liveQueue.map(rq => requestCard(rq))}
              {resolvedCards.map(rq => requestCard(rq, rq.state))}
              <Text style={s.footer}>
                Declining is silent — the requester is never told; their request just stays "pending" forever.
              </Text>
            </>
          )}

          <View style={s.labelRow}>
            <Text style={s.label}>APPROVED · {approved.length}</Text>
          </View>
          {approved.length === 0 ? (
            <View style={s.empty}><Text style={s.emptyText}>No one has access yet.</Text></View>
          ) : (
            <View style={s.apprCard}>
              {approved.map(g => (
                <View key={g.pubkey} style={s.apprRow}>
                  <GradientAvatar seed={npubFor(g.pubkey)} size={32} radius={16} />
                  <View style={s.apprText}>
                    <Text style={s.apprName} numberOfLines={1}>{identityName(g.pubkey, g.name)}</Text>
                    <Text style={s.apprNpub} numberOfLines={1}>{shortNpub(npubFor(g.pubkey), 11, 3)}</Text>
                  </View>
                  <Pressable onPress={() => confirmRevoke(g.pubkey, g.name)} hitSlop={8} accessibilityLabel={`revoke-${g.pubkey}`}>
                    <Text style={s.apprRevoke}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
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

  scroll: {paddingHorizontal: 16, paddingTop: 14, paddingBottom: 40},
  draftTitle: {fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 16},

  labelRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 4},
  label: {color: colors.textMuted, fontSize: 11, fontWeight: weight.bold, letterSpacing: 0.8},
  badge: {backgroundColor: colors.accent, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, minWidth: 20, alignItems: 'center'},
  badgeText: {color: colors.onAccent, fontSize: 11, fontWeight: weight.bold},

  empty: {backgroundColor: colors.surface, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderLight, borderRadius: 12, padding: 14, alignItems: 'center', marginBottom: 18},
  emptyText: {color: colors.textMuted, fontSize: 13},

  reqCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 12, marginBottom: 8},
  reqHead: {flexDirection: 'row', alignItems: 'center', gap: 10},
  reqHeadText: {flex: 1, minWidth: 0},
  reqName: {color: colors.textPrimary, fontSize: 14.5, fontWeight: weight.semibold},
  reqNpub: {color: colors.link, fontSize: 11, fontFamily: 'monospace', marginTop: 1},
  reqWhen: {color: colors.textMuted, fontSize: 11.5},
  reqActions: {flexDirection: 'row', gap: 8, marginTop: 11},
  reqApprove: {flex: 1, backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 8, alignItems: 'center'},
  reqApproveText: {color: colors.onAccent, fontSize: 13, fontWeight: weight.semibold},
  reqDecline: {flex: 1, borderWidth: 1, borderColor: colors.borderLight, borderRadius: 999, paddingVertical: 8, alignItems: 'center'},
  reqDeclineText: {color: colors.textSecondary, fontSize: 13, fontWeight: weight.semibold},
  reqApproved: {color: colors.accent, fontSize: 13, fontWeight: weight.semibold, marginTop: 10},
  reqDeclined: {color: colors.textMuted, fontSize: 12.5, marginTop: 10},
  footer: {color: colors.textMuted, fontSize: 11.5, lineHeight: 17, marginBottom: 18},

  apprCard: {backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 4, marginBottom: 18},
  apprRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border},
  apprText: {flex: 1, minWidth: 0},
  apprName: {color: colors.textPrimary, fontSize: typeScale.body, fontWeight: weight.semibold},
  apprNpub: {color: colors.textMuted, fontSize: typeScale.caption, fontFamily: 'monospace', marginTop: 1},
  apprRevoke: {color: colors.textMuted, fontSize: 15, paddingHorizontal: 4},
});
