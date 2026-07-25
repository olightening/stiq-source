package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

const (
	hexA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" // 64 hex
	hexB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" // 64 hex
)

// --- (1) Registry: Register / TopicsFor / Unregister / Prune ------------------------------------

func TestRegistryRegisterTopicsForUnregister(t *testing.T) {
	reg := newRegistry(64, 1<<30)
	exp := time.Now().Unix() + 3600

	if err := reg.Register("topicOne", []string{"p:" + hexA, "h:grp1"}, exp); err != nil {
		t.Fatalf("Register topicOne: %v", err)
	}
	if err := reg.Register("topicTwo", []string{"p:" + hexA}, exp); err != nil {
		t.Fatalf("Register topicTwo: %v", err)
	}

	if got := sortedCopy(reg.TopicsFor("p:" + hexA)); !equalStrs(got, []string{"topicOne", "topicTwo"}) {
		t.Errorf("TopicsFor(p:hexA) = %v, want [topicOne topicTwo]", got)
	}
	if got := reg.TopicsFor("h:grp1"); !equalStrs(got, []string{"topicOne"}) {
		t.Errorf("TopicsFor(h:grp1) = %v, want [topicOne]", got)
	}
	if got := reg.TopicsFor("p:" + hexB); got != nil {
		t.Errorf("TopicsFor(unknown) = %v, want nil", got)
	}

	if got := reg.ActiveHKeys(); !equalStrs(got, []string{"grp1"}) {
		t.Errorf("ActiveHKeys = %v, want [grp1]", got)
	}
	if got := reg.ActiveEKeys(); len(got) != 0 {
		t.Errorf("ActiveEKeys = %v, want empty", got)
	}

	// Unregister topicOne: it must drop off both its keys, and h:grp1 (now empty) must disappear.
	reg.Unregister("topicOne")
	if got := reg.TopicsFor("p:" + hexA); !equalStrs(got, []string{"topicTwo"}) {
		t.Errorf("after unregister TopicsFor(p:hexA) = %v, want [topicTwo]", got)
	}
	if got := reg.TopicsFor("h:grp1"); got != nil {
		t.Errorf("after unregister TopicsFor(h:grp1) = %v, want nil", got)
	}
	if got := reg.ActiveHKeys(); len(got) != 0 {
		t.Errorf("after unregister ActiveHKeys = %v, want empty", got)
	}
}

func TestRegistryReRegisterReplacesKeySet(t *testing.T) {
	reg := newRegistry(64, 1<<30)
	exp := time.Now().Unix() + 3600
	if err := reg.Register("t", []string{"p:" + hexA, "e:" + hexB}, exp); err != nil {
		t.Fatalf("first register: %v", err)
	}
	// Re-register with a smaller set — the dropped e-key must not linger.
	if err := reg.Register("t", []string{"p:" + hexA}, exp); err != nil {
		t.Fatalf("re-register: %v", err)
	}
	if got := reg.TopicsFor("e:" + hexB); got != nil {
		t.Errorf("stale e-key survived re-register: %v", got)
	}
	if got := reg.TopicsFor("p:" + hexA); !equalStrs(got, []string{"t"}) {
		t.Errorf("TopicsFor(p:hexA) = %v, want [t]", got)
	}
}

func TestRegistryPrune(t *testing.T) {
	reg := newRegistry(64, 1<<30)
	now := time.Now().Unix()
	if err := reg.Register("live", []string{"p:" + hexA}, now+3600); err != nil {
		t.Fatalf("register live: %v", err)
	}
	if err := reg.Register("dying", []string{"p:" + hexB}, now+10); err != nil {
		t.Fatalf("register dying: %v", err)
	}

	reg.Prune(now + 20) // past dying's exp, before live's
	if got := reg.TopicsFor("p:" + hexB); got != nil {
		t.Errorf("expired topic survived Prune: %v", got)
	}
	if got := reg.TopicsFor("p:" + hexA); !equalStrs(got, []string{"live"}) {
		t.Errorf("live topic pruned: %v, want [live]", got)
	}
}

func TestRegistryRegisterValidation(t *testing.T) {
	reg := newRegistry(3, 1000)
	now := time.Now().Unix()

	cases := []struct {
		name    string
		topic   string
		keys    []string
		exp     int64
		wantErr bool
	}{
		{"ok", "goodTopic", []string{"p:" + hexA}, now + 100, false},
		{"bad topic charset", "bad/topic", []string{"p:" + hexA}, now + 100, true},
		{"empty topic", "", []string{"p:" + hexA}, now + 100, true},
		{"no keys", "t", nil, now + 100, true},
		{"too many keys", "t", []string{"p:" + hexA, "h:a", "h:b", "h:c"}, now + 100, true},
		{"malformed key prefix", "t", []string{"x:" + hexA}, now + 100, true},
		{"p not hex64", "t", []string{"p:tooshort"}, now + 100, true},
		{"e not hex64", "t", []string{"e:zzzz"}, now + 100, true},
		{"h free-form ok", "t", []string{"h:my-group_1"}, now + 100, false},
		{"exp in past", "t", []string{"p:" + hexA}, now - 5, true},
		{"exp over ttl", "t", []string{"p:" + hexA}, now + 5000, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := reg.Register(tc.topic, tc.keys, tc.exp)
			if (err != nil) != tc.wantErr {
				t.Errorf("Register(%q) err = %v, wantErr = %v", tc.topic, err, tc.wantErr)
			}
		})
	}
}

// --- (2) matchEvent: extracts p/h/e, ignores everything else ------------------------------------

func TestMatchEvent(t *testing.T) {
	cases := []struct {
		name string
		tags nostr.Tags
		want []string
	}{
		{"p only", nostr.Tags{{"p", hexA}}, []string{"p:" + hexA}},
		{"h only", nostr.Tags{{"h", "grp1"}}, []string{"h:grp1"}},
		{"e only", nostr.Tags{{"e", hexB}}, []string{"e:" + hexB}},
		{
			"mixed with ignored tags",
			nostr.Tags{{"p", hexA}, {"t", "hashtag"}, {"h", "grp1"}, {"d", "ident"}, {"e", hexB}, {"q", "quote"}},
			[]string{"p:" + hexA, "h:grp1", "e:" + hexB},
		},
		{"ignores non-triggers", nostr.Tags{{"t", "x"}, {"a", "y"}, {"k", "1"}}, nil},
		{"skips short tags", nostr.Tags{{"p"}, {"h", "grp1"}}, []string{"h:grp1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := &nostr.Event{Kind: 1, Tags: tc.tags}
			got := matchEvent(ev)
			if !equalStrs(got, tc.want) {
				t.Errorf("matchEvent = %v, want %v", got, tc.want)
			}
		})
	}
}

// --- (3) waker: dedupe + per-topic rate-limit ---------------------------------------------------

func TestWakerDedupeAndRateLimit(t *testing.T) {
	reg := newRegistry(64, 1<<30)
	if err := reg.Register("topicA", []string{"p:" + hexA}, time.Now().Unix()+3600); err != nil {
		t.Fatalf("register: %v", err)
	}

	var woken []string
	wk := newWaker("http://ntfy.example", 100, 20000)
	wk.wakeFn = func(_, topic string) error {
		woken = append(woken, topic)
		return nil
	}

	ev1 := &nostr.Event{ID: "id1", Tags: nostr.Tags{{"p", hexA}}}
	ev2 := &nostr.Event{ID: "id2", Tags: nostr.Tags{{"p", hexA}}}
	ev3 := &nostr.Event{ID: "id3", Tags: nostr.Tags{{"p", hexA}}}

	wk.onEvent(reg, ev1, 1000)       // first wake for topicA
	wk.onEvent(reg, ev1, 1000)       // exact duplicate → deduped
	wk.onEvent(reg, ev2, 6000)       // new event, but within 20s window → rate-limited
	wk.onEvent(reg, ev3, 1000+25000) // outside window → wakes again

	if !equalStrs(woken, []string{"topicA", "topicA"}) {
		t.Fatalf("woken = %v, want two wakes (dup + rate-limited suppressed)", woken)
	}
	if wk.nWakes != 2 {
		t.Errorf("nWakes = %d, want 2", wk.nWakes)
	}
	if wk.nDeduped != 1 {
		t.Errorf("nDeduped = %d, want 1", wk.nDeduped)
	}
	if wk.nRateLimited != 1 {
		t.Errorf("nRateLimited = %d, want 1", wk.nRateLimited)
	}
}

func TestWakerNoTopicNoWake(t *testing.T) {
	reg := newRegistry(64, 1<<30) // nothing registered
	var calls int
	wk := newWaker("http://ntfy.example", 100, 20000)
	wk.wakeFn = func(_, _ string) error { calls++; return nil }

	wk.onEvent(reg, &nostr.Event{ID: "id1", Tags: nostr.Tags{{"p", hexA}}}, 1000)
	if calls != 0 {
		t.Errorf("wakeFn called %d times for an unregistered key, want 0", calls)
	}
}

func TestWakerDedupeEviction(t *testing.T) {
	reg := newRegistry(64, 1<<30)
	if err := reg.Register("t", []string{"p:" + hexA}, time.Now().Unix()+3600); err != nil {
		t.Fatalf("register: %v", err)
	}
	// maxSeen=1 so the second distinct event evicts the first from the dedupe set.
	wk := newWaker("http://ntfy.example", 1, 0) // minInterval 0 → rate-limit never blocks
	var calls int
	wk.wakeFn = func(_, _ string) error { calls++; return nil }

	wk.onEvent(reg, &nostr.Event{ID: "id1", Tags: nostr.Tags{{"p", hexA}}}, 1)
	wk.onEvent(reg, &nostr.Event{ID: "id2", Tags: nostr.Tags{{"p", hexA}}}, 2) // evicts id1
	wk.onEvent(reg, &nostr.Event{ID: "id1", Tags: nostr.Tags{{"p", hexA}}}, 3) // id1 no longer remembered → wakes
	if calls != 3 {
		t.Errorf("calls = %d, want 3 (dedupe set of size 1 evicts oldest)", calls)
	}
}

// --- (4) HTTP register API validation -----------------------------------------------------------

func TestHTTPRegisterValidation(t *testing.T) {
	reg := newRegistry(2, 1000)
	ps := &pushServer{reg: reg, changed: make(chan struct{}, 1)}
	srv := httptest.NewServer(ps.mux())
	defer srv.Close()

	now := time.Now().Unix()

	cases := []struct {
		name       string
		body       string
		wantStatus int
	}{
		{"valid", `{"v":1,"topic":"good","keys":["p:` + hexA + `"],"exp":` + itoa(now+100) + `}`, http.StatusNoContent},
		{"wrong version", `{"v":2,"topic":"good","keys":["p:` + hexA + `"],"exp":` + itoa(now+100) + `}`, http.StatusBadRequest},
		{"oversize keys", `{"v":1,"topic":"good","keys":["h:a","h:b","h:c"],"exp":` + itoa(now+100) + `}`, http.StatusBadRequest},
		{"exp in past", `{"v":1,"topic":"good","keys":["p:` + hexA + `"],"exp":` + itoa(now-100) + `}`, http.StatusBadRequest},
		{"bad key", `{"v":1,"topic":"good","keys":["p:short"],"exp":` + itoa(now+100) + `}`, http.StatusBadRequest},
		{"malformed json", `{not json`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := http.Post(srv.URL+"/push/register", "application/json", strings.NewReader(tc.body))
			if err != nil {
				t.Fatalf("POST: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.wantStatus {
				t.Errorf("status = %d, want %d", resp.StatusCode, tc.wantStatus)
			}
		})
	}

	// The one valid registration above must be queryable.
	if got := reg.TopicsFor("p:" + hexA); !equalStrs(got, []string{"good"}) {
		t.Errorf("after valid register TopicsFor = %v, want [good]", got)
	}
}

func TestHTTPRegisterUnregisterRoundTrip(t *testing.T) {
	reg := newRegistry(64, 1<<30)
	ps := &pushServer{reg: reg, changed: make(chan struct{}, 1)}
	srv := httptest.NewServer(ps.mux())
	defer srv.Close()

	now := time.Now().Unix()
	body := `{"v":1,"topic":"rt","keys":["h:grpx"],"exp":` + itoa(now+100) + `}`
	resp, err := http.Post(srv.URL+"/push/register", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("register POST: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("register status = %d, want 204", resp.StatusCode)
	}
	if got := reg.ActiveHKeys(); !equalStrs(got, []string{"grpx"}) {
		t.Fatalf("ActiveHKeys after register = %v, want [grpx]", got)
	}

	resp2, err := http.Post(srv.URL+"/push/unregister", "application/json", strings.NewReader(`{"topic":"rt"}`))
	if err != nil {
		t.Fatalf("unregister POST: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNoContent {
		t.Fatalf("unregister status = %d, want 204", resp2.StatusCode)
	}
	if got := reg.ActiveHKeys(); len(got) != 0 {
		t.Errorf("ActiveHKeys after unregister = %v, want empty", got)
	}
}

func TestHTTPHealthz(t *testing.T) {
	ps := &pushServer{reg: newRegistry(64, 1<<30), changed: make(chan struct{}, 1)}
	srv := httptest.NewServer(ps.mux())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("healthz status = %d, want 200", resp.StatusCode)
	}
}

// --- (5) wake(): posts an empty body to the right ntfy URL --------------------------------------

func TestWakePostsToNtfyURL(t *testing.T) {
	var (
		gotMethod   string
		gotPath     string
		gotPriority string
		gotCache    string
		gotBodyLen  int
	)
	ntfy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotPriority = r.Header.Get("Priority")
		gotCache = r.Header.Get("Cache")
		body, _ := io.ReadAll(r.Body)
		gotBodyLen = len(body)
		w.WriteHeader(http.StatusOK)
	}))
	defer ntfy.Close()

	if err := wake(ntfy.URL, "myTopic"); err != nil {
		t.Fatalf("wake: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotPath != "/myTopic" {
		t.Errorf("path = %q, want /myTopic", gotPath)
	}
	if gotPriority != "min" {
		t.Errorf("Priority = %q, want min", gotPriority)
	}
	if gotCache != "no" {
		t.Errorf("Cache = %q, want no", gotCache)
	}
	if gotBodyLen != 0 {
		t.Errorf("wake body length = %d, want 0 (content-free)", gotBodyLen)
	}
}

func TestWakeNon2xxIsError(t *testing.T) {
	ntfy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer ntfy.Close()

	if err := wake(ntfy.URL, "t"); err == nil {
		t.Error("wake() returned nil for a 500 response, want error")
	}
}

// --- small test helpers -------------------------------------------------------------------------

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func equalStrs(a, b []string) bool {
	a = sortedCopy(a)
	b = sortedCopy(b)
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sortedCopy(in []string) []string {
	out := append([]string(nil), in...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1] > out[j]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}
