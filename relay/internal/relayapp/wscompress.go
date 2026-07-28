package relayapp

import (
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"unsafe"

	"github.com/fiatjaf/khatru"
)

// ---------------------------------------------------------------------------------------------
// permessage-deflate (RFC 7692) on the relay WebSocket.
//
// WHICH LIBRARY. khatru v0.19.1 does NOT use gorilla/websocket. It imports
// github.com/fasthttp/websocket (a maintained gorilla fork; see khatru's websocket.go/relay.go and
// our go.mod, where fasthttp/websocket is pulled in as khatru's dependency). gorilla/websocket is
// ALSO in our go.mod — it is used by the relay's own tests and by cmd/pushwatcher, not by khatru —
// so reasoning about khatru's transport from go.mod's direct requires alone gets the wrong library.
//
// WHAT THAT LIBRARY SUPPORTS. fasthttp/websocket implements permessage-deflate in a deliberately
// "limited capacity" (its own words, doc.go). Concretely, and these are not knobs we can turn:
//
//   - NO CONTEXT TAKEOVER, both directions, always. The handshake response is the fixed string
//     "permessage-deflate; server_no_context_takeover; client_no_context_takeover" and the only
//     writer constructor wired up is compressNoContextTakeover. Each websocket message is deflated
//     against an EMPTY dictionary.
//   - WINDOW IS ALWAYS 15 BITS (32 KiB). The upgrader ignores every extension parameter in the
//     client's offer, including server_max_window_bits and client_max_window_bits — see
//     normalizeWebsocketExtensions below, which is what makes that safe.
//   - COMPRESSION LEVEL IS ALWAYS 1 (defaultCompressionLevel). The per-level knob lives on
//     *websocket.Conn (SetCompressionLevel), and khatru never hands us the Conn, so from the
//     Upgrader the level is not reachable.
//
// So the honest summary of "sane window/memory settings" is: the library offers exactly one knob,
// on/off, and its fixed settings happen to be the ones a memory-tight box wants anyway.
// No-context-takeover means flate writers are POOLED and returned after each message, so live
// compression state scales with peak concurrent WRITES, not with connection count — context
// takeover would have pinned a ~810 KB writer per connection for its lifetime (measured, level 1),
// which this host cannot afford. Level 1 costs ~810 KB of transient heap per in-flight compressed
// message versus ~1.05 MB at level 6.
//
// WHAT IT ACTUALLY BUYS US — measured, per-message, level 1, no context takeover:
//
//	EVENT (kind-7 reaction)            511 B  ->   335 B   (66%)
//	EVENT (kind-1 plaintext post)     1097 B  ->   827 B   (75%)
//	REQ   (feed filters)               173 B  ->   134 B   (78%)
//	EVENT (kind-1059 NIP-44 DM)       1804 B  ->  1810 B   (100.3% — GREW)
//	EVENT (kind-30351 media blob)      267 KB ->   267 KB  (100.0% — GREW)
//	REQ   (by 4 ids)                   296 B  ->   302 B   (102% — GREW)
//	OK / EOSE frames                    <130 B, grow by ~6 B each
//
// The win is confined to frames with English/JSON structure: EVENT envelopes for plaintext posts
// and reactions, and REQ filters. It is roughly a quarter to a third off those. It is ZERO on the
// bytes that actually dominate this relay's traffic when they appear at all — base64 media blobs
// and NIP-44 ciphertext do not compress AT LEVEL 1, at all, and pay ~6 bytes of deflate framing.
// (At level 6 the same DM frame drops to 78% and the blob to 88%, because a full Huffman pass does
// recover base64's 6-bits-in-8 padding — but level 6 is not reachable from the Upgrader, and see
// the privacy note below for why we should not want it.)
//
// A cold-start feed page of 50 posts is ~47.5 KB and lands at ~36 KB: about 11 KB saved per cold
// start. Real, worth having over a Tor circuit, and not remotely a transformation. Anyone
// re-opening this question should read the measured table above first: the ceiling on
// per-message deflate for our traffic is already known, and the large remaining win (a 50-event
// stream compresses to 47% when it shares ONE dictionary) is only reachable with context
// takeover, which this library does not implement and this host cannot afford.
//
// WHAT IT BUYS US TODAY: nothing. The shipped client's WebSocket is hand-rolled over a raw SOCKS
// socket (client/android/.../StiqSocketModule.kt) and its handshake sends no Sec-WebSocket-Extensions
// header at all, so it never offers the extension and this code never engages for it. That is also
// exactly why turning this on is safe for the deployed fleet: the negotiation is strictly opt-in
// from the client side, and a client that does not offer gets a byte-identical handshake response
// and byte-identical frames. The server side has to land first regardless — a client cannot offer
// an extension the server will not answer.
//
// CRIME/BREACH. The precondition for a compression-side-channel attack is that attacker-chosen
// plaintext shares a compression dictionary with a secret. Neither half holds here:
//
//   - No context takeover means every message is deflated against an EMPTY dictionary, so nothing
//     an attacker puts in message A can shrink message B. The classic cross-request oracle is
//     structurally absent, not merely difficult.
//   - Within a single message there is no secret to leak. A relay->client frame is one EVENT (whose
//     bytes that reader is already entitled to in full), or an OK/EOSE/CLOSED/NOTICE, or a NIP-42
//     challenge, or a NIP-77 fingerprint of public event ids. The relay holds no per-connection
//     secret that it emits alongside attacker-influenced text. Client->relay frames are compressed
//     by the client and carry the client's own single signed event.
//
// The residual, and it is a traffic-analysis point rather than a CRIME one: compressing makes a
// frame's length depend on its plaintext's entropy. NIP-44 pads its plaintext into buckets
// specifically so ciphertext length does not leak message length — and the measurement above shows
// level-1 deflate leaves NIP-44 base64 at 100.3% of its size, so that padding survives intact. This
// is the one place where the library's un-tunable level 1 is a FEATURE and not a limitation: at
// level 6 sealed bodies would shrink by ~22% and that shrink would be a function of the padded
// plaintext, partially undoing the padding. If anyone ever finds a way to raise the level, do not.
// ---------------------------------------------------------------------------------------------

// enableWebsocketCompression flips EnableCompression on the websocket.Upgrader that khatru
// upgrades connections with, and reports whether it succeeded.
//
// khatru keeps that upgrader in an UNEXPORTED field (`upgrader` on khatru.Relay) with no setter and
// no option, so there is no supported way to reach it; the alternative to this is forking khatru
// behind a `replace`, which is a far worse thing to carry. The write happens once at construction,
// before the relay is served, on a field khatru itself only ever READS (per handshake) — so it
// races nothing.
//
// It is deliberately located by FIELD NAME, on both hops, and type-checked at each step:
//   - a khatru release that renames, removes, or retypes `upgrader` makes this return false and the
//     relay serves uncompressed, which is exactly today's behaviour;
//   - it does not name websocket.Upgrader as a type, so it keeps fasthttp/websocket out of our
//     go.mod's direct requires and keeps working if khatru ever switches to gorilla (whose Upgrader
//     has the same EnableCompression bool).
//
// A false return is a soft failure by design: compression is an optimisation, and no configuration
// of it is worth refusing to serve a relay over.
func enableWebsocketCompression(relay *khatru.Relay) bool {
	if relay == nil {
		return false
	}
	rv := reflect.ValueOf(relay)
	if rv.Kind() != reflect.Ptr || rv.IsNil() || rv.Elem().Kind() != reflect.Struct {
		return false
	}
	up := rv.Elem().FieldByName("upgrader")
	if !up.IsValid() || up.Kind() != reflect.Struct || !up.CanAddr() {
		return false
	}
	ec := up.FieldByName("EnableCompression")
	if !ec.IsValid() || ec.Kind() != reflect.Bool || !ec.CanAddr() {
		return false
	}
	// unsafe.Pointer(reflect.Value.UnsafeAddr()) in a single expression is the sanctioned conversion
	// (unsafe.Pointer rules, pattern 5): the uintptr is never stored, so no GC move can invalidate it.
	*(*bool)(unsafe.Pointer(ec.UnsafeAddr())) = true
	return true
}

// ---------------------------------------------------------------------------------------------
// Extension-offer normalisation.
//
// fasthttp/websocket's Upgrade accepts an offer on NAME ALONE: it scans the client's
// Sec-WebSocket-Extensions for "permessage-deflate" and, on a match, compresses with a 15-bit
// window while ignoring every parameter the client sent. That is fine for the common offers, and
// wrong for two of them:
//
//   - "permessage-deflate; client_max_window_bits=10" — the client is telling us its INFLATER has a
//     1 KiB window. We would deflate with 32 KiB. Any back-reference beyond the client's window
//     makes its inflate fail, and the connection dies mid-stream with no useful diagnostic.
//   - "permessage-deflate; server_max_window_bits=10" — same, expressed as a demand on us.
//
// So we normalise the offer BEFORE khatru's upgrader sees it, and we only ever normalise DOWNWARD:
// an offer we cannot honour exactly is deleted, which makes the upgrader find no permessage-deflate
// and answer the handshake with no extension at all. The client then speaks plain uncompressed
// websocket, which every client can do. There is no failure mode where we compress into a window a
// client did not agree to.
//
// A valueless client_max_window_bits/server_max_window_bits is KEPT: per RFC 7692 §7.1.2.2 that form
// means "I support this parameter", not "I require a smaller window", and a server that omits the
// parameter from its response is choosing 15 — which is what we do. This is the form browsers send.
// ---------------------------------------------------------------------------------------------

// wsExtensionsHeader is the extension-offer header, spelled as RFC 6455 spells it.
//
// It MUST only ever be used through http.Header's Get/Set/Del/Values methods, never as a raw map
// key. Go canonicalises header map keys to "Sec-Websocket-Extensions" (lowercase "socket"), which is
// also the literal key fasthttp/websocket indexes when it parses the offer — so indexing the map
// with this spelling silently finds nothing, and this guard silently stops guarding. That is not
// hypothetical: it is what the first version of this code did, and only the end-to-end handshake
// test caught it.
const wsExtensionsHeader = "Sec-WebSocket-Extensions"

// normalizeWebsocketExtensions rewrites (or deletes) h's Sec-WebSocket-Extensions so that whatever
// survives is an offer this server can honour byte-for-byte. It is a no-op when the header is
// absent, which is the case for every currently deployed client.
func normalizeWebsocketExtensions(h http.Header) {
	raw := h.Values(wsExtensionsHeader)
	if len(raw) == 0 {
		return
	}
	kept := 0
	for _, value := range raw {
		for _, offer := range strings.Split(value, ",") {
			if deflateOfferAcceptable(offer) {
				kept++
			}
		}
	}
	if kept == 0 {
		// No offer we can honour. Removing the header entirely is what makes a
		// window-constrained client fall back to uncompressed instead of to a broken stream.
		h.Del(wsExtensionsHeader)
		return
	}
	// Collapse to the single canonical offer. The upgrader matches on name only and answers with its
	// own fixed parameter string, so re-emitting the client's parameters would be noise; emitting one
	// clean offer keeps what khatru sees identical no matter which acceptable variant was sent.
	h.Set(wsExtensionsHeader, "permessage-deflate")
}

// deflateOfferAcceptable reports whether ONE offer element (the text between commas) is a
// permessage-deflate offer whose every parameter this server honours exactly.
func deflateOfferAcceptable(offer string) bool {
	parts := strings.Split(offer, ";")
	if len(parts) == 0 {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(parts[0]), "permessage-deflate") {
		return false
	}
	for _, p := range parts[1:] {
		name, value, hasValue := strings.Cut(strings.TrimSpace(p), "=")
		name = strings.ToLower(strings.TrimSpace(name))
		value = strings.Trim(strings.TrimSpace(value), `"`)
		switch name {
		case "":
			// A stray ";" — tolerate it rather than dropping an otherwise fine offer.
		case "server_no_context_takeover", "client_no_context_takeover":
			// We never take context over in either direction, so both are satisfied by construction.
			// Neither takes a value; one carrying a value is malformed, so refuse it.
			if hasValue && value != "" {
				return false
			}
		case "client_max_window_bits", "server_max_window_bits":
			// Valueless: a capability announcement, satisfied by our 15. With a value: a constraint,
			// and 15 is the only one we can meet since the library's window is not configurable.
			if !hasValue || value == "" {
				continue
			}
			bits, err := strconv.Atoi(value)
			if err != nil || bits != 15 {
				return false
			}
		default:
			// An extension parameter we have never heard of. We cannot know whether ignoring it
			// changes the wire format, so we do not accept the offer.
			return false
		}
	}
	return true
}
