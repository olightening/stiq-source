package relayapp

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/config"
	"github.com/stiq/relay/internal/membership"
)

// publishOutcome is like publish() but never Fatals: it distinguishes the three outcomes a media
// post can hit — "ok-true", "ok-false" (with a reason), and "dropped-no-ok" (the WS
// SetReadLimit(512000) close, which sends NO OK frame and is logged nowhere). This is the exact
// distinction the inline-media-post investigation needed: a policy rejection returns an OK frame,
// but an over-frame-limit event is silently dropped and the client only ever sees a publish timeout.
func publishOutcome(t *testing.T, wsURL string, ev *nostr.Event) (outcome string) {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()

	payload, err := json.Marshal([]any{"EVENT", ev})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_ = c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, payload); err != nil {
		return "dropped-no-ok"
	}
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return "dropped-no-ok" // relay closed/reset the socket → client sees only a timeout
		}
		var frame []json.RawMessage
		if err := json.Unmarshal(data, &frame); err != nil || len(frame) < 3 {
			continue
		}
		var typ string
		_ = json.Unmarshal(frame[0], &typ)
		if typ != "OK" {
			continue
		}
		var accepted bool
		_ = json.Unmarshal(frame[2], &accepted)
		if accepted {
			return "ok-true"
		}
		return "ok-false"
	}
}

// blindNoteOfSize builds a kind-1 blind note whose content is `size` bytes — mirroring the client's
// inline-media path (base64 media rides inside event.content, plus the stiq_token/sig/attr tags).
func blindNoteOfSize(t *testing.T, throwawaySK string, cred membership.Credential, size int) *nostr.Event {
	t.Helper()
	ev := &nostr.Event{
		Kind:      1,
		CreatedAt: nostr.Now(),
		Tags: nostr.Tags{
			{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
			{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)},
			{"stiq_attr", strings.Repeat("a", 220)}, // ~ a real NIP-44 attestation ciphertext
		},
		Content: strings.Repeat("x", size),
	}
	if err := ev.Sign(throwawaySK); err != nil {
		t.Fatalf("Sign blind note: %v", err)
	}
	return ev
}

// mediaRelay reproduces the DEPLOYED relay config (max_event_bytes = 524288, pushed 2026-07-05).
// relayapp.New derives khatru's WS MaxMessageSize from max_event_bytes (+ 64KiB headroom), so the
// transport ceiling here is 524288+65536 = 589824, comfortably above the weight gate's own cap.
func mediaRelay(t *testing.T) (ws string, issuerSK *rsa.PrivateKey) {
	t.Helper()
	sk, issuerPEM := issuerKeyPEM(t)
	cfg := config.Config{
		Listen:           "127.0.0.1:0",
		IssuerPublicKeys: []string{issuerPEM},
		AllowedKinds:     config.DefaultAllowedKinds,
		MaxEventBytes:    524288, // the 2026-07-05 change
	}
	relay, closeStore, _, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	srv := httptest.NewServer(relay)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http"), sk
}

// TestDeployedRelayAcceptsRealisticMediaNotes proves the relay is NOT the cause of the inline-media
// post failure: with the deployed config it ACCEPTS blind notes carrying a max picture (~64KB), a
// ~30s audio clip (~180KB) and a max voice payload (~267KB base64). Realistic media rides through.
func TestDeployedRelayAcceptsRealisticMediaNotes(t *testing.T) {
	ws, sk := mediaRelay(t)

	for _, tc := range []struct {
		name  string
		bytes int
	}{
		{"max picture base64 (~64KB)", 64 * 1024},
		{"~30s audio base64 (~180KB)", 180 * 1024},
		{"max voice base64 (~267KB)", 273068},
		{"generous headroom (~400KB)", 400 * 1024},
	} {
		tw, _ := keypair(t)
		got := publishOutcome(t, ws, blindNoteOfSize(t, tw, makeCredential(t, sk), tc.bytes))
		if got != "ok-true" {
			t.Fatalf("%s: realistic media note should be accepted, got %q", tc.name, got)
		}
	}
}

// TestRelayAcceptsFramesUpToMaxEventBytes guards the fix for the WS-transport-ceiling-below-
// max_event_bytes bug (previously TestRelayWSFrameLimitIsFarAboveMedia documented it as a live
// silent-drop). khatru's WS MaxMessageSize used to sit at its hardcoded 512000 default regardless of
// max_event_bytes; relayapp.New now derives it from max_event_bytes (+ 64KiB headroom), so every
// frame up to the configured max_event_bytes (524288 in prod) must reach the weight gate — never get
// silently dropped by the transport below it.
func TestRelayAcceptsFramesUpToMaxEventBytes(t *testing.T) {
	ws, sk := mediaRelay(t)

	// Content ~515KB: BEFORE the fix, this exact size was silently dropped by khatru's hardcoded
	// 512000-byte transport ceiling (close 1009, no OK frame) even though it is comfortably under
	// max_event_bytes (524288) and the weight gate would have admitted it. Must now be accepted.
	tw1, _ := keypair(t)
	if got := publishOutcome(t, ws, blindNoteOfSize(t, tw1, makeCredential(t, sk), 515000)); got != "ok-true" {
		t.Fatalf("a note under max_event_bytes must reach the weight gate and be accepted, not dropped by the transport, got %q", got)
	}

	// Content sized to land right up against max_event_bytes (1KiB of slack for the tag/event-
	// metadata overhead the weight gate counts that raw content size doesn't) — proves frames near
	// the CONFIGURED CAP itself, not just the old hardcoded 512000 wall, are delivered and accepted.
	tw2, _ := keypair(t)
	if got := publishOutcome(t, ws, blindNoteOfSize(t, tw2, makeCredential(t, sk), 524288-1024)); got != "ok-true" {
		t.Fatalf("a note at the max_event_bytes boundary must be accepted, got %q", got)
	}

	// Content past max_event_bytes but still well under the new (524288+64KiB) transport ceiling: the
	// raised transport ceiling must not have swallowed the weight gate's own enforcement — this must
	// be rejected WITH an OK:false frame (a policy decision), never silently dropped by the transport.
	tw3, _ := keypair(t)
	if got := publishOutcome(t, ws, blindNoteOfSize(t, tw3, makeCredential(t, sk), 530000)); got != "ok-false" {
		t.Fatalf("a note over max_event_bytes must be rejected by the weight gate (ok-false), got %q", got)
	}
}
