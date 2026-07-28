package relayapp

import (
	"bufio"
	"bytes"
	"compress/flate"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	kpflate "github.com/klauspost/compress/flate"

	"github.com/stiq/relay/internal/config"
)

// ---------------------------------------------------------------------------------------------
// Offer normalisation
// ---------------------------------------------------------------------------------------------

func TestNormalizeWebsocketExtensions(t *testing.T) {
	cases := []struct {
		name  string
		offer []string // nil = header absent entirely
		want  string   // "" = header must be absent afterwards
	}{
		{"absent header is untouched", nil, ""},
		{"bare offer", []string{"permessage-deflate"}, "permessage-deflate"},
		{
			"browser offer (valueless client_max_window_bits)",
			[]string{"permessage-deflate; client_max_window_bits"},
			"permessage-deflate",
		},
		{
			"explicit 15-bit windows are exactly what we do",
			[]string{"permessage-deflate; client_max_window_bits=15; server_max_window_bits=15"},
			"permessage-deflate",
		},
		{
			"no-context-takeover is satisfied by construction",
			[]string{"permessage-deflate; server_no_context_takeover; client_no_context_takeover"},
			"permessage-deflate",
		},
		{
			"a window we cannot honour is refused, not silently ignored",
			[]string{"permessage-deflate; client_max_window_bits=10"},
			"",
		},
		{
			"a server window we cannot honour is refused",
			[]string{"permessage-deflate; server_max_window_bits=8"},
			"",
		},
		{
			"an unknown parameter is refused",
			[]string{"permessage-deflate; some_future_param=3"},
			"",
		},
		{
			"an unrelated extension is refused",
			[]string{"x-webkit-deflate-frame"},
			"",
		},
		{
			"a fallback offer survives when the preferred one cannot be honoured",
			[]string{"permessage-deflate; server_max_window_bits=10, permessage-deflate"},
			"permessage-deflate",
		},
		{
			"multiple header lines are considered together",
			[]string{"x-webkit-deflate-frame", "permessage-deflate"},
			"permessage-deflate",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Add(), not a raw map assignment: this must go through Go's header canonicalisation,
			// because that mismatch is the exact bug this function had.
			h := http.Header{}
			for _, v := range tc.offer {
				h.Add(wsExtensionsHeader, v)
			}
			normalizeWebsocketExtensions(h)
			got := h.Get(wsExtensionsHeader)
			if got != tc.want {
				t.Fatalf("offer %q -> %q, want %q", tc.offer, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------------------------
// End-to-end handshake + frame behaviour, spoken over a raw socket.
//
// These are deliberately NOT written with a websocket library. The property under test is what
// bytes cross the wire for a client that offers the extension and for one that does not, and the
// deployed fleet's client is itself a hand-rolled handshake over a raw socket — so testing through
// a library that negotiates on our behalf would test the library, not the fleet's compatibility.
// ---------------------------------------------------------------------------------------------

func newRelayForCompression(t *testing.T, compression *bool) string {
	t.Helper()
	_, issuerPEM := issuerKeyPEM(t)
	cfg := config.Config{
		Listen:               "127.0.0.1:0",
		IssuerPublicKeys:     []string{issuerPEM},
		AllowedKinds:         config.DefaultAllowedKinds,
		WebsocketCompression: compression,
	}
	relay, closeStore, _, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	srv := httptest.NewServer(relay)
	t.Cleanup(srv.Close)
	return strings.TrimPrefix(srv.URL, "http://")
}

// rawHandshake opens a TCP connection and performs the websocket upgrade by hand, offering exactly
// the Sec-WebSocket-Extensions value given (empty = send no such header at all). It returns the
// parsed response headers and the still-open connection.
func rawHandshake(t *testing.T, addr, extensions string) (net.Conn, *bufio.Reader, http.Header) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("rand: %v", err)
	}
	req := "GET / HTTP/1.1\r\n" +
		"Host: " + addr + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + base64.StdEncoding.EncodeToString(key) + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n"
	if extensions != "" {
		req += "Sec-WebSocket-Extensions: " + extensions + "\r\n"
	}
	req += "\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write handshake: %v", err)
	}

	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("read handshake response: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade status = %d, want 101", resp.StatusCode)
	}
	return conn, br, resp.Header
}

// writeClientTextFrame writes one masked, UNCOMPRESSED (RSV1=0) text frame. RFC 7692 lets a peer
// send an uncompressed message even when permessage-deflate is negotiated, which keeps this helper
// honest about what it is testing: the SERVER's compression, not ours.
func writeClientTextFrame(t *testing.T, w io.Writer, payload []byte) {
	t.Helper()
	var hdr []byte
	n := len(payload)
	switch {
	case n < 126:
		hdr = []byte{0x81, byte(0x80 | n)}
	case n < 1<<16:
		hdr = []byte{0x81, 0x80 | 126, byte(n >> 8), byte(n)}
	default:
		t.Fatalf("test payload too large: %d", n)
	}
	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil {
		t.Fatalf("rand: %v", err)
	}
	hdr = append(hdr, mask...)
	masked := make([]byte, n)
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	if _, err := w.Write(append(hdr, masked...)); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

// readServerFrame reads one unmasked server frame and reports whether RSV1 (the permessage-deflate
// "this message is compressed" bit) was set.
func readServerFrame(t *testing.T, br *bufio.Reader) (rsv1 bool, opcode byte, payload []byte) {
	t.Helper()
	b0, err := br.ReadByte()
	if err != nil {
		t.Fatalf("read frame byte 0: %v", err)
	}
	b1, err := br.ReadByte()
	if err != nil {
		t.Fatalf("read frame byte 1: %v", err)
	}
	rsv1 = b0&0x40 != 0
	opcode = b0 & 0x0f
	if b1&0x80 != 0 {
		t.Fatal("server frame must not be masked")
	}
	n := int(b1 & 0x7f)
	switch n {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(br, ext[:]); err != nil {
			t.Fatalf("read 16-bit length: %v", err)
		}
		n = int(ext[0])<<8 | int(ext[1])
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(br, ext[:]); err != nil {
			t.Fatalf("read 64-bit length: %v", err)
		}
		n = 0
		for _, b := range ext {
			n = n<<8 | int(b)
		}
	}
	payload = make([]byte, n)
	if _, err := io.ReadFull(br, payload); err != nil {
		t.Fatalf("read payload: %v", err)
	}
	return rsv1, opcode, payload
}

// inflateNoContextTakeover reverses one permessage-deflate message body, appending the tail RFC 7692
// strips from the wire.
func inflateNoContextTakeover(t *testing.T, b []byte) []byte {
	t.Helper()
	r := flate.NewReader(io.MultiReader(
		bytes.NewReader(b),
		strings.NewReader("\x00\x00\xff\xff\x01\x00\x00\xff\xff"),
	))
	defer r.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("inflate: %v", err)
	}
	return out
}

// probeREQ is a filter shaped so the relay answers SOMETHING (EOSE or CLOSED) on an empty store,
// which is all these tests need — they assert on the frame's compression bit, not its content.
const probeREQ = `["REQ","compression-probe",{"kinds":[1],"limit":1}]`

func TestWebsocketCompressionNegotiatedAndApplied(t *testing.T) {
	addr := newRelayForCompression(t, nil) // nil = shipped default
	conn, br, hdr := rawHandshake(t, addr, "permessage-deflate; client_max_window_bits")

	ext := hdr.Get("Sec-WebSocket-Extensions")
	if !strings.Contains(ext, "permessage-deflate") {
		t.Fatalf("server did not negotiate permessage-deflate; Sec-WebSocket-Extensions = %q", ext)
	}
	// The library only ever answers with no-context-takeover in both directions. Assert it, because
	// the whole memory argument for enabling this rests on it (see wscompress.go).
	for _, want := range []string{"server_no_context_takeover", "client_no_context_takeover"} {
		if !strings.Contains(ext, want) {
			t.Fatalf("negotiated %q, want it to include %q", ext, want)
		}
	}

	writeClientTextFrame(t, conn, []byte(probeREQ))
	rsv1, opcode, payload := readServerFrame(t, br)
	if opcode != 0x1 {
		t.Fatalf("server opcode = %d, want 1 (text)", opcode)
	}
	if !rsv1 {
		t.Fatalf("server frame did not set RSV1: it negotiated compression but sent %q uncompressed", payload)
	}
	got := inflateNoContextTakeover(t, payload)
	if !bytes.HasPrefix(got, []byte(`["`)) {
		t.Fatalf("inflated frame is not a nostr envelope: %q", got)
	}
	t.Logf("compressed reply: %d bytes on the wire, %d inflated (%s)", len(payload), len(got), got)
}

// TestWebsocketHandshakeUnchangedForFleetClient is the backward-compatibility guarantee. The
// deployed client sends no Sec-WebSocket-Extensions header; it must get a handshake with no
// extension in it and plain uncompressed frames, exactly as before this feature existed.
func TestWebsocketHandshakeUnchangedForFleetClient(t *testing.T) {
	addr := newRelayForCompression(t, nil)
	conn, br, hdr := rawHandshake(t, addr, "") // no offer at all — the shipped client's handshake

	if ext := hdr.Get("Sec-WebSocket-Extensions"); ext != "" {
		t.Fatalf("server answered a client that offered no extensions with %q", ext)
	}
	writeClientTextFrame(t, conn, []byte(probeREQ))
	rsv1, opcode, payload := readServerFrame(t, br)
	if opcode != 0x1 {
		t.Fatalf("server opcode = %d, want 1 (text)", opcode)
	}
	if rsv1 {
		t.Fatal("server set RSV1 for a client that never negotiated compression")
	}
	if !bytes.HasPrefix(payload, []byte(`["`)) {
		t.Fatalf("frame is not a plain nostr envelope: %q", payload)
	}
}

// TestWebsocketCompressionRejectsUnhonourableWindow guards the half of this feature that is easy to
// lose. fasthttp/websocket's upgrader matches permessage-deflate on NAME alone and would happily
// deflate with a 32 KiB window for a client that just told us its inflater has 1 KiB. If khatru ever
// stops running RejectConnection hooks before the upgrade, this test fails instead of the fleet.
func TestWebsocketCompressionRejectsUnhonourableWindow(t *testing.T) {
	addr := newRelayForCompression(t, nil)
	_, _, hdr := rawHandshake(t, addr, "permessage-deflate; client_max_window_bits=10")
	if ext := hdr.Get("Sec-WebSocket-Extensions"); ext != "" {
		t.Fatalf("server accepted an offer it cannot honour: %q", ext)
	}
}

func TestWebsocketCompressionDisabledByConfig(t *testing.T) {
	off := false
	addr := newRelayForCompression(t, &off)
	conn, br, hdr := rawHandshake(t, addr, "permessage-deflate")
	if ext := hdr.Get("Sec-WebSocket-Extensions"); ext != "" {
		t.Fatalf("websocket_compression=false still negotiated %q", ext)
	}
	writeClientTextFrame(t, conn, []byte(probeREQ))
	if rsv1, _, _ := readServerFrame(t, br); rsv1 {
		t.Fatal("websocket_compression=false still compressed a frame")
	}
}

// TestEnableWebsocketCompressionFindsKhatruUpgrader pins the reflective reach into khatru's
// unexported upgrader field. A khatru upgrade that renames or retypes it degrades to "no
// compression" silently and safely — this test is what turns that silence into a signal.
func TestEnableWebsocketCompressionFindsKhatruUpgrader(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	relay, closeStore, _, err := New(config.Config{
		Listen:           "127.0.0.1:0",
		IssuerPublicKeys: []string{issuerPEM},
		AllowedKinds:     config.DefaultAllowedKinds,
	})
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	if !enableWebsocketCompression(relay) {
		t.Fatal("could not reach khatru's upgrader.EnableCompression — khatru's internals moved")
	}
	if enableWebsocketCompression(nil) {
		t.Fatal("a nil relay must be reported as a failure, not a success")
	}
}

// ---------------------------------------------------------------------------------------------
// The measurements the decision to enable this rests on. These assert only the conclusions that
// would change the decision if they moved; the rest is logged so the numbers stay checkable rather
// than becoming folklore in a comment. See the header of wscompress.go.
// ---------------------------------------------------------------------------------------------

// deflateOneMessage mimics exactly what the library does to one websocket message: a fresh flate
// stream at the library's fixed level, flushed, minus the 4 tail bytes RFC 7692 strips.
//
// It deflates with klauspost/compress/flate, NOT the standard library's compress/flate, because
// that is the implementation fasthttp/websocket imports — and for our traffic the two disagree
// dramatically. At level 1 klauspost's fast encoder emits STORED blocks for data it cannot match
// into, so base64 and ciphertext come out at 100% of their size; the standard library's level 1
// still runs a full Huffman pass and squeezes base64 to ~75%. Measuring with the stdlib would have
// credited this relay with a ~25% saving on media blobs and DMs that it will never actually get.
// (The inflate side of these tests deliberately stays on the standard library, which doubles as a
// check that what we emit is plain interoperable DEFLATE.)
func deflateOneMessage(t *testing.T, msg []byte) int {
	t.Helper()
	var buf bytes.Buffer
	// level 1 is fasthttp/websocket's defaultCompressionLevel and is not configurable from the
	// Upgrader; measuring at any other level would measure a relay we cannot build.
	fw, err := kpflate.NewWriter(&buf, 1)
	if err != nil {
		t.Fatalf("flate.NewWriter: %v", err)
	}
	if _, err := fw.Write(msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := fw.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	return buf.Len() - 4
}

func randHexStr(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

func randB64Str(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func TestMeasuredCompressionRatios(t *testing.T) {
	prose := "The organizer just posted the new meeting times for next week. " +
		"Everyone who signed up for the Thursday slot should check the pinned message, " +
		"because the room changed again and the old link no longer works."

	plaintextPost := fmt.Sprintf(
		`["EVENT","sub-feed-0",{"id":"%s","pubkey":"%s","created_at":1750000000,"kind":1,`+
			`"tags":[["t","announcements"],["stiq_tok","%s"]],"content":%q,"sig":"%s"}]`,
		randHexStr(t, 32), randHexStr(t, 32), randB64Str(t, 256), prose, randHexStr(t, 64))
	sealedDM := fmt.Sprintf(
		`["EVENT","sub-dm",{"id":"%s","pubkey":"%s","created_at":1750000000,"kind":1059,`+
			`"tags":[["p","%s"]],"content":"%s","sig":"%s"}]`,
		randHexStr(t, 32), randHexStr(t, 32), randHexStr(t, 32), randB64Str(t, 1024), randHexStr(t, 64))
	mediaBlob := fmt.Sprintf(
		`["EVENT","sub-blob",{"id":"%s","pubkey":"%s","created_at":1750000000,"kind":30351,`+
			`"tags":[],"content":"%s","sig":"%s"}]`,
		randHexStr(t, 32), randHexStr(t, 32), randB64Str(t, 200*1024), randHexStr(t, 64))

	ratio := func(msg string) float64 {
		return float64(deflateOneMessage(t, []byte(msg))) / float64(len(msg))
	}

	postRatio, dmRatio, blobRatio := ratio(plaintextPost), ratio(sealedDM), ratio(mediaBlob)
	t.Logf("kind-1 plaintext post: %d B -> %.1f%%", len(plaintextPost), 100*postRatio)
	t.Logf("kind-1059 NIP-44 DM:   %d B -> %.1f%%", len(sealedDM), 100*dmRatio)
	t.Logf("kind-30351 media blob: %d B -> %.1f%%", len(mediaBlob), 100*blobRatio)

	// Conclusion 1: plaintext envelopes are where the entire win lives.
	if postRatio > 0.85 {
		t.Errorf("plaintext post compressed to %.1f%%, expected well under 85%% — "+
			"the case for enabling permessage-deflate at all rests on this", 100*postRatio)
	}
	// Conclusion 2: sealed bodies and base64 media do not compress at the library's fixed level 1,
	// and that is load-bearing twice over — it caps the honest bandwidth claim, and it is what
	// preserves NIP-44's length padding (see the privacy note in wscompress.go). If either of these
	// ever starts compressing, both the bandwidth story and the padding argument need rewriting.
	if dmRatio < 0.95 {
		t.Errorf("NIP-44 ciphertext now compresses to %.1f%%; NIP-44's length padding no longer "+
			"survives deflate — re-read the privacy note in wscompress.go", 100*dmRatio)
	}
	if blobRatio < 0.95 {
		t.Errorf("base64 media now compresses to %.1f%%; the bandwidth estimate in wscompress.go "+
			"understates the win and should be redone", 100*blobRatio)
	}
}

func TestMeasuredFlateWriterFootprint(t *testing.T) {
	const n = 32
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	writers := make([]*kpflate.Writer, n)
	for i := range writers {
		w, err := kpflate.NewWriter(io.Discard, 1)
		if err != nil {
			t.Fatalf("flate.NewWriter: %v", err)
		}
		if _, err := w.Write([]byte("hello hello hello")); err != nil {
			t.Fatalf("write: %v", err)
		}
		if err := w.Flush(); err != nil {
			t.Fatalf("flush: %v", err)
		}
		writers[i] = w
	}
	runtime.ReadMemStats(&after)
	runtime.KeepAlive(writers)

	each := (after.HeapAlloc - before.HeapAlloc) / n
	t.Logf("live flate.Writer (level 1): ~%d bytes each", each)
	// This is the number that decides whether context takeover would be affordable. It would not be:
	// with context takeover this is per-CONNECTION and permanent, rather than per-in-flight-message
	// and pooled. Assert only the order of magnitude, so the test does not become a heap-noise alarm.
	if each < 100<<10 {
		t.Errorf("a flate writer now costs only %d bytes; the memory argument against context "+
			"takeover in wscompress.go may no longer hold", each)
	}
}
