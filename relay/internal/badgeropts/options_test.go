package badgeropts

import (
	"testing"

	badger "github.com/dgraph-io/badger/v4"
)

func TestEventStoreProfile(t *testing.T) {
	opts := EventStore(badger.DefaultOptions(t.TempDir()))
	if opts.MemTableSize != eventMemTableSize {
		t.Fatalf("MemTableSize = %d, want %d", opts.MemTableSize, eventMemTableSize)
	}
	if opts.NumMemtables != boundedMemtables {
		t.Fatalf("NumMemtables = %d, want %d", opts.NumMemtables, boundedMemtables)
	}
	if opts.BlockCacheSize != eventBlockCache {
		t.Fatalf("BlockCacheSize = %d, want %d", opts.BlockCacheSize, eventBlockCache)
	}
	if opts.NumCompactors != boundedCompactors {
		t.Fatalf("NumCompactors = %d, want %d", opts.NumCompactors, boundedCompactors)
	}
}

func TestSpentSetProfile(t *testing.T) {
	opts := SpentSet(badger.DefaultOptions(t.TempDir()))
	if opts.MemTableSize != spentMemTableSize {
		t.Fatalf("MemTableSize = %d, want %d", opts.MemTableSize, spentMemTableSize)
	}
	if opts.NumMemtables != boundedMemtables {
		t.Fatalf("NumMemtables = %d, want %d", opts.NumMemtables, boundedMemtables)
	}
	if opts.BlockCacheSize != spentBlockCache {
		t.Fatalf("BlockCacheSize = %d, want %d", opts.BlockCacheSize, spentBlockCache)
	}
	if opts.ValueThreshold != spentValueThreshold {
		t.Fatalf("ValueThreshold = %d, want %d", opts.ValueThreshold, spentValueThreshold)
	}
	if opts.NumCompactors != boundedCompactors {
		t.Fatalf("NumCompactors = %d, want %d", opts.NumCompactors, boundedCompactors)
	}
}
