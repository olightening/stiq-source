/**
 * useNewWhileAway — counts messages that arrived while the reader is scrolled away from the
 * "latest" edge of a transcript. Drives the "N new" count on the floating return-to-latest
 * button in channels/groups/DMs — the per-space sibling of the feed's "N new posts" pill
 * (AppSnapshot.newFeedItemCount), scoped to the view because that is where the scroll state lives.
 *
 * Contract:
 *  • While `away` is false the count is 0 and no baseline exists — a reader at the latest edge
 *    watches new messages land in place, so there is nothing to announce.
 *  • On the false→true transition the newest wire timestamp then in the transcript becomes the
 *    floor; the count is how many items sit ABOVE that floor.
 *  • The floor is a `createdAt` comparison, never a positional one. Positions assume chronology,
 *    and the feed-hold work already paid for that assumption once (a backfilled item can land
 *    anywhere in the array). A timestamp floor also keeps older history paged in during the
 *    scroll-up — the usual reason the reader is away in the first place — out of the count.
 *  • Returning to the latest edge (however: tap or scroll) drops the floor and the count.
 */
import {useEffect, useRef, useState} from 'react';

export function useNewWhileAway<T>(
  items: readonly T[],
  createdAt: (item: T) => number,
  away: boolean,
): number {
  /** Newest wire timestamp on screen at the moment the reader scrolled away; undefined = at edge. */
  const [floor, setFloor] = useState<number | undefined>(undefined);
  // Latest-value refs so the transition effect below keys on `away` ALONE: re-arming it on every
  // arrival would re-snapshot the floor and swallow the very messages it exists to count.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const createdAtRef = useRef(createdAt);
  createdAtRef.current = createdAt;

  useEffect(() => {
    if (!away) {
      setFloor(undefined);
      return;
    }
    let max = 0;
    for (const it of itemsRef.current) {
      const t = createdAtRef.current(it);
      if (t > max) max = t;
    }
    setFloor(max);
  }, [away]);

  if (!away || floor === undefined) return 0;
  let n = 0;
  for (const it of items) if (createdAt(it) > floor) n++;
  return n;
}
