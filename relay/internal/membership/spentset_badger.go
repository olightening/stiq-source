package membership

import (
	"encoding/binary"
	"errors"
	"time"

	badger "github.com/dgraph-io/badger/v4"

	"github.com/stiq/relay/internal/badgeropts"
)

// badgerSpentSet persists the spent-token set in its own Badger DB (a subdir separate from the
// event store). Point writes replace the old O(n) full-file membership.json rewrite, and per-entry
// TTL lets records self-prune once their token expires (enabled only when posting tokens become
// epoch-bound). It is the double-spend authority under khatru's concurrent event handling.
type badgerSpentSet struct {
	db *badger.DB
}

// openBadgerSpentSet opens (or creates) the spent-set DB at dir. The caller owns close().
func openBadgerSpentSet(dir string) (*badgerSpentSet, error) {
	// Badger's default INFO logging would spam the relay's log; silence it (the relay logs its own).
	opts := badgeropts.SpentSet(badger.DefaultOptions(dir)).WithLogger(nil)
	db, err := badger.Open(opts)
	if err != nil {
		return nil, err
	}
	return &badgerSpentSet{db: db}, nil
}

func spentKey(id string) []byte { return append([]byte("spent:"), id...) }

func (b *badgerSpentSet) isSpent(id string) bool {
	found := false
	_ = b.db.View(func(txn *badger.Txn) error {
		if _, err := txn.Get(spentKey(id)); err == nil {
			found = true
		}
		return nil
	})
	return found
}

// spend is the strict one-shot path used by binding credentials and legacy callers.
func (b *badgerSpentSet) spend(ids []string, ttl time.Duration) error {
	return b.spendOwned(ids, "", ttl)
}

// spendForEvent binds a per-post token batch to one cryptographic event ID.
func (b *badgerSpentSet) spendForEvent(ids []string, eventID string, ttl time.Duration) error {
	if eventID == "" {
		return ErrInvalidEventID
	}
	return b.spendOwned(ids, eventID, ttl)
}

// spendOwned writes the whole batch in one transaction. Conflict retries make concurrent exact
// retries converge on success while different events racing the same token still have one winner.
func (b *badgerSpentSet) spendOwned(ids []string, eventID string, ttl time.Duration) error {
	// Reject an intra-batch duplicate up front (a token presented twice in one event counts once).
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if _, dup := seen[id]; dup {
			return ErrTokenSpent
		}
		seen[id] = struct{}{}
	}
	// Preserve the legacy eight-byte epoch prefix and append an owner only for retry-safe posts.
	// An eight-byte-only value remains a strict, non-retryable legacy/binding spend.
	value := make([]byte, 8, 8+len(eventID))
	binary.BigEndian.PutUint64(value, uint64(time.Now().Unix()/86400))
	value = append(value, eventID...)

	// db.Update does NOT auto-retry: on a write-write race the loser's Commit returns ErrConflict.
	// Re-run so the loser observes the winner's committed owner. Bound the loop so pathological
	// contention can never spin forever.
	for attempt := 0; attempt < 16; attempt++ {
		err := b.db.Update(func(txn *badger.Txn) error {
			owned := 0
			for id := range seen {
				switch item, gerr := txn.Get(spentKey(id)); {
				case gerr == nil:
					if eventID == "" {
						return ErrTokenSpent
					}
					stored, err := item.ValueCopy(nil)
					if err != nil {
						return err
					}
					if len(stored) <= 8 || string(stored[8:]) != eventID {
						return ErrTokenSpent
					}
					owned++
				case errors.Is(gerr, badger.ErrKeyNotFound):
					// unspent — will be set below
				default:
					return gerr
				}
			}
			if owned == len(seen) {
				return nil
			}
			if owned != 0 {
				return ErrTokenSpent
			}
			for id := range seen {
				e := badger.NewEntry(spentKey(id), value)
				if ttl > 0 {
					e = e.WithTTL(ttl)
				}
				if serr := txn.SetEntry(e); serr != nil {
					return serr
				}
			}
			return nil
		})
		if errors.Is(err, badger.ErrConflict) {
			continue // lost the race; retry now observes the winner and returns ErrTokenSpent
		}
		return err
	}
	// Exhausted retries under extreme contention: reject this event (safe — never admits a double-spend).
	return ErrTokenSpent
}

func (b *badgerSpentSet) close() error { return b.db.Close() }
