import {useCallback, useRef} from 'react';
import {inProgressDraftId, type DraftLocation, type DraftStoreApi} from './drafts';

/**
 * Auto-save / restore the in-progress (unpublished, unsaved) draft for one composer location (No.7).
 *
 * Each composer location (feed, a public channel, a private group, a broadcast, or a DM) gets a
 * single stable autosave slot keyed by {@link inProgressDraftId}. Typing debounce-persists into the
 * slot; sending/clearing deletes it; reopening restores from it. The caller is responsible for not
 * persisting while editing an existing message (the slot is for the NEW message only).
 */
export function useInProgressDraft(
  draftStore: DraftStoreApi | undefined,
  location: DraftLocation,
): {persist: (content: string) => void; clear: () => void; load: () => Promise<string | null>} {
  const id = inProgressDraftId(location);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(
    (content: string) => {
      if (!draftStore) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (content.trim()) {
          void draftStore.save({id, title: '', content, tags: [], savedAt: Date.now(), location});
        } else {
          void draftStore.delete(id);
        }
      }, 600);
    },
    [draftStore, id, location],
  );

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (draftStore) void draftStore.delete(id);
  }, [draftStore, id]);

  const load = useCallback(async (): Promise<string | null> => {
    if (!draftStore) return null;
    const all = await draftStore.all();
    return all.find(d => d.id === id)?.content ?? null;
  }, [draftStore, id]);

  return {persist, clear, load};
}
