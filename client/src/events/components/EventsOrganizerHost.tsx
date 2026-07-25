/**
 * EventsOrganizerHost — the Events — Organizer flow reached from Settings (README fact #2),
 * mounted by MainScreen as one always-mounted Modal. Owns the DC's screen union
 * ('list' | 'create' | 'manage') and wires the three pure screens (YourEventsScreen /
 * EventEditorScreen / ManageScreen) to the {@link EventsApi}: draft persistence, publish (+ the
 * auto-add group creation inside api.publish), the applications queue, guest/waitlist rosters,
 * message-all, the real .csv download, cancel, and Add to embeds.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, StyleSheet} from 'react-native';
import {colors} from '../../ui/theme';
import {BackModal} from '../../ui/back';
import type {PictureRules} from '../../feed/pictureRules';
import {saveEventEmbed} from '../../channels/savedEmbeds';
import type {EventsApi} from '../api';
import type {EventDraftEntry} from '../drafts';
import {newEventDraftId} from '../drafts';
import {detailEventFrom} from '../detailVm';
import {YourEventsScreen} from './YourEventsScreen';
import {EventEditorScreen} from './EventEditorScreen';
import {ManageScreen} from './ManageScreen';
import {fmtWhen, fmtWhenFromIso, whenLine} from '../format';
import {buildGuestCsv} from '../format';
import {saveTextFile, sanitizeFileName} from '../../util/fileExport';
import type {DraftRowVM, EventDraft, ManageVM, PastRowVM, UpcomingRowVM} from '../types';

type OrgScreen = 'list' | 'create' | 'manage';

/** The when-derivation for a stored draft/live record (raw editor fields win over the ISO). */
function draftWhen(d: EventDraft): ReturnType<typeof fmtWhen> {
  if (d.rawDate || d.rawTime) return fmtWhen(d.rawDate, d.rawTime, d.tz);
  return fmtWhenFromIso(d.startsAt, d.tz);
}

export function EventsOrganizerHost({
  api,
  visible,
  onClose,
  onPreview,
  pictureRules,
  picturesSpentBytes,
  allowVoice,
  postRules,
  savedPosts,
  savedEmbedTokens,
}: {
  api: EventsApi;
  visible: boolean;
  onClose: () => void;
  /** "Preview ↗" — open the event detail overlay exactly as a guest sees it. */
  onPreview: (coordinate: string) => void;
  /** Organizer picture limits — the editor's cover-image PictureComposer gate. */
  pictureRules?: PictureRules;
  picturesSpentBytes?: number;
  /** Threaded to the description editor (the body-only post composer). */
  allowVoice?: boolean;
  postRules?: import('../../feed/postRules').PostRules;
  savedPosts?: {id: string; title: string; snippet: string; name?: string; gradient?: import('../../media/gradient').GradientSpec | null}[];
  savedEmbedTokens?: {id: string; label: string; title: string; uri: string}[];
}): React.JSX.Element {
  const [screen, setScreen] = useState<OrgScreen>('list');
  const [entries, setEntries] = useState<EventDraftEntry[]>([]);
  /** The entry being edited (create screen) — null = a brand-new event. */
  const [editing, setEditing] = useState<EventDraftEntry | null>(null);
  /** The entry being managed (manage screen). */
  const [managing, setManaging] = useState<EventDraftEntry | null>(null);
  const [, setTick] = useState(0);
  const bump = (): void => setTick(t => t + 1);

  const mounted = useRef(false);
  mounted.current ||= visible;

  const refresh = useCallback(async (): Promise<void> => {
    setEntries(await api.listEntries());
  }, [api]);

  useEffect(() => {
    if (visible) {
      setScreen('list');
      setEditing(null);
      setManaging(null);
      void refresh();
    }
  }, [visible, refresh]);

  const myPk = api.myPubkey() ?? '';
  const coordFor = (entry: EventDraftEntry): string => `31923:${myPk}:${entry.id}`;

  // ── Your events rows ──
  const upcoming: UpcomingRowVM[] = [];
  const drafts: DraftRowVM[] = [];
  const past: PastRowVM[] = [];
  for (const entry of entries) {
    const d = entry.draft;
    const w = draftWhen(d);
    if (d.isDraft) {
      drafts.push({
        id: entry.id,
        title: d.title?.trim() || 'Untitled event',
        subLine: d.startsAt ? `Draft · ${w.dateLabel}` : 'Draft · no date set',
      });
      continue;
    }
    const coord = coordFor(entry);
    const live = api.live(coord);
    const stats = api.stats(coord);
    const row = {
      id: entry.id,
      title: d.title?.trim() || 'Untitled event',
      whenLine: whenLine(w),
      month: w.month,
      day: w.day,
    };
    if (live?.status === 'past') {
      past.push(row);
    } else {
      upcoming.push({
        ...row,
        newCount: stats.pending || undefined,
        cancelled: live?.status === 'cancelled' || undefined,
        interestedCount: stats.interested,
        attendingCount: d.external ? null : stats.going,
        locationLabel: !d.hidden?.loc ? d.location?.area : undefined,
      });
    }
  }

  // ── Manage VM (live reads each render — decisions/stats update through api + bump) ──
  let manageVm: ManageVM | null = null;
  if (managing) {
    const coord = coordFor(managing);
    const doc = api.doc(coord);
    const live = api.live(coord);
    const w = draftWhen(managing.draft);
    const stats = api.stats(coord);
    const guests = api.guests(coord);
    const event = doc
      ? detailEventFrom(doc, live, Math.floor(Date.now() / 1000)).event
      : // The doc hasn't round-tripped yet (fresh publish, offline) — compose a minimal event from
        // the host-local record so Manage still opens.
        {
          id: managing.id,
          host: {name: api.viewerIdentity().name, npub: api.viewerIdentity().npub, grad: api.viewerIdentity().grad},
          external: !!managing.draft.external,
          type: managing.draft.type ?? 'inperson',
          title: managing.draft.title?.trim() || 'Untitled event',
          startsAt: managing.draft.startsAt ?? '',
          tz: managing.draft.tz ?? '',
          recurrence: managing.draft.recurrence ?? 'none',
          location: managing.draft.location ?? {kind: 'physical'},
          capacityMode: managing.draft.capacityMode ?? 'limit',
          capacity: managing.draft.capacity,
          waitlistEnabled: !!managing.draft.waitlistEnabled,
          interestedCount: stats.interested,
          attendingCount: stats.going,
          autoAdd: managing.draft.autoAdd,
          cover: {mode: managing.draft.cover?.mode ?? 'gradient', gradient: managing.draft.cover?.gradient},
          status: 'upcoming' as const,
        };
    manageVm = {
      event,
      whenLine: whenLine(w),
      stats,
      applications: api.applications(coord),
      guests,
      guestsMore: 0,
      waitlist: api.waitlist(coord),
      cancelled: live?.status === 'cancelled' || !!doc?.cancelled,
      messageRecipients: stats.going + stats.waitlist,
    };
  }

  const openManage = async (entryId: string): Promise<void> => {
    const entry = entries.find(e => e.id === entryId) ?? (await api.getEntry(entryId));
    if (!entry) return;
    setManaging(entry);
    setScreen('manage');
  };

  const openEditor = (entry: EventDraftEntry | null): void => {
    setEditing(entry);
    setScreen('create');
  };

  const editorInitial: EventDraft = editing?.draft ?? {isDraft: true, hidden: {}};
  const editorMode: 'create' | 'edit' = editing && !editing.draft.isDraft ? 'edit' : 'create';

  const publish = async (draft: EventDraft): Promise<void> => {
    // The doc's `d` = the entry id, so a draft publishes over itself (one record per event).
    const entryId = editing?.id ?? newEventDraftId();
    const coordinate = await api.publish({...draft, id: entryId}, {notifyGoing: editorMode === 'edit'});
    await refresh();
    if (!coordinate) {
      setScreen('list');
      return;
    }
    if (editorMode === 'edit' && managing) {
      const entry = await api.getEntry(entryId);
      if (entry) setManaging(entry);
      setScreen('manage');
    } else {
      setScreen('list');
    }
  };

  const saveDraft = async (draft: EventDraft): Promise<void> => {
    const entryId = editing?.id ?? newEventDraftId();
    await api.saveEntry({id: entryId, updatedAt: Date.now(), draft: {...draft, id: entryId, isDraft: true}});
    await refresh();
    setScreen('list');
  };

  /**
   * "Add to my embeds" from the editor. The token's address must be the `d` the eventual publish
   * keeps, so an unsaved brand-new event is persisted as a draft first (and stays the entry being
   * edited — Save/Publish afterwards reuse the same id instead of minting a second record).
   */
  const addToEmbeds = async (draft: EventDraft): Promise<void> => {
    let entry = editing;
    if (!entry) {
      const id = newEventDraftId();
      entry = {id, updatedAt: Date.now(), draft: {...draft, id, isDraft: true}};
      await api.saveEntry(entry);
      setEditing(entry);
      await refresh();
    }
    // A published event's token comes from its live doc; a draft encodes straight from the fields.
    const token = !entry.draft.isDraft
      ? api.token(coordFor(entry)) ?? api.tokenForDraft({...draft, id: entry.id})
      : api.tokenForDraft({...draft, id: entry.id});
    if (!token) return;
    await saveEventEmbed(
      {coordinate: coordFor(entry), token, title: draft.title},
      Math.floor(Date.now() / 1000),
    ).catch(() => {});
  };

  const exportCsv = async (): Promise<boolean> => {
    if (!managing) return false;
    const coord = coordFor(managing);
    const csv = buildGuestCsv(api.guests(coord), api.waitlist(coord));
    const name = `${sanitizeFileName(managing.draft.title?.trim() || 'stiq-event')}-guests.csv`;
    return saveTextFile(name, 'text/csv', csv);
  };

  // BACK peels one screen at a time — the editor returns to whatever opened it, Manage returns to
  // the list, and only the list itself closes the organizer. BackModal (ui/back.tsx) is what makes
  // that expressible: this is a native <Modal>, so its own Dialog window eats the back key and no
  // BackHandler outside it ever fires — before this, `onRequestClose={onClose}` meant one press from
  // the editor threw the whole organizer away. Each branch mirrors the `onBack` already wired to
  // that screen's own ‹ control, so the key and the button stay one behaviour.
  const handleBack = (): boolean => {
    if (screen === 'create') { setScreen(managing && editorMode === 'edit' ? 'manage' : 'list'); return true; }
    if (screen === 'manage') { setScreen('list'); return true; }
    return false; // on the list, fall through to onClose
  };

  return (
    <BackModal visible={visible} animationType="slide" onClose={onClose} onBack={handleBack}>
      {mounted.current && (
        <View style={s.root}>
          {screen === 'list' && (
            <YourEventsScreen
              upcoming={upcoming}
              drafts={drafts}
              past={past}
              onNew={() => openEditor(null)}
              onOpenManage={id => void openManage(id)}
              onEditDraft={id => {
                const entry = entries.find(e => e.id === id);
                if (entry) openEditor(entry);
              }}
              onBack={onClose}
            />
          )}
          {screen === 'create' && (
            <EventEditorScreen
              // Remount per target so field state re-seeds when switching drafts.
              key={editing?.id ?? 'new'}
              mode={editorMode}
              initial={editorInitial}
              channels={api.channelsIRun()}
              hostName={api.viewerIdentity().name}
              hostGrad={api.viewerIdentity().grad}
              pictureRules={pictureRules}
              picturesSpentBytes={picturesSpentBytes}
              allowVoice={allowVoice}
              postRules={postRules}
              savedPosts={savedPosts}
              savedEmbedTokens={savedEmbedTokens}
              onPublish={draft => void publish(draft)}
              onSaveDraft={draft => void saveDraft(draft)}
              onAddToEmbeds={draft => void addToEmbeds(draft)}
              onBack={() => setScreen(managing && editorMode === 'edit' ? 'manage' : 'list')}
            />
          )}
          {screen === 'manage' && manageVm && managing && (
            <ManageScreen
              vm={manageVm}
              cb={{
                onApprove: pk => {
                  void api.approve(coordFor(managing), pk).then(bump);
                },
                onDecline: pk => {
                  void api.decline(coordFor(managing), pk).then(bump);
                },
                onUndo: pk => {
                  void api.undoDecision(coordFor(managing), pk).then(bump);
                },
                onOfferSpot: npub => {
                  void api.offerSpot(coordFor(managing), npub).then(bump);
                },
                onEdit: () => openEditor(managing),
                onPreview: () => onPreview(coordFor(managing)),
                onMessageAll: message => {
                  void api.messageAll(coordFor(managing), message).then(bump);
                },
                onExportCsv: exportCsv,
                onCancelEvent: () => {
                  void api.cancel(coordFor(managing)).then(() => {
                    bump();
                    void refresh();
                  });
                },
                onBack: () => {
                  setManaging(null);
                  setScreen('list');
                  void refresh();
                },
              }}
            />
          )}
        </View>
      )}
    </BackModal>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
});
