package relayapp

import (
	"context"
	"sync"
	"time"

	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"
)

// maxDeletionLookupsPerConnPerMin caps how many NIP-09 deletion target lookups a single WebSocket
// connection can trigger per rolling minute. khatru's handleDeleteRequest runs ONE backend query per
// 'e'/'a' tag on a kind-5, and it does so BEFORE any RejectEvent hook sees the event (kind-5 is
// unmetered — categorize → catNone), so a throwaway key could send a kind-5 carrying thousands of
// junk tags to force thousands of backend lookups (finding #37(a), query amplification; the event
// itself is bounded only by khatru's ~500 KB WS frame limit ⇒ up to several thousand tags). Since a
// kind-5's tags are processed consecutively on one connection, this per-connection window bounds the
// e/a tags the relay will actually look up for a kind-5 to this ceiling. A legitimate deletion (e.g.
// a channel owner's single-'a' kind-5) is one lookup, so real clients never approach it.
const maxDeletionLookupsPerConnPerMin = 100

// deletionWindowSeconds is the fixed-window length for the per-connection deletion-lookup cap.
const deletionWindowSeconds = 60

// deletionQueryGuard bounds internal (NIP-09 deletion) backend lookups per connection. It wraps the
// QueryEvents backend registered with khatru: khatru marks deletion/expiration lookups with
// IsInternalCall, and a per-connection window on the DELETION ones (those that carry a live
// connection) is the tightest pre-gate khatru v0.19.1 exposes — the wrapper is the first
// stiq-controllable code the per-tag lookup reaches, and it short-circuits before touching storage.
// Expiration + startup replays are internal calls WITHOUT a connection, so they are never capped.
type deletionQueryGuard struct {
	now func() time.Time
	max int

	mu    sync.Mutex
	conns map[any]*deletionWindow
}

// deletionWindow is one connection's fixed-window deletion-lookup counter. Two ints per connection;
// an entry is created only once a connection issues its first deletion lookup.
type deletionWindow struct {
	windowStart int64 // unix seconds of the current window's start
	count       int
}

func newDeletionQueryGuard() *deletionQueryGuard {
	return &deletionQueryGuard{
		now:   time.Now,
		max:   maxDeletionLookupsPerConnPerMin,
		conns: make(map[any]*deletionWindow),
	}
}

// queryFunc is the shape of a khatru QueryEvents backend.
type queryFunc = func(context.Context, nostr.Filter) (chan *nostr.Event, error)

// wrap returns a QueryEvents backend that enforces the per-connection deletion-lookup cap. Non-
// deletion queries (normal REQ, the deleted-by-id check) and connection-less internal calls
// (expiration, startup config replay) pass straight through unchanged.
func (g *deletionQueryGuard) wrap(query queryFunc) queryFunc {
	return func(ctx context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
		if khatru.IsInternalCall(ctx) {
			if conn := khatru.GetConnection(ctx); conn != nil && !g.allow(conn, g.now()) {
				// Refuse the lookup without hitting storage: report "found nothing" so khatru's
				// handleDeleteRequest simply moves on to the next tag (it treats a nil target as
				// not-found), deleting nothing for the curtailed tags.
				ch := make(chan *nostr.Event)
				close(ch)
				return ch, nil
			}
		}
		return query(ctx, filter)
	}
}

// allow reports whether a deletion lookup on this connection is within the current window's cap,
// recording it when so. A fresh connection or an expired window resets the counter.
func (g *deletionQueryGuard) allow(key any, now time.Time) bool {
	nowSec := now.Unix()
	g.mu.Lock()
	defer g.mu.Unlock()
	w := g.conns[key]
	if w == nil || nowSec-w.windowStart >= deletionWindowSeconds {
		w = &deletionWindow{windowStart: nowSec}
		g.conns[key] = w
	}
	if w.count >= g.max {
		return false
	}
	w.count++
	return true
}

// forget releases a connection's window when khatru closes the socket. The relay wires this into
// OnDisconnect so the map stays bounded by the live connection count (an entry exists only for a
// connection that actually issued a deletion lookup).
func (g *deletionQueryGuard) forget(ctx context.Context) {
	conn := khatru.GetConnection(ctx)
	if conn == nil {
		return
	}
	g.mu.Lock()
	delete(g.conns, conn)
	g.mu.Unlock()
}
