package relayapp

import (
	"context"
	"fmt"
	"sync"

	"github.com/fiatjaf/eventstore"
	"github.com/fiatjaf/eventstore/slicestore"
	"github.com/nbd-wtf/go-nostr"
)

// lockedSliceStore makes eventstore's development-only SliceStore safe for the
// concurrent readers and writers Khatru starts per WebSocket. Production uses
// Badger; this wrapper keeps ephemeral relays and integration tests race-free.
type lockedSliceStore struct {
	mu    sync.RWMutex
	store slicestore.SliceStore
}

func (s *lockedSliceStore) Init() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.store.Init()
}

func (s *lockedSliceStore) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.store.Close()
}

func (s *lockedSliceStore) SaveEvent(ctx context.Context, event *nostr.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.store.SaveEvent(ctx, event)
}

func (s *lockedSliceStore) DeleteEvent(ctx context.Context, event *nostr.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.store.DeleteEvent(ctx, event)
}

func (s *lockedSliceStore) ReplaceEvent(ctx context.Context, event *nostr.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	filter := nostr.Filter{Limit: 1, Kinds: []int{event.Kind}, Authors: []string{event.PubKey}}
	if nostr.IsAddressableKind(event.Kind) {
		filter.Tags = nostr.TagMap{"d": []string{event.Tags.GetD()}}
	}
	source, err := s.store.QueryEvents(ctx, filter)
	if err != nil {
		return fmt.Errorf("query before replacing: %w", err)
	}
	previous, complete := drainEventChannel(ctx, source)
	if !complete {
		return ctx.Err()
	}

	shouldStore := true
	for _, candidate := range previous {
		if eventIsOlder(candidate, event) {
			if err := s.store.DeleteEvent(ctx, candidate); err != nil {
				return fmt.Errorf("delete event for replacing: %w", err)
			}
		} else {
			shouldStore = false
		}
	}
	if shouldStore {
		if err := s.store.SaveEvent(ctx, event); err != nil && err != eventstore.ErrDupEvent {
			return fmt.Errorf("save replacement: %w", err)
		}
	}
	return nil
}

func (s *lockedSliceStore) CountEvents(ctx context.Context, filter nostr.Filter) (int64, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.store.CountEvents(ctx, filter)
}

func (s *lockedSliceStore) QueryEvents(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
	s.mu.RLock()
	source, err := s.store.QueryEvents(ctx, filter)
	if err != nil {
		s.mu.RUnlock()
		return nil, err
	}

	// SliceStore's query goroutine reads its backing slice after QueryEvents returns.
	// Drain it while holding the read lock, then return an independent buffered snapshot.
	events, complete := drainEventChannel(ctx, source)
	s.mu.RUnlock()
	if !complete {
		events = nil
	}
	result := make(chan *nostr.Event, len(events))
	for _, event := range events {
		result <- event
	}
	close(result)
	return result, nil
}

func drainEventChannel(ctx context.Context, source <-chan *nostr.Event) ([]*nostr.Event, bool) {
	events := make([]*nostr.Event, 0)
	for {
		select {
		case event, ok := <-source:
			if !ok {
				return events, true
			}
			events = append(events, event)
		case <-ctx.Done():
			return events, false
		}
	}
}

func eventIsOlder(previous, next *nostr.Event) bool {
	return previous.CreatedAt < next.CreatedAt ||
		(previous.CreatedAt == next.CreatedAt && previous.ID > next.ID)
}
