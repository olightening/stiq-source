package safebrowsing

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestServeHTTP_FlagsMatch(t *testing.T) {
	fullHash := strings.Repeat("ab", 32) // 32-byte hex full hash
	raw, err := hex.DecodeString(fullHash)
	if err != nil {
		t.Fatal(err)
	}
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("key") != "TESTKEY" {
			t.Errorf("missing/wrong api key: %q", r.URL.Query().Get("key"))
		}
		var greq googleRequest
		if err := json.NewDecoder(r.Body).Decode(&greq); err != nil {
			t.Errorf("bad google request: %v", err)
		}
		if len(greq.ThreatInfo.ThreatEntries) != 1 {
			t.Errorf("expected 1 threat entry, got %d", len(greq.ThreatInfo.ThreatEntries))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"matches":[{"threatType":"MALWARE","threat":{"hash":"` +
			base64.StdEncoding.EncodeToString(raw) + `"}}]}`))
	}))
	defer google.Close()

	svc := &Service{APIKey: "TESTKEY", Endpoint: google.URL, Client: google.Client()}
	relay := httptest.NewServer(svc)
	defer relay.Close()

	res, err := http.Post(relay.URL, "application/json", strings.NewReader(`{"prefixes":["abababab"]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var out clientResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Matches) != 1 {
		t.Fatalf("expected 1 match, got %d", len(out.Matches))
	}
	if out.Matches[0].Hash != fullHash {
		t.Errorf("hash = %q, want %q", out.Matches[0].Hash, fullHash)
	}
	if out.Matches[0].ThreatType != "MALWARE" {
		t.Errorf("threatType = %q", out.Matches[0].ThreatType)
	}
}

func TestServeHTTP_EmptyPrefixes(t *testing.T) {
	svc := &Service{APIKey: "x", Endpoint: "http://unused", Client: http.DefaultClient}
	relay := httptest.NewServer(svc)
	defer relay.Close()

	res, err := http.Post(relay.URL, "application/json", strings.NewReader(`{"prefixes":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var out clientResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Matches) != 0 {
		t.Errorf("expected no matches, got %d", len(out.Matches))
	}
}

func TestServeHTTP_RejectsGet(t *testing.T) {
	svc := &Service{APIKey: "x", Endpoint: "http://unused", Client: http.DefaultClient}
	relay := httptest.NewServer(svc)
	defer relay.Close()

	res, err := http.Get(relay.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", res.StatusCode)
	}
}

func TestServeHTTP_NoKeyDisabled(t *testing.T) {
	svc := &Service{APIKey: "", Endpoint: "http://unused", Client: http.DefaultClient}
	relay := httptest.NewServer(svc)
	defer relay.Close()

	res, err := http.Post(relay.URL, "application/json", strings.NewReader(`{"prefixes":["abababab"]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when no key configured", res.StatusCode)
	}
}

// TestNewWithoutProxyFailsClosed: constructing the Service with no SOCKS proxy must DISABLE the
// feature (503), never dial Google direct from the box's clearnet IP (finding #67).
func TestNewWithoutProxyFailsClosed(t *testing.T) {
	svc := New("realkey", "") // empty SOCKS addr
	relay := httptest.NewServer(svc)
	defer relay.Close()

	res, err := http.Post(relay.URL, "application/json", strings.NewReader(`{"prefixes":["abababab"]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (fail closed when no SOCKS proxy configured)", res.StatusCode)
	}
}

func TestSetKey(t *testing.T) {
	svc := &Service{}
	if svc.key() != "" {
		t.Fatalf("expected empty key initially, got %q", svc.key())
	}
	svc.SetKey("abc")
	if svc.key() != "abc" {
		t.Fatalf("SetKey failed: %q", svc.key())
	}
}

// TestServeHTTP_CachesAcrossUsers is the core "verify once, shared to all" guarantee: the first
// member to check a link triggers one Google lookup and every other member reuses the cached verdict.
func TestServeHTTP_CachesAcrossUsers(t *testing.T) {
	var calls int32
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"matches":[],"negativeCacheDuration":"300s"}`))
	}))
	defer google.Close()

	svc := &Service{APIKey: "k", Endpoint: google.URL, Client: google.Client()}
	relay := httptest.NewServer(svc)
	defer relay.Close()

	post := func(prefix string) {
		res, err := http.Post(relay.URL, "application/json", strings.NewReader(`{"prefixes":["`+prefix+`"]}`))
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
	}

	post("aabbccdd") // member 1 — triggers the one Google lookup
	post("aabbccdd") // member 2 — same link, served from the shared cache
	post("aabbccdd") // member 3 — shared cache
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("Google called %d times for the same link, want 1 (verdict shared across users)", got)
	}
	post("11223344") // a different link — a fresh lookup
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("Google called %d times after a new link, want 2", got)
	}
}

// TestCacheExpiry confirms a cached verdict is re-checked once Google's cache duration elapses.
func TestCacheExpiry(t *testing.T) {
	var calls int32
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"matches":[],"negativeCacheDuration":"300s"}`))
	}))
	defer google.Close()

	mockNow := time.Unix(1_000_000, 0)
	svc := &Service{APIKey: "k", Endpoint: google.URL, Client: google.Client(), now: func() time.Time { return mockNow }}
	relay := httptest.NewServer(svc)
	defer relay.Close()

	post := func() {
		res, err := http.Post(relay.URL, "application/json", strings.NewReader(`{"prefixes":["deadbeef"]}`))
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
	}
	post()
	post()
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("within TTL: Google called %d times, want 1", got)
	}
	mockNow = mockNow.Add(6 * time.Minute) // past the 300s negative cache duration
	post()
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("after TTL: Google called %d times, want 2 (verdict re-checked)", got)
	}
}

func TestServeHTTP_UpstreamFailFailsOpen(t *testing.T) {
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer google.Close()
	svc := &Service{APIKey: "x", Endpoint: google.URL, Client: google.Client()}
	relay := httptest.NewServer(svc)
	defer relay.Close()

	res, err := http.Post(relay.URL, "application/json", strings.NewReader(`{"prefixes":["abababab"]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (client fails open)", res.StatusCode)
	}
}
