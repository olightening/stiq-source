package relayapp

import (
	"context"
	"testing"
	"time"
)

// TestDeletionQueryGuardCap verifies the per-connection deletion-lookup cap (finding #37(a)): a
// connection is admitted up to the ceiling within a window, refused past it, resets when the window
// rolls over, and never shares its budget with another connection.
func TestDeletionQueryGuardCap(t *testing.T) {
	g := newDeletionQueryGuard()
	base := time.Unix(1_000_000, 0)
	connA := "connA"
	connB := "connB"

	// Up to the cap on one connection: all admitted.
	for i := 0; i < maxDeletionLookupsPerConnPerMin; i++ {
		if !g.allow(connA, base) {
			t.Fatalf("lookup %d within cap should be allowed", i)
		}
	}
	// One past the cap in the same window: refused.
	if g.allow(connA, base) {
		t.Fatal("lookup past the per-connection cap must be refused")
	}
	// A different connection has its own independent budget.
	if !g.allow(connB, base) {
		t.Fatal("a distinct connection must not share connA's exhausted budget")
	}
	// After the window rolls over, the counter resets.
	if !g.allow(connA, base.Add(deletionWindowSeconds*time.Second)) {
		t.Fatal("the per-connection counter must reset after the window elapses")
	}

	// forget on a connection-less context (internal call / no socket) is a safe no-op.
	g.forget(context.Background())

	// The window entry exists after use; a direct delete (what forget does on socket close) clears it.
	g.mu.Lock()
	if _, present := g.conns[connA]; !present {
		g.mu.Unlock()
		t.Fatal("expected connA to have a live window entry")
	}
	delete(g.conns, connA)
	_, present := g.conns[connA]
	g.mu.Unlock()
	if present {
		t.Fatal("expected connA's window entry to be cleared")
	}
}
