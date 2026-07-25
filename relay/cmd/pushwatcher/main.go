package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// Defaults for every knob. All are overridable by env (see loadConfig); the watcher takes NO
// positional arguments so it drops cleanly into a systemd unit with an EnvironmentFile.
const (
	defaultRelayWS       = "ws://127.0.0.1:3334"
	defaultListen        = "127.0.0.1:8787"
	defaultNtfyBase      = "http://127.0.0.1:2586"
	defaultMaxKeys       = 64
	defaultMaxTTLSeconds = 1209600 // 14 days
	defaultWakeMinMS     = 20000   // 20s per-topic wake floor

	// dedupeSetSize bounds the event-id/topic dedupe set. It is a memory cap, not a correctness knob:
	// once exceeded the oldest entries fall out, so a very old duplicate could wake twice.
	dedupeSetSize = 8192

	// maxRegisterBodyBytes bounds a register/unregister request body. 64 keys * ~70 chars + topic +
	// exp fit comfortably; anything larger is rejected before it is parsed.
	maxRegisterBodyBytes = 16 * 1024

	// subRebuildDebounce coalesces a burst of register/unregister calls into one subscription rebuild.
	subRebuildDebounce = 2 * time.Second

	// reconnectDelay is the fixed backoff before re-dialing the relay after a dropped connection.
	reconnectDelay = 5 * time.Second
)

// watcherConfig is the fully-resolved runtime configuration, read once from the environment.
type watcherConfig struct {
	relayWS       string
	listen        string
	ntfyBase      string
	allowedHost   string
	maxKeys       int
	maxTTLSec     int64
	minIntervalMs int64
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix("pushwatcher: ")

	cfg, err := loadConfig()
	if err != nil {
		// Fail closed: a misconfigured watcher must not start and silently accept arbitrary endpoints.
		log.Fatalf("refusing to start: %v", err)
	}
	run(cfg)
}

// loadConfig resolves every knob from the environment, applying defaults, and FAILS CLOSED when
// WATCHER_ALLOWED_NTFY_HOST is unset (step 7): the operator must name the ntfy onion the deployment
// is allowed to poke, so a bare/misconfigured watcher can never come up accepting arbitrary targets.
func loadConfig() (watcherConfig, error) {
	cfg := watcherConfig{
		relayWS:       envStr("WATCHER_RELAY_WS", defaultRelayWS),
		listen:        envStr("WATCHER_LISTEN", defaultListen),
		ntfyBase:      envStr("WATCHER_NTFY_BASE", defaultNtfyBase),
		allowedHost:   os.Getenv("WATCHER_ALLOWED_NTFY_HOST"),
		maxKeys:       int(envInt("WATCHER_MAX_KEYS", defaultMaxKeys)),
		maxTTLSec:     envInt("WATCHER_MAX_TTL_SECONDS", defaultMaxTTLSeconds),
		minIntervalMs: envInt("WATCHER_WAKE_MIN_INTERVAL_MS", defaultWakeMinMS),
	}
	if cfg.allowedHost == "" {
		return cfg, fmt.Errorf("WATCHER_ALLOWED_NTFY_HOST is required (fail-closed)")
	}
	return cfg, nil
}

func envStr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func envInt(name string, def int64) int64 {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
		log.Printf("ignoring non-integer %s=%q, using default %d", name, v, def)
	}
	return def
}

// run wires up the long-lived pieces (registry, waker, register API, prune loop) and then loops
// forever maintaining a relay connection. The registry/waker outlive any single relay session so a
// reconnect never drops a member's registration.
func run(cfg watcherConfig) {
	reg := newRegistry(cfg.maxKeys, cfg.maxTTLSec)
	wk := newWaker(cfg.ntfyBase, dedupeSetSize, cfg.minIntervalMs)
	changed := make(chan struct{}, 1)

	ps := &pushServer{reg: reg, changed: changed}
	httpSrv := &http.Server{
		Addr:              cfg.listen,
		Handler:           ps.mux(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Printf("register API listening on %s (loopback)", cfg.listen)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("register API stopped: %v", err)
		}
	}()

	go pruneLoop(reg)

	for {
		if err := connectAndRoute(cfg, reg, wk, changed); err != nil {
			log.Printf("relay session ended (%v); reconnecting in %s", err, reconnectDelay)
		}
		time.Sleep(reconnectDelay)
	}
}

// pruneLoop drops expired registrations once a minute.
func pruneLoop(reg *Registry) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		reg.Prune(time.Now().Unix())
	}
}

// connectAndRoute holds one relay session: it opens the static 1059 firehose subscription plus the
// dynamic #h/#e subscriptions, routes every incoming event through the waker, and rebuilds the
// dynamic subscriptions (debounced) whenever the active key set changes. It returns when the relay
// connection closes, leaving run() to reconnect.
func connectAndRoute(cfg watcherConfig, reg *Registry, wk *waker, changed chan struct{}) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	relay, err := nostr.RelayConnect(ctx, cfg.relayWS)
	if err != nil {
		return fmt.Errorf("relay connect: %w", err)
	}
	defer relay.Close()
	log.Printf("connected to relay firehose at %s", cfg.relayWS)

	events := make(chan *nostr.Event, 256)

	// Static base subscription: unscoped kind-1059 DM gift wraps. 1059 is neither a discovery nor a
	// group kind, so the relay allows it unscoped; we match its already-public #p recipient tag.
	base, err := relay.Subscribe(ctx, nostr.Filters{{Kinds: []int{1059}}})
	if err != nil {
		return fmt.Errorf("subscribe base 1059: %w", err)
	}
	go forward(ctx, base, events)

	// Event router: pull matched wakes off the shared channel.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-events:
				if !ok {
					return
				}
				wk.onEvent(reg, ev, nowMs())
			}
		}
	}()

	sm := &subManager{relay: relay, ctx: ctx, events: events}
	sm.rebuild(reg)

	debounce := time.NewTimer(time.Hour)
	debounce.Stop()
	for {
		select {
		case <-changed:
			debounce.Reset(subRebuildDebounce)
		case <-debounce.C:
			sm.rebuild(reg)
		case <-relay.Context().Done():
			return fmt.Errorf("relay connection closed")
		}
	}
}

// subManager owns the single dynamic subscription carrying the current #h group/channel filters and
// #e comment-root filters. rebuild() is a no-op when the active key set is unchanged; otherwise it
// tears down the old subscription and opens a fresh one.
type subManager struct {
	relay  *nostr.Relay
	ctx    context.Context
	events chan<- *nostr.Event

	cur    *nostr.Subscription
	curSig string
}

func (sm *subManager) rebuild(reg *Registry) {
	hKeys := reg.ActiveHKeys()
	eKeys := reg.ActiveEKeys()
	sig := subSignature(hKeys, eKeys)
	if sig == sm.curSig {
		return
	}

	var filters nostr.Filters
	// Group/channel: one #h-scoped filter per active group id. #h satisfies the relay's
	// RequireScopedGroupQuery so the subscription is admitted.
	for _, id := range hKeys {
		filters = append(filters, nostr.Filter{
			Kinds: []int{9, 11, 12, 42},
			Tags:  nostr.TagMap{"h": []string{id}},
		})
	}
	// Comments: one #e-scoped filter per active authored root id (kind-1111 NIP-22 comments).
	for _, root := range eKeys {
		filters = append(filters, nostr.Filter{
			Kinds: []int{1111},
			Tags:  nostr.TagMap{"e": []string{root}},
		})
	}

	if sm.cur != nil {
		sm.cur.Unsub()
		sm.cur = nil
	}
	sm.curSig = sig
	if len(filters) == 0 {
		return
	}

	sub, err := sm.relay.Subscribe(sm.ctx, filters)
	if err != nil {
		log.Printf("dynamic subscribe failed (%d filters): %v", len(filters), err)
		// Force a retry on the next change/rebuild by not caching this signature.
		sm.curSig = ""
		return
	}
	sm.cur = sub
	go forward(sm.ctx, sub, sm.events)
	log.Printf("dynamic subscriptions rebuilt: %d h-filters, %d e-filters", len(hKeys), len(eKeys))
}

// subSignature is an order-independent fingerprint of the active key sets so rebuild() can skip a
// no-op churn when register/unregister traffic did not actually change what we subscribe to.
func subSignature(hKeys, eKeys []string) string {
	// Counts + a cheap XOR-free concat is enough; go maps already dedupe, and order is stabilised by
	// summing lengths and the joined content. A different set almost always changes length or content.
	return fmt.Sprintf("h%d:%s|e%d:%s", len(hKeys), joinSorted(hKeys), len(eKeys), joinSorted(eKeys))
}

// forward pumps a subscription's events into the shared channel until either closes.
func forward(ctx context.Context, sub *nostr.Subscription, out chan<- *nostr.Event) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-sub.Events:
			if !ok {
				return
			}
			select {
			case out <- ev:
			case <-ctx.Done():
				return
			}
		}
	}
}

// joinSorted sorts a copy of vs and joins it with commas — a stable, order-independent rendering for
// subSignature so the same key set always fingerprints identically regardless of map iteration order.
func joinSorted(vs []string) string {
	cp := append([]string(nil), vs...)
	sort.Strings(cp)
	return strings.Join(cp, ",")
}

func nowMs() int64 { return time.Now().UnixNano() / int64(time.Millisecond) }

// pushServer serves the loopback register/unregister/health API. It holds only the registry and a
// change-signal channel; it never logs a topic or a key.
type pushServer struct {
	reg     *Registry
	changed chan struct{}
}

func (s *pushServer) mux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/push/register", s.handleRegister)
	mux.HandleFunc("/push/unregister", s.handleUnregister)
	mux.HandleFunc("/healthz", s.handleHealth)
	return mux
}

type registerReq struct {
	V     int      `json:"v"`
	Topic string   `json:"topic"`
	Keys  []string `json:"keys"`
	Exp   int64    `json:"exp"`
}

type unregisterReq struct {
	Topic string `json:"topic"`
}

func (s *pushServer) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRegisterBodyBytes)
	var req registerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.V != 1 {
		http.Error(w, "unsupported version", http.StatusBadRequest)
		return
	}
	if err := s.reg.Register(req.Topic, req.Keys, req.Exp); err != nil {
		// Never echo the topic/keys back — a generic 400 only.
		http.Error(w, "rejected", http.StatusBadRequest)
		return
	}
	s.signalChanged()
	w.WriteHeader(http.StatusNoContent)
}

func (s *pushServer) handleUnregister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRegisterBodyBytes)
	var req unregisterReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Topic == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	s.reg.Unregister(req.Topic)
	s.signalChanged()
	w.WriteHeader(http.StatusNoContent)
}

func (s *pushServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// signalChanged pokes the rebuild loop without blocking (the channel is buffered to depth 1).
func (s *pushServer) signalChanged() {
	select {
	case s.changed <- struct{}{}:
	default:
	}
}
