// Package badgeropts defines the relay's bounded-memory Badger profiles.
//
// Badger's defaults are tuned for much larger hosts: each DB starts with a
// 64 MiB memtable and a 256 MiB block cache. The relay opens two databases, so
// those defaults can make a small server spend most of its time under cgroup
// memory pressure even when the stored dataset is tiny.
package badgeropts

import badger "github.com/dgraph-io/badger/v4"

const (
	eventMemTableSize   = 16 << 20
	eventBlockCache     = 32 << 20
	spentMemTableSize   = 4 << 20
	spentBlockCache     = 8 << 20
	spentValueThreshold = 1 << 10
	boundedMemtables    = 2
	boundedCompactors   = 2
)

// EventStore keeps enough write and read cache for normal relay traffic while
// bounding the event database's dominant in-memory allocations.
func EventStore(opts badger.Options) badger.Options {
	return opts.
		WithMemTableSize(eventMemTableSize).
		WithNumMemtables(boundedMemtables).
		WithBlockCacheSize(eventBlockCache).
		WithNumCompactors(boundedCompactors)
}

// SpentSet uses a smaller profile because its keys and values are tiny and its
// access pattern is point reads/writes rather than event scans.
//
// WithSyncWrites(true): the spent-set is the double-spend authority, so a spend MUST be durable
// (fsync'd) before the relay acts on it. Without it, badger buffers the write and a crash right
// after a bind/post could lose the spent-record — re-opening the door to reusing that credential or
// token. The volume is tiny (one small point-write per bind/post), so the fsync cost is acceptable
// for the safety it buys.
func SpentSet(opts badger.Options) badger.Options {
	return opts.
		WithMemTableSize(spentMemTableSize).
		WithNumMemtables(boundedMemtables).
		WithBlockCacheSize(spentBlockCache).
		WithValueThreshold(spentValueThreshold).
		WithNumCompactors(boundedCompactors).
		WithSyncWrites(true)
}
