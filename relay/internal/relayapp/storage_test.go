package relayapp

import (
	"context"
	"testing"

	"github.com/fiatjaf/eventstore/badger"
	"github.com/nbd-wtf/go-nostr"
)

// TestBadgerPersistsAcrossReopen proves the persistent backend survives a restart:
// write an event, close the store, reopen the same directory, and read it back.
func TestBadgerPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	sk, _ := keypair(t)
	ev := signed(t, sk, 1, "persist me across a restart")
	ctx := context.Background()

	db1 := &badger.BadgerBackend{Path: dir}
	if err := db1.Init(); err != nil {
		t.Fatalf("init #1: %v", err)
	}
	if err := db1.SaveEvent(ctx, ev); err != nil {
		t.Fatalf("save: %v", err)
	}
	db1.Close()

	db2 := &badger.BadgerBackend{Path: dir}
	if err := db2.Init(); err != nil {
		t.Fatalf("init #2 (reopen): %v", err)
	}
	defer db2.Close()

	ch, err := db2.QueryEvents(ctx, nostr.Filter{IDs: []string{ev.ID}})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	got := <-ch
	if got == nil || got.ID != ev.ID {
		t.Fatalf("expected event %s to persist across reopen, got %+v", ev.ID, got)
	}
}
