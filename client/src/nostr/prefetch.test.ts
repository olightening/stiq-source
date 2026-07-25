import type {ReqFilter} from './protocol';
import {prefetchPriorityContent, type PrefetchRelay} from './prefetch';

/** A fake relay recording every fetchById / fetchByFilter call for assertions. */
class RecordingRelay implements PrefetchRelay {
  readonly byId: string[][] = [];
  readonly byFilter: ReqFilter[][] = [];
  fetchById(ids: string[]): void {
    this.byId.push(ids);
  }
  fetchByFilter(filters: ReqFilter[]): void {
    this.byFilter.push(filters);
  }
}

describe('prefetchPriorityContent (T10-S6 low-bandwidth priority pulls)', () => {
  it('pinned-only → one fetchById, no fetchByFilter', () => {
    const relay = new RecordingRelay();
    prefetchPriorityContent(relay, {pinnedMessageId: 'pin1'});
    expect(relay.byId).toEqual([['pin1']]);
    expect(relay.byFilter).toEqual([]);
  });

  it('organizer-only → one fetchByFilter with {authors, kinds, limit}, no fetchById', () => {
    const relay = new RecordingRelay();
    prefetchPriorityContent(relay, {organizerPubkey: 'orgpub'});
    expect(relay.byId).toEqual([]);
    expect(relay.byFilter).toEqual([[{authors: ['orgpub'], kinds: [1], limit: 10}]]);
  });

  it('both targets → both pulls fire', () => {
    const relay = new RecordingRelay();
    prefetchPriorityContent(relay, {pinnedMessageId: 'pin1', organizerPubkey: 'orgpub'});
    expect(relay.byId).toEqual([['pin1']]);
    expect(relay.byFilter).toEqual([[{authors: ['orgpub'], kinds: [1], limit: 10}]]);
  });

  it('neither target → no calls at all', () => {
    const relay = new RecordingRelay();
    prefetchPriorityContent(relay, {});
    expect(relay.byId).toEqual([]);
    expect(relay.byFilter).toEqual([]);
  });

  it('honors a custom postKind and limit for the organizer pull', () => {
    const relay = new RecordingRelay();
    prefetchPriorityContent(relay, {organizerPubkey: 'orgpub', postKind: 30023, limit: 3});
    expect(relay.byFilter).toEqual([[{authors: ['orgpub'], kinds: [30023], limit: 3}]]);
  });

  it('is defensive: never throws when the relay methods are absent', () => {
    // A structurally-incomplete relay (neither method present) must not crash the prefetch.
    expect(() =>
      prefetchPriorityContent({}, {pinnedMessageId: 'pin1', organizerPubkey: 'orgpub'}),
    ).not.toThrow();
  });

  it('is defensive: never throws when a relay method itself throws', () => {
    const relay: Partial<PrefetchRelay> = {
      fetchById: () => {
        throw new Error('fetchById exploded');
      },
      fetchByFilter: () => {
        throw new Error('fetchByFilter exploded');
      },
    };
    expect(() =>
      prefetchPriorityContent(relay, {pinnedMessageId: 'pin1', organizerPubkey: 'orgpub'}),
    ).not.toThrow();
  });
});
