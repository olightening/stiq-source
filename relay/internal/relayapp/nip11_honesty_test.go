package relayapp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/fiatjaf/eventstore"
	"github.com/fiatjaf/eventstore/badger"
	"github.com/fiatjaf/eventstore/slicestore"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/badgeropts"
	"github.com/stiq/relay/internal/config"
)

// TestBackendQueryCeilingsUnchanged is the drift guard behind the advertised max_limit/default_limit.
// Those numbers are the EVENT STORE's, not ours — badger resolves BadgerBackend.MaxLimit to 1000
// inside Init and serves a filter carrying no limit with MaxLimit/4. If an eventstore upgrade moves
// either, the NIP-11 document quietly starts lying and clients quietly start getting truncated
// pages, with nothing to notice it. This fails instead.
func TestBackendQueryCeilingsUnchanged(t *testing.T) {
	db := &badger.BadgerBackend{
		Path:                  t.TempDir(),
		BadgerOptionsModifier: badgeropts.EventStore,
		MaxLimitNegentropy:    maxNegentropyEvents,
	}
	if err := db.Init(); err != nil {
		t.Fatalf("badger init: %v", err)
	}
	defer db.Close()

	if db.MaxLimit != badgerBackendMaxLimit {
		t.Errorf("badger resolved MaxLimit=%d, relayapp advertises %d", db.MaxLimit, badgerBackendMaxLimit)
	}
	// The reason we do NOT set BadgerBackend.MaxLimit ourselves: Init treats a non-zero MaxLimit as
	// an opt-in that ALSO overwrites MaxLimitNegentropy with it. Confirm our 65536 survived.
	if db.MaxLimitNegentropy != maxNegentropyEvents {
		t.Errorf("MaxLimitNegentropy=%d, want %d — setting BadgerBackend.MaxLimit would clobber it",
			db.MaxLimitNegentropy, maxNegentropyEvents)
	}

	var slice slicestore.SliceStore
	if err := slice.Init(); err != nil {
		t.Fatalf("slicestore init: %v", err)
	}
	defer slice.Close()
	if slice.MaxLimit != sliceStoreMaxLimit {
		t.Errorf("slicestore resolved MaxLimit=%d, relayapp advertises %d", slice.MaxLimit, sliceStoreMaxLimit)
	}
}

func TestEffectiveQueryLimits(t *testing.T) {
	cases := []struct {
		name                   string
		cfg                    config.Config
		wantMax, wantDefaultLo int
	}{
		{"badger, unconfigured", config.Config{DataDir: "/tmp/x"}, badgerBackendMaxLimit, badgerBackendDefaultLimit},
		{"in-memory, unconfigured", config.Config{}, sliceStoreMaxLimit, sliceStoreDefaultLimit},
		{
			"a configured limit may tighten",
			config.Config{DataDir: "/tmp/x", MaxLimit: 200, DefaultLimit: 40},
			200, 40,
		},
		{
			// The old code advertised whatever the operator wrote here while badger still capped at
			// 1000 — and, above its ceiling, actually returned 250.
			"a configured limit may NOT loosen past the backend",
			config.Config{DataDir: "/tmp/x", MaxLimit: 5000, DefaultLimit: 4000},
			badgerBackendMaxLimit, badgerBackendDefaultLimit,
		},
		{
			"a default above the max is pulled down to it",
			config.Config{DataDir: "/tmp/x", MaxLimit: 100},
			100, 100,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotMax, gotDefault := effectiveQueryLimits(tc.cfg)
			if gotMax != tc.wantMax || gotDefault != tc.wantDefaultLo {
				t.Fatalf("effectiveQueryLimits = (%d, %d), want (%d, %d)",
					gotMax, gotDefault, tc.wantMax, tc.wantDefaultLo)
			}
		})
	}
}

// TestNIP11LimitationMatchesEnforcement checks the advertised document against the values the relay
// actually enforces, field by field, rather than against hard-coded expectations.
func TestNIP11LimitationMatchesEnforcement(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	cfg := config.Config{
		Listen:           "127.0.0.1:0",
		IssuerPublicKeys: []string{issuerPEM},
		AllowedKinds:     config.DefaultAllowedKinds,
		MaxEventBytes:    524288,
		MaxTagsPerEvent:  1000,
	}
	relay, closeStore, _, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	srv := httptest.NewServer(relay)
	t.Cleanup(srv.Close)

	req, err := http.NewRequest(http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Accept", "application/nostr+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET nip-11: %v", err)
	}
	defer resp.Body.Close()

	var doc struct {
		Software      string `json:"software"`
		SupportedNIPs []int  `json:"supported_nips"`
		Limitation    struct {
			MaxMessageLength int  `json:"max_message_length"`
			MaxContentLength int  `json:"max_content_length"`
			MaxEventTags     int  `json:"max_event_tags"`
			MaxLimit         int  `json:"max_limit"`
			DefaultLimit     int  `json:"default_limit"`
			RestrictedWrites bool `json:"restricted_writes"`
			MinPowDifficulty int  `json:"min_pow_difficulty"`
			AuthRequired     bool `json:"auth_required"`
			PaymentRequired  bool `json:"payment_required"`
		} `json:"limitation"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		t.Fatalf("decode nip-11: %v", err)
	}
	lim := doc.Limitation

	// The transport frame ceiling. Breaching this one does not produce an error frame — khatru closes
	// the connection with 1009 and sends nothing — so it is the field a client most needs in advance.
	if want := int(relay.MaxMessageSize); lim.MaxMessageLength != want {
		t.Errorf("max_message_length=%d, but the transport enforces %d", lim.MaxMessageLength, want)
	}
	if want := cfg.EffectiveMaxEventBytes(); lim.MaxContentLength != want {
		t.Errorf("max_content_length=%d, but the weight gate enforces %d", lim.MaxContentLength, want)
	}
	if want := cfg.EffectiveMaxTagsPerEvent(); lim.MaxEventTags != want {
		t.Errorf("max_event_tags=%d, but the weight gate enforces %d", lim.MaxEventTags, want)
	}
	wantMax, wantDefault := effectiveQueryLimits(cfg)
	if lim.MaxLimit != wantMax {
		t.Errorf("max_limit=%d, but REQ filters are clamped to %d", lim.MaxLimit, wantMax)
	}
	if lim.DefaultLimit != wantDefault {
		t.Errorf("default_limit=%d, but a limitless filter is served %d", lim.DefaultLimit, wantDefault)
	}
	// This relay admits an event only from a bound npub or against a valid blind token.
	if !lim.RestrictedWrites {
		t.Error("restricted_writes=false, but the membership gate restricts every write")
	}
	// Deliberate zeroes: the PoW bars are PER-KIND (stiq-capabilities.pow), not a global floor, and
	// NIP-42 is scoped to private-group reads rather than required outright. Advertising either here
	// would make a well-behaved client mine PoW on every reaction, or AUTH before every read.
	if lim.MinPowDifficulty != 0 {
		t.Errorf("min_pow_difficulty=%d: NIP-11's field is a GLOBAL floor and this relay has none",
			lim.MinPowDifficulty)
	}
	if lim.AuthRequired {
		t.Error("auth_required=true, but the relay runs no relay-wide NIP-42 requirement")
	}
	if lim.PaymentRequired {
		t.Error("payment_required=true, but the relay takes no payment")
	}

	if doc.Software == "" || strings.Contains(doc.Software, "khatru") {
		t.Errorf("software=%q still attributes this relay's admission behaviour to khatru", doc.Software)
	}
	for _, n := range doc.SupportedNIPs {
		if n == 86 {
			t.Error("supported_nips advertises NIP-86, but no RelayManagementAPI handler is registered")
		}
	}
	var has29, has53 bool
	for _, n := range doc.SupportedNIPs {
		switch n {
		case 29:
			has29 = true
		case 53:
			has53 = true
		}
	}
	if !has29 || !has53 {
		t.Errorf("supported_nips %v lost 29/53", doc.SupportedNIPs)
	}
}

// TestREQLimitClampMatchesAdvertisement drives the registered OverwriteFilter directly. The
// interesting case is a filter ABOVE the ceiling: the backend used to answer that with MaxLimit/4,
// i.e. asking for more got you fewer, silently.
func TestREQLimitClampMatchesAdvertisement(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	cfg := config.Config{
		Listen:           "127.0.0.1:0",
		IssuerPublicKeys: []string{issuerPEM},
		AllowedKinds:     config.DefaultAllowedKinds,
	}
	relay, closeStore, _, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	wantMax, wantDefault := effectiveQueryLimits(cfg)

	apply := func(ctx context.Context, f nostr.Filter) nostr.Filter {
		for _, ovw := range relay.OverwriteFilter {
			ovw(ctx, &f)
		}
		return f
	}

	if got := apply(context.Background(), nostr.Filter{}).Limit; got != wantDefault {
		t.Errorf("a filter with no limit became %d, advertised default_limit is %d", got, wantDefault)
	}
	if got := apply(context.Background(), nostr.Filter{Limit: wantMax * 5}).Limit; got != wantMax {
		t.Errorf("a filter asking for %d became %d, advertised max_limit is %d", wantMax*5, got, wantMax)
	}
	if got := apply(context.Background(), nostr.Filter{Limit: 7}).Limit; got != 7 {
		t.Errorf("a filter under both ceilings was rewritten to %d", got)
	}
	if f := apply(context.Background(), nostr.Filter{LimitZero: true}); f.Limit != 0 {
		t.Errorf("an explicit limit:0 was rewritten to %d", f.Limit)
	}

	// NIP-77: khatru runs this same chain over a NEG-OPEN filter, and the store reads a negentropy
	// session's much larger budget (maxNegentropyEvents) only while the filter carries no limit.
	// Clamping one would silently cap every delta-sync at a feed page.
	neg := apply(eventstore.SetNegentropy(context.Background()), nostr.Filter{})
	if neg.Limit != 0 {
		t.Errorf("a negentropy filter was clamped to %d; NIP-77 sync would be capped at a feed page", neg.Limit)
	}
}

func TestPruneNIP11Limitation(t *testing.T) {
	cases := []struct {
		name        string
		in          string
		wantChanged bool
		wantHasKeys []string
		wantGone    []string
	}{
		{
			name:        "zero created_at bounds are removed",
			in:          `{"max_limit":1000,"created_at_lower_limit":0,"created_at_upper_limit":0}`,
			wantChanged: true,
			wantHasKeys: []string{"max_limit"},
			wantGone:    []string{"created_at_lower_limit", "created_at_upper_limit"},
		},
		{
			name:        "a real bound is preserved",
			in:          `{"created_at_lower_limit":0,"created_at_upper_limit":1750000000}`,
			wantChanged: true,
			wantHasKeys: []string{"created_at_upper_limit"},
			wantGone:    []string{"created_at_lower_limit"},
		},
		{
			name:        "nothing to do",
			in:          `{"max_limit":1000}`,
			wantChanged: false,
			wantHasKeys: []string{"max_limit"},
		},
		{name: "malformed input is passed through untouched", in: `not json`, wantChanged: false},
		{name: "empty input is passed through untouched", in: ``, wantChanged: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, changed := PruneNIP11Limitation(json.RawMessage(tc.in))
			if changed != tc.wantChanged {
				t.Fatalf("changed=%v, want %v", changed, tc.wantChanged)
			}
			if !changed {
				if string(out) != tc.in {
					t.Fatalf("unchanged result was rewritten to %q", out)
				}
				return
			}
			var got map[string]json.RawMessage
			if err := json.Unmarshal(out, &got); err != nil {
				t.Fatalf("result is not valid JSON: %v", err)
			}
			for _, k := range tc.wantHasKeys {
				if _, ok := got[k]; !ok {
					t.Errorf("%q was dropped", k)
				}
			}
			for _, k := range tc.wantGone {
				if _, ok := got[k]; ok {
					t.Errorf("%q survived", k)
				}
			}
		})
	}
}
