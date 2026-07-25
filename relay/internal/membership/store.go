package membership

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ErrTokenSpent is returned by Bind/Spend when the token was already spent. It lets the policy
// layer distinguish a lost double-spend race (reject the event) from a real persistence failure.
// Bind/Spend re-check spent-ness under the write lock, so exactly one of two concurrent callers
// wins and the loser gets this error — a credential can never mint two accounts.
var ErrTokenSpent = errors.New("membership: token already spent")

// ErrInvalidEventID rejects retry-safe spending without a signed event identity.
var ErrInvalidEventID = errors.New("membership: invalid event id")

// Store tracks which tokens have been spent and which npubs are bound. Binding a token is
// one-shot: a credential can mint exactly one account (PLAN.md §3.3).
type Store interface {
	IsBound(pubkey string) bool
	IsSpent(tokenID string) bool
	// Bind marks the token spent and the pubkey bound, atomically. It re-checks spent-ness under
	// the write lock (compare-and-set): if the token was already spent it makes no change and
	// returns ErrTokenSpent, so two concurrent binds of one credential yield exactly one account.
	Bind(tokenID, pubkey string) error
	// Spend marks a per-post blind token spent WITHOUT binding an npub (PLAN.md §3.6 generalized),
	// where each post spends one token signed by a throwaway key and there is no stable pubkey to
	// bind. Like Bind it re-checks under the lock and returns ErrTokenSpent if the token was
	// already spent, so a token is honored exactly once even under a concurrent double-spend.
	Spend(tokenID string) error
	// SpendAll marks a SET of per-post tokens spent ATOMICALLY (all-or-nothing) under one write lock
	// with a single save. It returns ErrTokenSpent — changing NOTHING — if any id is already spent OR
	// if the batch contains a duplicate id. This is what makes weight-pricing un-gameable: an event
	// that must carry N tokens cannot satisfy its cost by presenting the SAME token N times (the
	// duplicate check rejects that), nor can it half-spend on a concurrent double-spend race.
	SpendAll(tokenIDs []string) error
	// SpendAllForEvent atomically spends tokens for one signed event. An exact retry with the same
	// event ID succeeds; reuse by a different event or a partial/duplicate batch fails closed.
	SpendAllForEvent(tokenIDs []string, eventID string) error
	// BoundAt returns the unix-second timestamp at which pubkey was bound, and whether a
	// timestamp is known. A bound member missing a timestamp (e.g. a record persisted before
	// timestamps were tracked) returns (0, false) — callers must treat that as "old enough" so
	// existing members are never locked out by newcomer rules.
	BoundAt(pubkey string) (int64, bool)
}

// MemStore is an in-memory Store with optional JSON persistence. A closed community is
// small, so a mutex-guarded map persisted on each bind is sufficient.
type MemStore struct {
	mu      sync.RWMutex
	bound   map[string]bool
	boundAt map[string]int64  // pubkey → unix-second bind time (for newcomer enforcement)
	spent   map[string]string // token ID -> owning event ID; empty means strict/legacy spend
	// spentDB, when set (persistent relay with a DataDir), is the AUTHORITATIVE spent-set: the
	// unbounded, hot-path spent tokens live in their own Badger DB (O(1) point-writes instead of a
	// full-file JSON rewrite per spend, and TTL-prunable once tokens expire) rather than the inline
	// map + membership.json. bound/boundAt always stay in the JSON file regardless.
	spentDB *badgerSpentSet
	now     func() time.Time
	path    string // "" disables bound/boundAt JSON persistence
}

type persisted struct {
	Bound []string `json:"bound"`
	// Spent is LEGACY: it is READ on load to import a pre-badger spent set, but no longer WRITTEN
	// (omitempty + save() never populates it) — the spent set now lives in the badger spent-set.
	Spent []string `json:"spent,omitempty"`
	// BoundAt records each pubkey's bind time (unix seconds). Kept alongside the legacy Bound
	// slice for back-compat: an entry present in Bound but absent here predates timestamping.
	BoundAt map[string]int64 `json:"bound_at,omitempty"`
	// SpentByEvent preserves retry ownership for DataDir-less relays. Legacy Spent records remain
	// strict and can never become retryable after an upgrade.
	SpentByEvent map[string]string `json:"spent_by_event,omitempty"`
}

func NewMemStore() *MemStore {
	return &MemStore{
		bound:   map[string]bool{},
		boundAt: map[string]int64{},
		spent:   map[string]string{},
		now:     time.Now,
	}
}

// LoadMemStore loads (or creates) a store whose bound/boundAt AND spent sets persist to the JSON
// file at path (the inline spent map is rewritten on each change — fine for the small in-memory /
// DataDir-less relay and for tests). The persistent relay uses LoadMemStoreWithBadgerSpent instead.
func LoadMemStore(path string) (*MemStore, error) {
	s := NewMemStore()
	if err := s.loadFrom(path); err != nil {
		return nil, err
	}
	return s, nil
}

// LoadMemStoreWithBadgerSpent keeps the (small) bound/boundAt npub state in the JSON file at
// jsonPath but backs the unbounded, hot-path spent-token set with a dedicated Badger DB at
// spentDir. A legacy membership.json `spent` array is imported into badger once on load; subsequent
// saves no longer rewrite it (removing the O(n) hot path). The caller must Close() the store.
func LoadMemStoreWithBadgerSpent(jsonPath, spentDir string) (*MemStore, error) {
	bset, err := openBadgerSpentSet(spentDir)
	if err != nil {
		return nil, err
	}
	s := NewMemStore()
	s.spentDB = bset
	if err := s.loadFrom(jsonPath); err != nil {
		_ = bset.close()
		return nil, err
	}
	return s, nil
}

// loadFrom reads bound/boundAt from the JSON file and imports any legacy `spent` array into the
// authoritative spent-set. A missing file starts empty. Sets s.path so future binds persist.
func (s *MemStore) loadFrom(path string) error {
	s.path = path
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var p persisted
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	for _, b := range p.Bound {
		s.bound[b] = true
	}
	for pk, ts := range p.BoundAt {
		s.bound[pk] = true // a timestamped pubkey is bound even if absent from the legacy slice
		s.boundAt[pk] = ts
	}
	// Import legacy spent ids (a mix of used binding credentials + per-post tokens). Into badger they
	// go as PERMANENT (ttl 0) — over-retaining a few is harmless, whereas dropping a used binding
	// credential's record would let it re-bind.
	for _, t := range p.Spent {
		if s.spentDB != nil {
			if err := s.spentDB.spend([]string{t}, 0); err != nil && !errors.Is(err, ErrTokenSpent) {
				return err
			}
		} else {
			s.spent[t] = ""
		}
	}
	for tokenID, eventID := range p.SpentByEvent {
		if eventID == "" {
			continue
		}
		if s.spentDB != nil {
			if err := s.spentDB.spendForEvent([]string{tokenID}, eventID, 0); err != nil && !errors.Is(err, ErrTokenSpent) {
				return err
			}
		} else if _, strictOrLegacy := s.spent[tokenID]; !strictOrLegacy {
			s.spent[tokenID] = eventID
		}
	}
	return nil
}

func (s *MemStore) IsBound(pubkey string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.bound[pubkey]
}

func (s *MemStore) IsSpent(tokenID string) bool {
	if s.spentDB != nil {
		return s.spentDB.isSpent(tokenID)
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.spent[tokenID]
	return ok
}

// BoundAt returns pubkey's bind time (unix seconds) and whether one is recorded. A bound
// member with no recorded timestamp returns (0, false).
func (s *MemStore) BoundAt(pubkey string) (int64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ts, ok := s.boundAt[pubkey]
	return ts, ok
}

func (s *MemStore) Bind(tokenID, pubkey string) error {
	// Marking the binding credential spent is the one-account-per-credential authority. Compare-and-set
	// (khatru serves events concurrently, so the policy layer's IsSpent pre-check is only advisory): if
	// two binds of the same credential race, exactly one wins and the loser gets ErrTokenSpent. The
	// binding token is PERMANENT (never TTL-pruned) — a credential must never become reusable.
	if s.spentDB != nil {
		// Bind the spent-record to the OWNING pubkey (spendForEvent) rather than a strict one-shot spend.
		// This makes a save() failure RECOVERABLE instead of permanently burning the credential: the
		// durable spend lands first, but if the subsequent bound/boundAt save() fails, a retry by the
		// SAME device re-runs Bind, the spend converges idempotently (the token is already owned by this
		// pubkey → spendForEvent returns nil), and the bound state is persisted on the retry. A DIFFERENT
		// device presenting the same credential still loses — spendForEvent returns ErrTokenSpent — so
		// double-spend protection is unchanged. ttl 0: the record is permanent (a credential must never
		// become reusable). Recovery is by idempotent re-bind on retry (above), not a boot-time scan:
		// loadFrom reads only the JSON bound state; the spent-set is the double-spend authority, not a
		// bound-state backup.
		if err := s.spentDB.spendForEvent([]string{tokenID}, pubkey, 0); err != nil {
			return err
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		s.bound[pubkey] = true
		s.boundAt[pubkey] = s.now().Unix()
		return s.save()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.spent[tokenID]; exists {
		return ErrTokenSpent
	}
	s.spent[tokenID] = ""
	s.bound[pubkey] = true
	s.boundAt[pubkey] = s.now().Unix()
	return s.save()
}

// Spend marks a per-post blind token spent without binding any npub. See the Store interface.
func (s *MemStore) Spend(tokenID string) error {
	if s.spentDB != nil {
		return s.spentDB.spend([]string{tokenID}, s.postingTTL())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.spent[tokenID]; exists {
		return ErrTokenSpent
	}
	s.spent[tokenID] = ""
	return s.save()
}

// SpendAll marks every id spent atomically (all-or-nothing, no intra-batch duplicate). This is what
// makes weight-pricing un-gameable: an event needing N tokens can't satisfy its cost with the same
// token N times, nor half-spend on a concurrent double-spend race.
func (s *MemStore) SpendAll(tokenIDs []string) error {
	if s.spentDB != nil {
		return s.spentDB.spend(tokenIDs, s.postingTTL())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := make(map[string]struct{}, len(tokenIDs))
	for _, id := range tokenIDs {
		if _, dup := seen[id]; dup {
			return ErrTokenSpent // the same token presented twice in one event — counts as spent
		}
		seen[id] = struct{}{}
		if _, exists := s.spent[id]; exists {
			return ErrTokenSpent
		}
	}
	for id := range seen {
		s.spent[id] = ""
	}
	return s.save()
}

// SpendAllForEvent spends a token batch for one specific event while making an exact transport
// retry idempotent. A partial existing batch is never completed later, preserving all-or-nothing
// weight pricing even if state was imported or externally modified.
func (s *MemStore) SpendAllForEvent(tokenIDs []string, eventID string) error {
	if eventID == "" {
		return ErrInvalidEventID
	}
	if s.spentDB != nil {
		return s.spentDB.spendForEvent(tokenIDs, eventID, s.postingTTL())
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	seen := make(map[string]struct{}, len(tokenIDs))
	owned := 0
	for _, id := range tokenIDs {
		if _, dup := seen[id]; dup {
			return ErrTokenSpent
		}
		seen[id] = struct{}{}
		if owner, exists := s.spent[id]; exists {
			if owner != eventID {
				return ErrTokenSpent
			}
			owned++
		}
	}
	if owned == len(seen) {
		return nil
	}
	if owned != 0 {
		return ErrTokenSpent
	}
	for id := range seen {
		s.spent[id] = eventID
	}
	return s.save()
}

// postingTTL is the self-prune lifetime for a PER-POST token's spent-record (badger only). It is 0
// (permanent, no pruning) until posting tokens are epoch-bound (per-epoch issuer keys): pruning a
// spent-record while its token can still be presented would re-open a double-spend, so it stays off
// until a token provably expires. Isolated here so enabling pruning later is a one-line change.
func (s *MemStore) postingTTL() time.Duration { return 0 }

// Close releases the badger spent-set when present. Safe on any MemStore (no-op for the inline map).
func (s *MemStore) Close() error {
	if s.spentDB != nil {
		return s.spentDB.close()
	}
	return nil
}

// save writes the store to disk. Caller holds the lock.
func (s *MemStore) save() error {
	if s.path == "" {
		return nil
	}
	var p persisted
	p.BoundAt = make(map[string]int64, len(s.boundAt))
	for b := range s.bound {
		p.Bound = append(p.Bound, b)
	}
	for pk, ts := range s.boundAt {
		p.BoundAt[pk] = ts
	}
	// The badger-backed spent-set persists itself, so we do NOT rewrite the spent array (that O(n)
	// per-bind rewrite is exactly what badger removes). The inline (DataDir-less) spent map is still
	// written here for back-compat. Legacy `spent` arrays are READ on load either way (loadFrom).
	if s.spentDB == nil {
		for tokenID, eventID := range s.spent {
			if eventID == "" {
				p.Spent = append(p.Spent, tokenID)
				continue
			}
			if p.SpentByEvent == nil {
				p.SpentByEvent = make(map[string]string)
			}
			p.SpentByEvent[tokenID] = eventID
		}
	}
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return writeFileAtomic(s.path, data, 0o600)
}

// writeFileAtomic writes data to a temp file in the target's directory, fsyncs it, then renames
// it over the target. os.WriteFile truncates-then-writes in place, so a crash mid-write leaves a
// half-written membership.json that bricks relay startup; rename is atomic on POSIX (the relay
// deploys to Linux), so a reader ever sees either the old file or the complete new one.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// Best-effort cleanup: if we return before the rename, drop the temp file.
	defer func() { _ = os.Remove(tmpName) }()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
