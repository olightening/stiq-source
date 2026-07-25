package membership

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newBadger(t *testing.T) *badgerSpentSet {
	t.Helper()
	b, err := openBadgerSpentSet(t.TempDir())
	if err != nil {
		t.Fatalf("open badger spent set: %v", err)
	}
	t.Cleanup(func() { _ = b.close() })
	return b
}

func TestBadgerSpentSpendOnceThenReplayRejected(t *testing.T) {
	b := newBadger(t)
	if b.isSpent("tok") {
		t.Fatal("fresh set should be empty")
	}
	if err := b.spend([]string{"tok"}, 0); err != nil {
		t.Fatalf("first spend: %v", err)
	}
	if !b.isSpent("tok") {
		t.Fatal("token should be spent")
	}
	if err := b.spend([]string{"tok"}, 0); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("replay should be ErrTokenSpent, got %v", err)
	}
}

func TestBadgerEventSpendAllowsExactRetryOnly(t *testing.T) {
	b := newBadger(t)
	tokens := []string{"event-tok-a", "event-tok-b"}
	if err := b.spendForEvent(tokens, "event-a", 0); err != nil {
		t.Fatalf("first event spend: %v", err)
	}
	if err := b.spendForEvent(tokens, "event-a", 0); err != nil {
		t.Fatalf("exact event retry: %v", err)
	}
	if err := b.spendForEvent(tokens, "event-b", 0); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("different event should be ErrTokenSpent, got %v", err)
	}
	if err := b.spendForEvent([]string{"event-tok-a", "new-token"}, "event-a", 0); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("partial owned batch should be ErrTokenSpent, got %v", err)
	}
	if b.isSpent("new-token") {
		t.Fatal("rejected partial batch must not spend its new token")
	}
	if err := b.spend([]string{"legacy-token"}, 0); err != nil {
		t.Fatalf("legacy spend: %v", err)
	}
	if err := b.spendForEvent([]string{"legacy-token"}, "event-a", 0); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("strict legacy record must not become retryable, got %v", err)
	}
}

// SpendAll must be all-or-nothing: a batch containing an already-spent id (or an intra-batch
// duplicate) changes nothing, so an event never half-pays — the un-gameability guarantee.
func TestBadgerSpentSpendAllAtomic(t *testing.T) {
	b := newBadger(t)
	if err := b.spend([]string{"a", "b", "c"}, 0); err != nil {
		t.Fatalf("spend batch: %v", err)
	}
	if err := b.spend([]string{"d", "b", "e"}, 0); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("batch with a spent id should be ErrTokenSpent, got %v", err)
	}
	if b.isSpent("d") || b.isSpent("e") {
		t.Fatal("d and e must be untouched after the rejected batch")
	}
	if err := b.spend([]string{"f", "f"}, 0); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("intra-batch dup should be ErrTokenSpent, got %v", err)
	}
	if b.isSpent("f") {
		t.Fatal("f must be untouched after the dup-rejected batch")
	}
}

// The end-to-end double-spend guard under contention: N goroutines race one token; badger SSI +
// the ErrConflict retry must let exactly one win.
func TestBadgerSpentConcurrentOneWinner(t *testing.T) {
	const n = 64
	b := newBadger(t)
	var (
		wg        sync.WaitGroup
		start     = make(chan struct{})
		successes atomic.Int64
	)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			switch err := b.spend([]string{"contended"}, 0); {
			case err == nil:
				successes.Add(1)
			case errors.Is(err, ErrTokenSpent):
				// lost the race — expected
			default:
				t.Errorf("unexpected spend error: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()
	if got := successes.Load(); got != 1 {
		t.Fatalf("token must be spent exactly once under contention, got %d", got)
	}
}

func TestBadgerConcurrentExactEventSpendsAreIdempotent(t *testing.T) {
	const n = 64
	b := newBadger(t)
	var (
		wg        sync.WaitGroup
		start     = make(chan struct{})
		successes atomic.Int64
	)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if err := b.spendForEvent([]string{"same-event-token"}, "event-a", 0); err == nil {
				successes.Add(1)
			} else {
				t.Errorf("exact concurrent retry failed: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()
	if got := successes.Load(); got != n {
		t.Fatalf("all exact retries should succeed, got %d of %d", got, n)
	}
}

func TestBadgerSpentSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	b1, err := openBadgerSpentSet(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := b1.spend([]string{"persist"}, 0); err != nil {
		t.Fatalf("spend: %v", err)
	}
	if err := b1.close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	b2, err := openBadgerSpentSet(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer b2.close()
	if !b2.isSpent("persist") {
		t.Fatal("spent record must survive a restart")
	}
}

func TestBadgerEventSpendOwnershipSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	b1, err := openBadgerSpentSet(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := b1.spendForEvent([]string{"persist-owned"}, "event-a", 0); err != nil {
		t.Fatalf("spend: %v", err)
	}
	if err := b1.close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	b2, err := openBadgerSpentSet(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer b2.close()
	if err := b2.spendForEvent([]string{"persist-owned"}, "event-a", 0); err != nil {
		t.Fatalf("exact retry after restart: %v", err)
	}
	if err := b2.spendForEvent([]string{"persist-owned"}, "event-b", 0); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("different event after restart should be ErrTokenSpent, got %v", err)
	}
}

// TTL is the pruning mechanism (kept OFF in production until tokens are epoch-bound). This proves it
// works: a record with a short TTL expires and the id becomes spendable again — which is precisely
// why enabling TTL is only safe once a token provably expires with its epoch key.
func TestBadgerSpentTTLPrunes(t *testing.T) {
	b := newBadger(t)
	if err := b.spend([]string{"ephemeral"}, 1*time.Second); err != nil {
		t.Fatalf("spend with ttl: %v", err)
	}
	if !b.isSpent("ephemeral") {
		t.Fatal("token should be spent immediately after spend")
	}
	time.Sleep(1500 * time.Millisecond)
	if b.isSpent("ephemeral") {
		t.Fatal("spent record should have expired after its TTL")
	}
	if err := b.spend([]string{"ephemeral"}, 1*time.Second); err != nil {
		t.Fatalf("re-spend after TTL prune: %v", err)
	}
}

// MemStore with a badger spent-set: legacy JSON `spent` blob imports, per-post spends go to badger
// (NOT the JSON), and everything survives a restart. Bound state stays in the JSON file.
func TestMemStoreBadgerMigratesAndPersists(t *testing.T) {
	dir := t.TempDir()
	jsonPath := filepath.Join(dir, "membership.json")
	spentDir := filepath.Join(dir, "spent")
	if err := os.WriteFile(jsonPath, []byte(`{"bound":["npubA"],"spent":["legacytok"],"bound_at":{"npubA":123}}`), 0o600); err != nil {
		t.Fatalf("write legacy: %v", err)
	}

	s, err := LoadMemStoreWithBadgerSpent(jsonPath, spentDir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !s.IsSpent("legacytok") {
		t.Fatal("legacy spent id must be imported into badger")
	}
	if !s.IsBound("npubA") {
		t.Fatal("bound member must load")
	}
	if err := s.SpendAll([]string{"newtok"}); err != nil {
		t.Fatalf("spendall: %v", err)
	}
	// A Bind triggers a JSON save; the rewritten file must NOT carry the spent set (badger owns it).
	if err := s.Bind("bindtok", "npubB"); err != nil {
		t.Fatalf("bind: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	data, _ := os.ReadFile(jsonPath)
	for _, tok := range []string{"newtok", "legacytok", "bindtok"} {
		if strings.Contains(string(data), tok) {
			t.Fatalf("badger-backed spent token %q must not be written to membership.json: %s", tok, data)
		}
	}

	s2, err := LoadMemStoreWithBadgerSpent(jsonPath, spentDir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	defer s2.Close()
	for _, tok := range []string{"legacytok", "newtok", "bindtok"} {
		if !s2.IsSpent(tok) {
			t.Fatalf("spent token %q must survive restart in badger", tok)
		}
	}
	if !s2.IsBound("npubA") || !s2.IsBound("npubB") {
		t.Fatal("bound members must survive restart")
	}
}
