package relayapp

import (
	"context"
	"log"
	"os"
	"sync"
	"sync/atomic"

	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/ratelimit"
)

// DiagnosticSnapshot contains counts only: no event content, tokens, pubkeys, addresses, or IPs.
type DiagnosticSnapshot struct {
	ActiveConnections       int64              `json:"active_connections"`
	TotalConnections        int64              `json:"total_connections"`
	TotalDisconnections     int64              `json:"total_disconnections"`
	DuplicateDisconnections int64              `json:"duplicate_disconnections"`
	Limiter                 ratelimit.Snapshot `json:"limiter"`
}

var relayDiagnostics struct {
	connections sync.Map
	active      atomic.Int64
	connects    atomic.Int64
	disconnects atomic.Int64
	duplicates  atomic.Int64
	limiter     atomic.Pointer[ratelimit.Limiter]
}

func enableRelayDiagnostics(relay *khatru.Relay, limiter *ratelimit.Limiter) {
	if os.Getenv("STIQ_RELAY_DIAGNOSTICS") != "1" {
		return
	}
	relayDiagnostics.limiter.Store(limiter)
	relay.OnConnect = append(relay.OnConnect, func(ctx context.Context) {
		connection := khatru.GetConnection(ctx)
		if connection == nil {
			return
		}
		if _, loaded := relayDiagnostics.connections.LoadOrStore(connection, struct{}{}); !loaded {
			relayDiagnostics.active.Add(1)
			relayDiagnostics.connects.Add(1)
		}
	})
	relay.OnDisconnect = append(relay.OnDisconnect, func(ctx context.Context) {
		connection := khatru.GetConnection(ctx)
		if connection == nil {
			return
		}
		if _, loaded := relayDiagnostics.connections.LoadAndDelete(connection); loaded {
			relayDiagnostics.active.Add(-1)
			relayDiagnostics.disconnects.Add(1)
		} else {
			// Khatru may invoke OnDisconnect from both its reader and pinger cleanup paths.
			relayDiagnostics.duplicates.Add(1)
		}
	})
}

// Diagnostics returns a concurrency-safe count snapshot for the loopback diagnostics endpoint.
func Diagnostics() DiagnosticSnapshot {
	var limiterSnapshot ratelimit.Snapshot
	if limiter := relayDiagnostics.limiter.Load(); limiter != nil {
		limiterSnapshot = limiter.Diagnostics()
	}
	return DiagnosticSnapshot{
		ActiveConnections:       relayDiagnostics.active.Load(),
		TotalConnections:        relayDiagnostics.connects.Load(),
		TotalDisconnections:     relayDiagnostics.disconnects.Load(),
		DuplicateDisconnections: relayDiagnostics.duplicates.Load(),
		Limiter:                 limiterSnapshot,
	}
}

type rejectEventHook func(context.Context, *nostr.Event) (bool, string)

func diagnosticRejectHook(enabled bool, gate string, hook rejectEventHook) rejectEventHook {
	if !enabled {
		return hook
	}
	return func(ctx context.Context, event *nostr.Event) (bool, string) {
		reject, message := hook(ctx, event)
		if reject && diagnosticPublishKind(event.Kind) {
			logEventDecision(event, "rejected", gate, message)
		}
		return reject, message
	}
}

func enableEventDiagnostics(relay *khatru.Relay) {
	if os.Getenv("STIQ_RELAY_EVENT_DIAGNOSTICS") != "1" {
		return
	}
	relay.OnEventSaved = append(relay.OnEventSaved, func(_ context.Context, event *nostr.Event) {
		if diagnosticPublishKind(event.Kind) {
			logEventDecision(event, "accepted", "stored", "")
		}
	})
}

func diagnosticPublishKind(kind int) bool {
	switch kind {
	// NIP-17 gift-wrapped DMs (1059) are deliberately EXCLUDED: their traffic pattern is exactly
	// what the encrypted-attribution / sealed-DM design exists to hide, so they must never appear in
	// any diagnostic stream. (finding #69)
	case 1, 7, 9, 11, 12, 1111, 1222, 1244, 30023:
		return true
	default:
		return false
	}
}

// sizeBucket coarsens an event's size into a bucket label so the diagnostic stream can't be used to
// fingerprint a specific event by its exact byte length (matching a blind post's size to a client
// action, or DM traffic analysis). Derived from content length + a rough tag estimate — no full
// serialization, so the content/pubkey are never marshalled into a log-adjacent buffer. (#69)
func sizeBucket(event *nostr.Event) string {
	n := len(event.Content)
	for _, tag := range event.Tags {
		for _, s := range tag {
			n += len(s) + 1
		}
	}
	switch {
	case n <= 256:
		return "<=256"
	case n <= 1024:
		return "<=1K"
	case n <= 4096:
		return "<=4K"
	case n <= 16384:
		return "<=16K"
	default:
		return ">16K"
	}
}

// logEventDecision records a gate decision for a content kind. It deliberately omits the event id
// and exact byte size — an id+size+wall-clock triple is a correlatable fingerprint that undercuts
// the zero-log anonymity posture (PLAN.md §3.2) — logging only the coarse kind, size bucket, and
// gate outcome. Still env-gated (dev-only); prefer a build tag for production hardening. (#69)
func logEventDecision(event *nostr.Event, decision, gate, reason string) {
	log.Printf(
		"event_diag kind=%d size=%s decision=%s gate=%s reason=%q",
		event.Kind, sizeBucket(event), decision, gate, reason,
	)
}
