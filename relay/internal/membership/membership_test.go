package membership

import (
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func issuerKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	sk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen issuer key: %v", err)
	}
	return sk
}

func randomToken(t *testing.T) []byte {
	t.Helper()
	tok := make([]byte, 32)
	if _, err := rand.Read(tok); err != nil {
		t.Fatalf("rand token: %v", err)
	}
	return tok
}

// Full RFC 9474 blind round trip: the issuer signs a blinded token without seeing it, and
// the resulting credential verifies under the issuer public key.
func TestBlindCredentialEndToEnd(t *testing.T) {
	sk := issuerKey(t)
	issuer := NewIssuer(sk)
	token := randomToken(t)

	var sawBlinded []byte
	cred, err := RequestCredential(&sk.PublicKey, token, func(blinded []byte) ([]byte, error) {
		sawBlinded = append([]byte(nil), blinded...) // what the issuer actually sees
		return issuer.BlindSign(blinded)
	})
	if err != nil {
		t.Fatalf("RequestCredential: %v", err)
	}

	if !Verify(&sk.PublicKey, cred) {
		t.Fatal("expected a valid credential")
	}
	// Unlinkability sanity: the issuer never saw the raw token.
	if string(sawBlinded) == string(token) {
		t.Fatal("issuer saw the unblinded token — blinding failed")
	}
}

func TestVerifyRejectsWrongIssuer(t *testing.T) {
	sk := issuerKey(t)
	other := issuerKey(t)
	issuer := NewIssuer(sk)
	cred, err := RequestCredential(&sk.PublicKey, randomToken(t), issuer.BlindSign)
	if err != nil {
		t.Fatalf("RequestCredential: %v", err)
	}
	if Verify(&other.PublicKey, cred) {
		t.Fatal("credential verified under the wrong issuer key")
	}
	if !VerifyAny([]*rsa.PublicKey{&other.PublicKey, &sk.PublicKey}, cred) {
		t.Fatal("VerifyAny should accept when one key matches")
	}
}

func TestStoreBindIsOneShot(t *testing.T) {
	s := NewMemStore()
	id := TokenID(randomToken(t))

	if s.IsSpent(id) || s.IsBound("npubA") {
		t.Fatal("fresh store should be empty")
	}
	if err := s.Bind(id, "npubA"); err != nil {
		t.Fatalf("bind: %v", err)
	}
	if !s.IsSpent(id) {
		t.Fatal("token should be spent after bind")
	}
	if !s.IsBound("npubA") {
		t.Fatal("npubA should be bound")
	}
	if s.IsBound("npubB") {
		t.Fatal("npubB was never bound")
	}
}

func TestStorePersistsAcrossReload(t *testing.T) {
	path := t.TempDir() + "/membership.json"
	s1, err := LoadMemStore(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	id := TokenID(randomToken(t))
	if err := s1.Bind(id, "npubA"); err != nil {
		t.Fatalf("bind: %v", err)
	}

	s2, err := LoadMemStore(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !s2.IsBound("npubA") || !s2.IsSpent(id) {
		t.Fatal("membership state did not persist across reload")
	}
}

func TestBoundAtStampedAndPersists(t *testing.T) {
	path := t.TempDir() + "/membership.json"
	s1, err := LoadMemStore(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// Pin the clock so the asserted bind time is deterministic.
	fixed := time.Unix(1_700_000_000, 0)
	s1.now = func() time.Time { return fixed }

	if _, ok := s1.BoundAt("npubA"); ok {
		t.Fatal("unbound pubkey must have no bind time")
	}
	if err := s1.Bind(TokenID(randomToken(t)), "npubA"); err != nil {
		t.Fatalf("bind: %v", err)
	}
	ts, ok := s1.BoundAt("npubA")
	if !ok || ts != fixed.Unix() {
		t.Fatalf("expected bind time %d, got %d (ok=%v)", fixed.Unix(), ts, ok)
	}

	// Survives a JSON round-trip.
	s2, err := LoadMemStore(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if ts2, ok := s2.BoundAt("npubA"); !ok || ts2 != fixed.Unix() {
		t.Fatalf("bind time did not persist: got %d (ok=%v)", ts2, ok)
	}
}

// TestConcurrentBindOneWinner is the double-spend regression: N goroutines race to bind the same
// credential to different pubkeys. Exactly one must win; every loser must get ErrTokenSpent. Before
// the compare-and-set fix the IsSpent check and the Bind were separate lock acquisitions, so
// several goroutines could pass the check and all bind — one credential minting many accounts.
func TestConcurrentBindOneWinner(t *testing.T) {
	const n = 64
	s := NewMemStore()
	id := TokenID(randomToken(t))

	var (
		wg        sync.WaitGroup
		start     = make(chan struct{})
		successes atomic.Int64
		spentErrs atomic.Int64
	)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start // release all goroutines together to maximize contention
			pubkey := "npub-" + strconv.Itoa(i)
			// Call Bind directly (no advisory IsSpent pre-check): Bind is the atomic authority and
			// must by itself guarantee exactly-one, since the policy layer's pre-check only ever
			// shrinks the race window, never closes it.
			switch err := s.Bind(id, pubkey); {
			case err == nil:
				successes.Add(1)
			case errors.Is(err, ErrTokenSpent):
				spentErrs.Add(1)
			default:
				t.Errorf("unexpected bind error: %v", err)
			}
		}(i)
	}
	close(start)
	wg.Wait()

	if got := successes.Load(); got != 1 {
		t.Fatalf("expected exactly one successful bind, got %d", got)
	}
	// Every loser must have been rejected with ErrTokenSpent (not silently succeeded or errored).
	if got := spentErrs.Load(); got != n-1 {
		t.Fatalf("expected %d ErrTokenSpent losers, got %d", n-1, got)
	}
	// Exactly one pubkey may be bound — the credential minted one account, not several.
	bound := 0
	for i := 0; i < n; i++ {
		if s.IsBound("npub-" + strconv.Itoa(i)) {
			bound++
		}
	}
	if bound != 1 {
		t.Fatalf("expected exactly one bound pubkey, got %d", bound)
	}
}

// TestConcurrentSpendOnce is the blind-token analogue: N goroutines race to spend one per-post
// token. Exactly one succeeds; the rest see ErrTokenSpent. This guards the same check-then-act
// race on the Spend path added by the blind-posting merge.
func TestConcurrentSpendOnce(t *testing.T) {
	const n = 64
	s := NewMemStore()
	id := TokenID(randomToken(t))

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
			// Call Spend directly — Spend is the atomic authority (see TestConcurrentBindOneWinner).
			switch err := s.Spend(id); {
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
		t.Fatalf("expected the token to be spent exactly once, got %d successes", got)
	}
	if !s.IsSpent(id) {
		t.Fatal("token should be spent after the race")
	}
}

func TestEventSpendAllowsExactRetryOnly(t *testing.T) {
	s := NewMemStore()
	tokens := []string{"tok-a", "tok-b"}

	if err := s.SpendAllForEvent(tokens, "event-a"); err != nil {
		t.Fatalf("first event spend: %v", err)
	}
	if err := s.SpendAllForEvent(tokens, "event-a"); err != nil {
		t.Fatalf("exact event retry: %v", err)
	}
	if err := s.SpendAllForEvent(tokens, "event-b"); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("different event should be ErrTokenSpent, got %v", err)
	}
	if err := s.SpendAllForEvent([]string{"tok-a", "tok-c"}, "event-a"); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("partial owned batch should be ErrTokenSpent, got %v", err)
	}
	if s.IsSpent("tok-c") {
		t.Fatal("rejected partial batch must not spend new tokens")
	}
	if err := s.SpendAllForEvent([]string{"tok-d"}, ""); !errors.Is(err, ErrInvalidEventID) {
		t.Fatalf("empty event ID should be ErrInvalidEventID, got %v", err)
	}
}

func TestEventSpendOwnershipPersistsInJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "membership.json")
	s1, err := LoadMemStore(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := s1.SpendAllForEvent([]string{"persist-event-token"}, "event-a"); err != nil {
		t.Fatalf("first event spend: %v", err)
	}

	s2, err := LoadMemStore(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if err := s2.SpendAllForEvent([]string{"persist-event-token"}, "event-a"); err != nil {
		t.Fatalf("exact retry after reload: %v", err)
	}
	if err := s2.SpendAllForEvent([]string{"persist-event-token"}, "event-b"); !errors.Is(err, ErrTokenSpent) {
		t.Fatalf("different event after reload should be ErrTokenSpent, got %v", err)
	}
}

func TestConcurrentExactEventSpendsAreIdempotent(t *testing.T) {
	const n = 64
	s := NewMemStore()
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
			if err := s.SpendAllForEvent([]string{"same-event-token"}, "event-a"); err == nil {
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

// TestSaveIsAtomic proves the temp-file+rename write leaves no half-written file behind: after a
// bind, the on-disk membership.json is complete and reloads, and no leftover temp file remains in
// the directory. (We can't easily inject a mid-write crash in-process, so we assert the invariant
// the atomic write guarantees: the target is only ever the fully-marshaled JSON.)
func TestSaveIsAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "membership.json")
	s, err := LoadMemStore(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	for i := 0; i < 10; i++ {
		if err := s.Bind(TokenID(randomToken(t)), "npub-"+strconv.Itoa(i)); err != nil {
			t.Fatalf("bind %d: %v", i, err)
		}
	}

	// The written file must parse and round-trip cleanly (never a truncated fragment).
	if _, err := LoadMemStore(path); err != nil {
		t.Fatalf("reload after atomic writes: %v", err)
	}

	// No orphaned temp files should linger in the directory.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if e.Name() != "membership.json" {
			t.Fatalf("unexpected leftover file in dir: %q", e.Name())
		}
	}
}

// TestBoundWithoutTimestampTreatedAsOld covers the back-compat path: a member persisted before
// timestamping (present in the legacy `bound` slice, absent from `bound_at`) is still bound but
// reports no bind time — so newcomer rules treat them as an existing member.
func TestBoundWithoutTimestampTreatedAsOld(t *testing.T) {
	path := t.TempDir() + "/membership.json"
	// Hand-write a legacy file with no bound_at map.
	if err := os.WriteFile(path, []byte(`{"bound":["legacyNpub"],"spent":["tok1"]}`), 0o600); err != nil {
		t.Fatalf("write legacy file: %v", err)
	}
	s, err := LoadMemStore(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !s.IsBound("legacyNpub") {
		t.Fatal("legacy member should still be bound")
	}
	if _, ok := s.BoundAt("legacyNpub"); ok {
		t.Fatal("legacy member must report no bind time (treated as old)")
	}
}
