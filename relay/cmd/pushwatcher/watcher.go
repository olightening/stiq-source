// Command pushwatcher is a KEYLESS firehose watcher that turns already-public tag values on the
// relay's blind event stream into content-free "wake and sync" pings to a self-hosted ntfy.
//
// KEYLESS boundary (do not violate): this process holds NO community key, NO content-encryption key
// (K_E), and NO issuer/posting/binding keys. It never decrypts a gift wrap or a body. It matches
// ONLY coarse tag values that are already public on the wire (`p` on kind-1059 DM gift wraps, `h` on
// NIP-29 group / channel kinds, `e` on kind-1111 comment roots), maps them to opaque per-member ntfy
// topics the member itself chose, and POSTs an EMPTY wake. No title, npub, body, or event id ever
// crosses ntfy — the app derives all notification text locally over Tor after it wakes.
package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// keyRe is the accepted shape of a trigger key: a "p:"/"h:"/"e:" prefix followed by an opaque value
// drawn from a deliberately narrow charset (lowercase hex + a few group-id separators). p/e values
// are additionally required to be 64-char hex (validateKey). Keeping the charset tight means a
// registered key can never smuggle a URL, path separator, or whitespace into a ntfy topic path.
var keyRe = regexp.MustCompile(`^(p|h|e):[0-9a-z:_-]+$`)

// hex64Re matches a canonical 32-byte value rendered as 64 lowercase hex chars — the exact form of a
// Nostr pubkey (p) and an event id (e). Group ids (h) are free-form NIP-29 slugs, so they are only
// held to keyRe's charset, not to hex64Re.
var hex64Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

// topicRe bounds a ntfy topic to ntfy's own topic charset. Because wake() builds the ntfy URL as
// base+"/"+topic, this is also the guard that keeps a registration from injecting `../`, a query
// string, or a second host into that path. Topics are meant to be long random secrets chosen by the
// member; length is capped generously.
var topicRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Registry maps an already-public trigger key to the set of ntfy topics that asked to be woken by
// it, each with an expiry. byKey is key -> topic -> exp(unix seconds); a topic is removed from every
// key on Unregister and drops out once Prune passes its expiry. maxKeys / maxTTLSec bound a single
// registration so a client cannot register an unbounded fan-out or an effectively permanent entry.
type Registry struct {
	mu        sync.Mutex
	byKey     map[string]map[string]int64
	maxKeys   int
	maxTTLSec int64
}

func newRegistry(maxKeys int, maxTTLSec int64) *Registry {
	return &Registry{
		byKey:     make(map[string]map[string]int64),
		maxKeys:   maxKeys,
		maxTTLSec: maxTTLSec,
	}
}

// Register validates and records that topic wants to be woken by each of keys until exp. It rejects
// (returns an error, surfaced as HTTP 400) an invalid topic, an empty or over-MaxKeys key set, any
// malformed key, or an exp that is in the past or beyond now+maxTTLSec. A re-registration of the
// same topic fully replaces its previous key set (so a shrinking set does not leave stale keys).
func (r *Registry) Register(topic string, keys []string, exp int64) error {
	if !topicRe.MatchString(topic) {
		return fmt.Errorf("invalid topic")
	}
	if len(keys) == 0 {
		return fmt.Errorf("no keys")
	}
	if len(keys) > r.maxKeys {
		return fmt.Errorf("too many keys")
	}
	now := time.Now().Unix()
	if exp <= now {
		return fmt.Errorf("exp in the past")
	}
	if exp > now+r.maxTTLSec {
		return fmt.Errorf("exp beyond max ttl")
	}
	for _, k := range keys {
		if !validateKey(k) {
			return fmt.Errorf("malformed key")
		}
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.unregisterLocked(topic)
	for _, k := range keys {
		m := r.byKey[k]
		if m == nil {
			m = make(map[string]int64)
			r.byKey[k] = m
		}
		m[topic] = exp
	}
	return nil
}

// Unregister removes topic from every key it was registered under.
func (r *Registry) Unregister(topic string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.unregisterLocked(topic)
}

func (r *Registry) unregisterLocked(topic string) {
	for k, m := range r.byKey {
		delete(m, topic)
		if len(m) == 0 {
			delete(r.byKey, k)
		}
	}
}

// TopicsFor returns the topics currently registered under the given full key (e.g. "p:<hex>"). It is
// the read side matchEvent feeds: a matched public tag becomes a full key which is looked up here.
func (r *Registry) TopicsFor(key string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	m := r.byKey[key]
	if len(m) == 0 {
		return nil
	}
	out := make([]string, 0, len(m))
	for t := range m {
		out = append(out, t)
	}
	return out
}

// ActiveHKeys returns the distinct group-id VALUES (the part after "h:") that at least one topic is
// currently registered under. main.go feeds these straight into the "#h" array of the group/channel
// firehose subscription. ActiveEKeys is the "e:" analogue for kind-1111 comment roots.
func (r *Registry) ActiveHKeys() []string { return r.valuesWithPrefix("h:") }

// ActiveEKeys returns the distinct event-id VALUES (the part after "e:") currently registered.
func (r *Registry) ActiveEKeys() []string { return r.valuesWithPrefix("e:") }

func (r *Registry) valuesWithPrefix(prefix string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0)
	for k := range r.byKey {
		if strings.HasPrefix(k, prefix) {
			out = append(out, strings.TrimPrefix(k, prefix))
		}
	}
	return out
}

// Prune drops every topic entry whose expiry is at or before now, and any key left with no topics.
func (r *Registry) Prune(now int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for k, m := range r.byKey {
		for t, exp := range m {
			if exp <= now {
				delete(m, t)
			}
		}
		if len(m) == 0 {
			delete(r.byKey, k)
		}
	}
}

// validateKey enforces keyRe for every key and, additionally, 64-hex for p/e values (pubkeys and
// event ids are always canonical 32-byte hex). h (group id) values are free-form NIP-29 slugs and
// are held only to keyRe's charset.
func validateKey(k string) bool {
	if !keyRe.MatchString(k) {
		return false
	}
	switch k[0] {
	case 'p', 'e':
		return hex64Re.MatchString(k[2:])
	default: // 'h'
		return true
	}
}

// matchEvent collects trigger keys from an event's PUBLIC tags ONLY.
//
// KEYLESS: matches only public tag values on the already-blind stream; holds no community/K_E/issuer
// key. It reads nothing but the first two fields of `p`/`h`/`e` tags — never content, never a
// signature, and it never decrypts. ['p',v] -> "p:"+v, ['h',v] -> "h:"+v, ['e',v] -> "e:"+v.
func matchEvent(ev *nostr.Event) []string {
	var keys []string
	for _, tag := range ev.Tags {
		if len(tag) < 2 {
			continue
		}
		switch tag[0] {
		case "p":
			keys = append(keys, "p:"+tag[1])
		case "h":
			keys = append(keys, "h:"+tag[1])
		case "e":
			keys = append(keys, "e:"+tag[1])
		}
	}
	return keys
}

// wakeHTTPClient is the shared client for ntfy wake POSTs. A short timeout keeps a stalled ntfy from
// pinning a goroutine; the watcher only ever talks to the loopback-bound (or onion) ntfy.
var wakeHTTPClient = &http.Client{Timeout: 15 * time.Second}

// wake POSTs an EMPTY body to ntfyBase+"/"+topic, the entire wake signal. Priority: min and Cache: no
// keep it a bare, non-cached poke. Any 2xx is success. The topic is NEVER logged.
func wake(ntfyBase, topic string) error {
	url := strings.TrimRight(ntfyBase, "/") + "/" + topic
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(nil))
	if err != nil {
		return err
	}
	req.Header.Set("Priority", "min")
	req.Header.Set("Cache", "no")
	resp, err := wakeHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("ntfy responded %d", resp.StatusCode)
	}
	return nil
}

// waker turns matched events into wakes, guarded by a bounded event-id dedupe set and a per-topic
// rate limit. Both structures key on the OPAQUE topic and event id only — no member content. All
// mutable state is under mu; wakeFn (the network POST) is called with mu released.
type waker struct {
	mu sync.Mutex

	// dedupe: a bounded FIFO set of "topic\x00eventID" so a given event wakes a given topic at most
	// once even if it arrives on several subscriptions (base 1059 + an #h/#e sub).
	seen      map[string]struct{}
	seenQueue []string
	maxSeen   int

	// rate limit: last wake time (unix ms) per topic; a topic is not woken again within
	// minIntervalMs of its last wake, collapsing a burst to one poke.
	lastWake      map[string]int64
	minIntervalMs int64

	ntfyBase string
	wakeFn   func(ntfyBase, topic string) error // indirection for tests; defaults to wake

	// counters only (never topics/keys) — safe to log/expose.
	nWakes       int64
	nDeduped     int64
	nRateLimited int64
	nWakeErr     int64
}

func newWaker(ntfyBase string, maxSeen int, minIntervalMs int64) *waker {
	return &waker{
		seen:          make(map[string]struct{}),
		maxSeen:       maxSeen,
		lastWake:      make(map[string]int64),
		minIntervalMs: minIntervalMs,
		ntfyBase:      ntfyBase,
		wakeFn:        wake,
	}
}

// onEvent routes one firehose event: for each matched public key -> each registered topic ->
// dedupe(topic+eventID) -> rate-limit(topic) -> wake(). The dedupe/rate-limit decisions are made
// under mu; the wake POSTs happen after mu is released so a slow ntfy never blocks matching.
func (w *waker) onEvent(reg *Registry, ev *nostr.Event, nowMs int64) {
	keys := matchEvent(ev)
	if len(keys) == 0 {
		return
	}

	// Collapse the (possibly overlapping) topic sets across all matched keys so one event wakes a
	// topic at most once per pass, independent of how many of its tags matched.
	topicSet := make(map[string]struct{})
	for _, key := range keys {
		for _, t := range reg.TopicsFor(key) {
			topicSet[t] = struct{}{}
		}
	}
	if len(topicSet) == 0 {
		return
	}

	var toWake []string
	w.mu.Lock()
	for topic := range topicSet {
		if !w.markSeenLocked(topic, ev.ID) {
			w.nDeduped++
			continue
		}
		if !w.allowWakeLocked(topic, nowMs) {
			w.nRateLimited++
			continue
		}
		toWake = append(toWake, topic)
	}
	w.mu.Unlock()

	for _, topic := range toWake {
		if err := w.wakeFn(w.ntfyBase, topic); err != nil {
			w.mu.Lock()
			w.nWakeErr++
			w.mu.Unlock()
			continue
		}
		w.mu.Lock()
		w.nWakes++
		w.mu.Unlock()
	}
}

// markSeenLocked returns true when (topic,id) has not been processed yet (caller should proceed) and
// records it, evicting the oldest entry once the set exceeds maxSeen. Returns false on a repeat.
func (w *waker) markSeenLocked(topic, id string) bool {
	k := topic + "\x00" + id
	if _, ok := w.seen[k]; ok {
		return false
	}
	w.seen[k] = struct{}{}
	w.seenQueue = append(w.seenQueue, k)
	if len(w.seenQueue) > w.maxSeen {
		oldest := w.seenQueue[0]
		w.seenQueue = w.seenQueue[1:]
		delete(w.seen, oldest)
	}
	return true
}

// allowWakeLocked returns true when topic has not been woken within minIntervalMs, updating its last
// wake time; false (leaving the timer untouched) when it is still inside the interval.
func (w *waker) allowWakeLocked(topic string, nowMs int64) bool {
	last, ok := w.lastWake[topic]
	if ok && nowMs-last < w.minIntervalMs {
		return false
	}
	w.lastWake[topic] = nowMs
	return true
}
