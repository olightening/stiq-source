// Package safebrowsing proxies Google Safe Browsing reputation lookups for STIQ clients.
//
// A client about to open a link canonicalizes + hashes it locally and sends ONLY the 4-byte
// URL-hash prefixes here (POST /safebrowsing, JSON {"prefixes":["aabbccdd",...]}). The relay holds
// the Google API key (so it can't be extracted from the app) and forwards the prefixes to Google's
// v4 fullHashes:find endpoint, returning the full threat hashes Google flagged. The client does the
// final full-hash match locally — so neither Google nor the relay ever sees the URL, only opaque
// prefixes. The Google call egresses through Tor's SOCKS port, so it isn't tied to the box's IP.
//
// Verdicts are cached per prefix and SHARED across the whole community: the relay is the single
// point every member's check funnels through, so the FIRST member to open a link triggers the one
// Google lookup and every other member reuses the cached verdict — no repeat call to Google. Expiry
// honours Google's own cacheDuration / negativeCacheDuration, so a verdict is never served staler
// than Google permits. The cache holds only opaque prefixes + Google's response — never URLs.
//
// ANONYMITY TRADEOFF (finding #34): because the cache is shared, a cache HIT is answered locally in
// microseconds while a MISS incurs a full Tor→Google→Tor round trip. A curious member can therefore
// probe a candidate URL's 4-byte hash prefix and infer, from the response latency, whether SOME
// member recently opened a URL with a matching prefix — a coarse cross-member timing oracle over
// browsing activity. This is an accepted, deliberate consequence of the "verify once, share to all"
// design: eliminating it (uniform per-request latency, or per-connection cache partitioning) would
// either add hundreds of ms to every check over Tor or discard the shared-cache bandwidth win. The
// leak is coarse (32-bit prefix collisions, no URL transmitted) and callers must NOT treat a link
// check as private; sensitive/private-space content is protected by client-side encryption, not by
// this endpoint. Documented here so the tradeoff is explicit rather than accidental.
package safebrowsing

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// googleEndpoint is the v4 fullHashes:find URL (the API key is appended as a query param).
const googleEndpoint = "https://safebrowsing.googleapis.com/v4/fullHashes:find"

var threatTypes = []string{"MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"}

// Cache sizing + fallback TTLs (used only when Google omits a duration).
const (
	cacheMaxEntries    = 50000
	defaultNegativeTTL = 5 * time.Minute
	defaultPositiveTTL = 5 * time.Minute
)

// cacheEntry is a shared, per-prefix verdict. matches holds the full-hash threats that extend this
// prefix (empty slice = negative: Google reported no threat for it).
type cacheEntry struct {
	matches []clientMatch
	expires time.Time
}

// Service handles POST /safebrowsing. Endpoint and Client are injectable for tests; New wires the
// production Google endpoint and a Tor-SOCKS-backed HTTP client. The API key is guarded by a mutex
// so it can be hot-swapped at runtime (SetKey) when the organizer dashboard rewrites config.json —
// no relay restart. An empty key means the feature is disabled (ServeHTTP returns 503). The verdict
// cache (guarded by cacheMu) is shared across every client the relay serves.
type Service struct {
	mu       sync.RWMutex
	APIKey   string
	Endpoint string
	Client   *http.Client

	cacheMu sync.Mutex
	cache   map[string]cacheEntry
	now     func() time.Time // nil → time.Now (injectable for tests)

	// noProxy is set by New when it was given an empty SOCKS address: the anonymity requirement
	// fails CLOSED (ServeHTTP returns 503) rather than dialing Google direct from the box's clearnet
	// IP. Never set on test Services built via struct literal (they inject their own Client). (#67)
	noProxy bool

	// Outbound throttle (findings #32/#41): /safebrowsing is unauthenticated (any peer reaching the
	// onion) and every cache-missing prefix batch forces one live Google call over Tor. These bound
	// the OUTBOUND side independently of inbound request rate — a semaphore caps concurrent Google
	// calls (Tor circuits/goroutines held open) and a sliding window caps Google QPS (quota drain).
	// Both are nil/zero on struct-built test Services, which disables throttling there.
	outboundSem       chan struct{}
	obMu              sync.Mutex
	obHits            []time.Time
	maxOutboundPerMin int
}

// SetKey swaps the Google API key at runtime (called by the config watcher on config.json change).
func (s *Service) SetKey(k string) {
	s.mu.Lock()
	s.APIKey = k
	s.mu.Unlock()
}

func (s *Service) key() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.APIKey
}

// maxConcurrentOutbound / defaultMaxOutboundPerMin bound outbound Google calls (findings #32/#41).
// The QPS ceiling caps quota drain and Tor egress from a novel-prefix flood; the concurrency cap
// bounds how many Tor circuits + goroutines a burst can hold open at once.
const (
	maxConcurrentOutbound    = 8
	defaultMaxOutboundPerMin = 300
)

// New builds a Service that reaches Google through the Tor SOCKS proxy at socksAddr (e.g.
// "127.0.0.1:9050"). An EMPTY socksAddr disables the feature (ServeHTTP returns 503) rather than
// dialing Google directly: this component is anonymity-sensitive, so it fails CLOSED instead of
// leaking the box's DNS + real IP to Google if a caller ever forgets to supply the proxy (#67).
func New(apiKey, socksAddr string) *Service {
	s := &Service{
		APIKey:            apiKey,
		Endpoint:          googleEndpoint,
		cache:             make(map[string]cacheEntry),
		outboundSem:       make(chan struct{}, maxConcurrentOutbound),
		maxOutboundPerMin: defaultMaxOutboundPerMin,
	}
	if socksAddr == "" {
		s.noProxy = true
		return s
	}
	transport := &http.Transport{DialContext: socksDialer(socksAddr)}
	s.Client = &http.Client{Transport: transport, Timeout: 12 * time.Second}
	return s
}

func (s *Service) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// cacheGet returns a cached verdict for prefix if present and unexpired.
func (s *Service) cacheGet(prefix string) ([]clientMatch, bool) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	e, ok := s.cache[prefix]
	if !ok || !e.expires.After(s.clock()) {
		return nil, false
	}
	return e.matches, true
}

// cachePut stores a verdict for prefix, expiring after ttl. ttl<=0 is not cached.
func (s *Service) cachePut(prefix string, matches []clientMatch, ttl time.Duration) {
	if ttl <= 0 {
		return
	}
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	if s.cache == nil {
		s.cache = make(map[string]cacheEntry)
	}
	if len(s.cache) >= cacheMaxEntries {
		s.sweepLocked()
	}
	s.cache[prefix] = cacheEntry{matches: matches, expires: s.clock().Add(ttl)}
}

// sweepLocked drops expired entries; if still at capacity it evicts arbitrary ones (backstop).
// Caller must hold cacheMu.
func (s *Service) sweepLocked() {
	now := s.clock()
	for k, e := range s.cache {
		if !e.expires.After(now) {
			delete(s.cache, k)
		}
	}
	for k := range s.cache {
		if len(s.cache) < cacheMaxEntries {
			break
		}
		delete(s.cache, k)
	}
}

// acquireOutbound reserves one outbound Google call against the concurrency semaphore and the
// per-minute QPS ceiling. It returns (release, true) when the call may proceed — the caller MUST
// invoke release() once queryGoogle returns — or (nil, false) when a cap is hit and the caller must
// not call Google. A Service built without New (test struct literal) has a nil semaphore, so
// throttling is disabled there. (findings #32/#41)
func (s *Service) acquireOutbound() (func(), bool) {
	if s.outboundSem == nil {
		return func() {}, true // throttling disabled (test Service)
	}
	// Concurrency cap first (cheap, non-blocking): shed rather than queue, so a flood can't pile up
	// goroutines waiting on Tor.
	select {
	case s.outboundSem <- struct{}{}:
	default:
		return nil, false
	}
	// Global QPS ceiling over a sliding one-minute window.
	s.obMu.Lock()
	now := s.clock()
	cutoff := now.Add(-time.Minute)
	kept := s.obHits[:0]
	for _, t := range s.obHits {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	s.obHits = kept
	if s.maxOutboundPerMin > 0 && len(s.obHits) >= s.maxOutboundPerMin {
		s.obMu.Unlock()
		<-s.outboundSem // release the semaphore slot we just took
		return nil, false
	}
	s.obHits = append(s.obHits, now)
	s.obMu.Unlock()
	return func() { <-s.outboundSem }, true
}

type clientRequest struct {
	Prefixes []string `json:"prefixes"`
}

type clientMatch struct {
	Hash       string `json:"hash"`
	ThreatType string `json:"threatType,omitempty"`
}

type clientResponse struct {
	Matches []clientMatch `json:"matches"`
}

// Google v4 fullHashes:find request/response shapes.
type googleThreatEntry struct {
	Hash string `json:"hash"`
}
type googleRequest struct {
	Client struct {
		ClientID      string `json:"clientId"`
		ClientVersion string `json:"clientVersion"`
	} `json:"client"`
	ThreatInfo struct {
		ThreatTypes      []string            `json:"threatTypes"`
		PlatformTypes    []string            `json:"platformTypes"`
		ThreatEntryTypes []string            `json:"threatEntryTypes"`
		ThreatEntries    []googleThreatEntry `json:"threatEntries"`
	} `json:"threatInfo"`
}
type googleResponse struct {
	Matches []struct {
		ThreatType    string `json:"threatType"`
		CacheDuration string `json:"cacheDuration"`
		Threat        struct {
			Hash string `json:"hash"`
		} `json:"threat"`
	} `json:"matches"`
	NegativeCacheDuration string `json:"negativeCacheDuration"`
}

// googleMatch pairs a returned full-hash match with the per-match cache duration Google assigned it.
type googleMatch struct {
	match clientMatch
	ttl   time.Duration
}

func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if s.noProxy {
		// Fail closed: no SOCKS proxy configured means we would deanonymize the host on every lookup.
		// 503 so the client treats it as "not checked" and fails open. (#67)
		http.Error(w, "safe browsing not configured", http.StatusServiceUnavailable)
		return
	}
	if s.key() == "" {
		// No API key configured → feature disabled. 503 so the client treats it as "not checked"
		// and fails open, rather than a false "clean" verdict.
		http.Error(w, "safe browsing not configured", http.StatusServiceUnavailable)
		return
	}
	var req clientRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(req.Prefixes) == 0 || len(req.Prefixes) > 64 {
		// Empty or absurd batch: nothing to check / refuse oversize.
		writeJSON(w, clientResponse{Matches: []clientMatch{}})
		return
	}

	// Normalise + validate hex prefixes (lowercase, dedupe).
	prefixes := make([]string, 0, len(req.Prefixes))
	seen := make(map[string]bool, len(req.Prefixes))
	for _, p := range req.Prefixes {
		lp := strings.ToLower(p)
		raw, err := hex.DecodeString(lp)
		if err != nil || len(raw) == 0 || len(raw) > 32 || seen[lp] {
			continue
		}
		seen[lp] = true
		prefixes = append(prefixes, lp)
	}
	if len(prefixes) == 0 {
		writeJSON(w, clientResponse{Matches: []clientMatch{}})
		return
	}

	// Serve what the shared cache already knows; collect the rest for a single Google lookup.
	out := make([]clientMatch, 0)
	var toQuery []string
	for _, p := range prefixes {
		if m, ok := s.cacheGet(p); ok {
			out = append(out, m...)
		} else {
			toQuery = append(toQuery, p)
		}
	}

	if len(toQuery) > 0 {
		// Bound outbound Google traffic independent of inbound request rate: a flood of novel
		// (always-missing) prefixes would otherwise force one live Google call each, draining the
		// organizer's quota and holding Tor circuits/goroutines open without limit. When the ceiling
		// is hit we skip the call and 503 (client fails open — "not checked"). (findings #32/#41)
		release, ok := s.acquireOutbound()
		if !ok {
			http.Error(w, "safe browsing busy", http.StatusServiceUnavailable)
			return
		}
		entries := make([]googleThreatEntry, 0, len(toQuery))
		for _, p := range toQuery {
			raw, _ := hex.DecodeString(p) // already validated above
			entries = append(entries, googleThreatEntry{Hash: base64.StdEncoding.EncodeToString(raw)})
		}
		gmatches, negTTL, err := s.queryGoogle(entries)
		release()
		if err != nil {
			// Upstream failure → 502 so the client fails OPEN (treats it as "not checked"), rather
			// than a false "clean" verdict.
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
			return
		}
		if negTTL <= 0 {
			negTTL = defaultNegativeTTL
		}
		// Group fresh matches under the requested prefix each one extends, so they can be cached
		// (and reused by the next member) per prefix.
		byPrefix := make(map[string][]clientMatch, len(toQuery))
		ttlByPrefix := make(map[string]time.Duration, len(toQuery))
		for _, gm := range gmatches {
			out = append(out, gm.match) // always surface in this response
			for _, p := range toQuery {
				if strings.HasPrefix(gm.match.Hash, p) {
					byPrefix[p] = append(byPrefix[p], gm.match)
					ttl := gm.ttl
					if ttl <= 0 {
						ttl = defaultPositiveTTL
					}
					// Shortest positive TTL wins for the prefix (re-check sooner = safer).
					if cur, ok := ttlByPrefix[p]; !ok || ttl < cur {
						ttlByPrefix[p] = ttl
					}
					break
				}
			}
		}
		// Cache every queried prefix: positive with its matches, or negative (no threat).
		for _, p := range toQuery {
			if ms, ok := byPrefix[p]; ok {
				s.cachePut(p, ms, ttlByPrefix[p])
			} else {
				s.cachePut(p, []clientMatch{}, negTTL)
			}
		}
	}

	writeJSON(w, clientResponse{Matches: out})
}

// queryGoogle sends one fullHashes:find request and returns the matches (each with its cache
// duration) plus the response's negativeCacheDuration.
func (s *Service) queryGoogle(entries []googleThreatEntry) ([]googleMatch, time.Duration, error) {
	var greq googleRequest
	greq.Client.ClientID = "stiq-relay"
	greq.Client.ClientVersion = "1.0.0"
	greq.ThreatInfo.ThreatTypes = threatTypes
	greq.ThreatInfo.PlatformTypes = []string{"ANY_PLATFORM"}
	greq.ThreatInfo.ThreatEntryTypes = []string{"URL"}
	greq.ThreatInfo.ThreatEntries = entries

	body, err := json.Marshal(greq)
	if err != nil {
		return nil, 0, err
	}
	// Build the query with url.Values so a key containing reserved characters is escaped rather than
	// corrupting the request (secrets-in-URL is a known leak class; escaping is the minimum). (#68)
	endpoint := s.Endpoint + "?" + url.Values{"key": {s.key()}}.Encode()
	httpReq, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := s.Client.Do(httpReq)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, 0, errUpstream(resp.StatusCode)
	}
	var gresp googleResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&gresp); err != nil {
		return nil, 0, err
	}

	out := make([]googleMatch, 0, len(gresp.Matches))
	for _, m := range gresp.Matches {
		raw, err := base64.StdEncoding.DecodeString(m.Threat.Hash)
		if err != nil {
			continue
		}
		out = append(out, googleMatch{
			match: clientMatch{Hash: hex.EncodeToString(raw), ThreatType: m.ThreatType},
			ttl:   parseDuration(m.CacheDuration),
		})
	}
	return out, parseDuration(gresp.NegativeCacheDuration), nil
}

// parseDuration parses Google's protobuf duration strings ("300s", "300.000000000s") to a Duration.
// Returns 0 on empty/invalid input (callers substitute a default TTL).
func parseDuration(s string) time.Duration {
	s = strings.TrimSuffix(strings.TrimSpace(s), "s")
	if s == "" {
		return 0
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f <= 0 {
		return 0
	}
	return time.Duration(f * float64(time.Second))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

type upstreamError int

func (e upstreamError) Error() string { return "safebrowsing: upstream status " + strconv.Itoa(int(e)) }
func errUpstream(code int) error      { return upstreamError(code) }
