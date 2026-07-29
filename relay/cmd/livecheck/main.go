// Command livecheck drives a REAL compiled stiq-relay binary over a REAL WebSocket.
//
// Every other relay test builds the relay in-process via httptest, which skips main.go entirely —
// config loading, the fail-closed startup gates, the warning banners, the listener. A change that
// only breaks the binary's own wiring passes the whole suite. This spawns the actual binary the
// way systemd does (config file, env, loopback listener) and asserts the wire behaviour a
// DEPLOYED relay exhibits, so it is a pre-deploy smoke test rather than a unit test:
//
//	go build -o /tmp/stiq-relay . && go run ./cmd/livecheck /tmp/stiq-relay
//
// It is a `cmd/` main, not a _test.go file, on purpose: it needs a compiled artifact to point at,
// and `go test ./...` must not spawn processes and bind ports.
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/membership"
	"github.com/stiq/relay/internal/policy"
)

var failures int

func check(name string, ok bool, detail string) {
	if ok {
		fmt.Printf("  PASS  %s\n", name)
		return
	}
	failures++
	fmt.Printf("  FAIL  %s\n        -> %s\n", name, detail)
}

func must(err error, what string) {
	if err != nil {
		fmt.Printf("harness error (%s): %v\n", what, err)
		os.Exit(2)
	}
}

func freePort() int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	must(err, "freePort")
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// ---- relay lifecycle -------------------------------------------------------

type relayProc struct {
	cmd    *exec.Cmd
	ws     string
	dir    string
	stderr *strings.Builder
}

func startRelay(binary string, issuerPEM string, extra map[string]any) *relayProc {
	dir, err := os.MkdirTemp("", "livecheck")
	must(err, "mkdtemp")
	port := freePort()

	cfg := map[string]any{
		"listen":             fmt.Sprintf("127.0.0.1:%d", port),
		"issuer_public_keys": []string{issuerPEM},
		"data_dir":           filepath.Join(dir, "data"),
		"membership_file":    filepath.Join(dir, "membership.json"),
		"pow_difficulty":     0,
		"enroll_pow":         0,
	}
	for k, v := range extra {
		cfg[k] = v
	}
	buf, err := json.MarshalIndent(cfg, "", "  ")
	must(err, "marshal config")
	cfgPath := filepath.Join(dir, "config.json")
	must(os.WriteFile(cfgPath, buf, 0o600), "write config")

	stderr := &strings.Builder{}
	cmd := exec.Command(binary)
	cmd.Env = append(os.Environ(),
		"STIQ_RELAY_CONFIG="+cfgPath,
		"STIQ_RELAY_DEBUG_LOG=1",
	)
	cmd.Stderr = stderr
	cmd.Stdout = stderr
	must(cmd.Start(), "start relay")

	ws := fmt.Sprintf("ws://127.0.0.1:%d", port)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		c, _, err := websocket.DefaultDialer.Dial(ws, nil)
		if err == nil {
			c.Close()
			return &relayProc{cmd: cmd, ws: ws, dir: dir, stderr: stderr}
		}
		time.Sleep(100 * time.Millisecond)
	}
	fmt.Printf("relay never came up. stderr:\n%s\n", stderr.String())
	_ = cmd.Process.Kill()
	os.Exit(2)
	return nil
}

func (r *relayProc) stop() {
	_ = r.cmd.Process.Kill()
	_, _ = r.cmd.Process.Wait()
	os.RemoveAll(r.dir)
}

// ---- wire helpers ----------------------------------------------------------

func issuerKeyPEM() (*rsa.PrivateKey, string) {
	sk, err := rsa.GenerateKey(rand.Reader, 2048)
	must(err, "gen issuer key")
	der, err := x509.MarshalPKIXPublicKey(&sk.PublicKey)
	must(err, "marshal issuer pub")
	return sk, string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func makeCredential(issuerSK *rsa.PrivateKey) membership.Credential {
	token := make([]byte, 32)
	_, err := rand.Read(token)
	must(err, "rand token")
	issuer := membership.NewIssuer(issuerSK)
	cred, err := membership.RequestCredential(&issuerSK.PublicKey, token, issuer.BlindSign)
	must(err, "RequestCredential")
	return cred
}

func keypair() (string, string) {
	sk := nostr.GeneratePrivateKey()
	pk, err := nostr.GetPublicKey(sk)
	must(err, "GetPublicKey")
	return sk, pk
}

func bindingEvent(sk string, cred membership.Credential) *nostr.Event {
	ev := &nostr.Event{
		Kind:      policy.KindMembershipBinding,
		CreatedAt: nostr.Now(),
		Tags: nostr.Tags{
			{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
			{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)},
		},
	}
	must(ev.Sign(sk), "sign binding")
	return ev
}

func signed(sk string, kind int, content string, tags nostr.Tags) *nostr.Event {
	if tags == nil {
		tags = nostr.Tags{}
	}
	ev := &nostr.Event{Kind: kind, CreatedAt: nostr.Now(), Tags: tags, Content: content}
	must(ev.Sign(sk), "sign event")
	return ev
}

func publish(ws string, ev *nostr.Event) (bool, string) {
	c, _, err := websocket.DefaultDialer.Dial(ws, nil)
	must(err, "dial")
	defer c.Close()
	payload, err := json.Marshal([]any{"EVENT", ev})
	must(err, "marshal EVENT")
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	must(c.WriteMessage(websocket.TextMessage, payload), "write EVENT")
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return false, "read error: " + err.Error()
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
		var msg string
		_ = json.Unmarshal(frame[2], &accepted)
		if len(frame) > 3 {
			_ = json.Unmarshal(frame[3], &msg)
		}
		return accepted, msg
	}
}

// query sends a REQ and collects events until EOSE or CLOSED.
func query(ws string, filter map[string]any) (closed bool, closeMsg string, events []*nostr.Event) {
	c, _, err := websocket.DefaultDialer.Dial(ws, nil)
	must(err, "dial")
	defer c.Close()
	payload, err := json.Marshal([]any{"REQ", "sub1", filter})
	must(err, "marshal REQ")
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	must(c.WriteMessage(websocket.TextMessage, payload), "write REQ")
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return false, "read error: " + err.Error(), events
		}
		var frame []json.RawMessage
		if err := json.Unmarshal(data, &frame); err != nil || len(frame) < 2 {
			continue
		}
		var typ string
		_ = json.Unmarshal(frame[0], &typ)
		switch typ {
		case "CLOSED":
			if len(frame) > 2 {
				_ = json.Unmarshal(frame[2], &closeMsg)
			}
			return true, closeMsg, events
		case "EVENT":
			if len(frame) > 2 {
				var ev nostr.Event
				if json.Unmarshal(frame[2], &ev) == nil {
					events = append(events, &ev)
				}
			}
		case "EOSE":
			return false, "", events
		}
	}
}

// countReq sends a COUNT and reports the tally plus any NOTICE that preceded it.
//
// khatru does NOT answer a rejected COUNT with CLOSED: handleCountRequest writes a NOTICE
// carrying the reject message and returns a tally of 0. So "rejected" on the wire looks like
// (notice != "", count == 0) — which is why the checks below discriminate a rejected count from
// a genuine zero rather than trusting the number alone.
func countReq(ws string, filter map[string]any) (count int64, notice string) {
	c, _, err := websocket.DefaultDialer.Dial(ws, nil)
	must(err, "dial")
	defer c.Close()
	payload, err := json.Marshal([]any{"COUNT", "cnt1", filter})
	must(err, "marshal COUNT")
	_ = c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	must(c.WriteMessage(websocket.TextMessage, payload), "write COUNT")
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return -1, "read error: " + err.Error()
		}
		var frame []json.RawMessage
		if err := json.Unmarshal(data, &frame); err != nil || len(frame) < 2 {
			continue
		}
		var typ string
		_ = json.Unmarshal(frame[0], &typ)
		switch typ {
		case "NOTICE":
			var n string
			_ = json.Unmarshal(frame[1], &n)
			notice = n
		case "CLOSED":
			var m string
			if len(frame) > 2 {
				_ = json.Unmarshal(frame[2], &m)
			}
			return -1, "CLOSED: " + m
		case "COUNT":
			var payload struct {
				Count int64 `json:"count"`
			}
			_ = json.Unmarshal(frame[len(frame)-1], &payload)
			return payload.Count, notice
		}
	}
}

func hasKind(events []*nostr.Event, kind int) bool {
	for _, e := range events {
		if e.Kind == kind {
			return true
		}
	}
	return false
}

// ---- checks ----------------------------------------------------------------

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: livecheck <path-to-stiq-relay-binary>")
		os.Exit(2)
	}
	binary := os.Args[1]

	issuerSK, issuerPEM := issuerKeyPEM()

	fmt.Println("== A. live binary: membership binding is write-only at the wire ==")
	r := startRelay(binary, issuerPEM, nil)
	defer r.stop()

	memberSK, memberPK := keypair()
	cred := makeCredential(issuerSK)
	ok, msg := publish(r.ws, bindingEvent(memberSK, cred))
	check("bind accepted (kind 9011 still WRITEABLE)", ok, "relay rejected the binding: "+msg)

	ok, msg = publish(r.ws, signed(memberSK, 1, "hello from a bound member", nil))
	check("bound member can post kind-1 (binding really took effect)", ok, "post rejected: "+msg)

	closed, cmsg, _ := query(r.ws, map[string]any{"kinds": []int{policy.KindMembershipBinding}})
	check("REQ kinds:[9011] is CLOSED", closed && strings.Contains(cmsg, "not readable"),
		fmt.Sprintf("closed=%v msg=%q", closed, cmsg))

	closed, cmsg, _ = query(r.ws, map[string]any{
		"kinds": []int{policy.KindMembershipBinding}, "authors": []string{memberPK}})
	check("author-scoped REQ for 9011 is CLOSED (no is-member oracle)", closed,
		fmt.Sprintf("closed=%v msg=%q", closed, cmsg))

	// COUNT is the enumeration path that matters most: it bypasses REQ's MaxLimit entirely and
	// answers with an exact integer. Prove the guard REJECTS rather than merely returning zero —
	// a real tally that tracked membership would be a perfect is-this-npub-a-member oracle.
	// An UNSCOPED count is caught by RequireScopedCount (finding #39) before RejectBindingReads is
	// even reached, so assert the property — rejected with a tally of 0 — not one hook's wording.
	n, notice := countReq(r.ws, map[string]any{"kinds": []int{policy.KindMembershipBinding}})
	check("COUNT kinds:[9011] is rejected (NOTICE) and tallies 0",
		n == 0 && notice != "",
		fmt.Sprintf("count=%d notice=%q", n, notice))

	// ...and SCOPED by author, where finding #39's guard passes, RejectBindingReads must be the
	// one that bites. This is the assertion that actually covers the new hook.
	nScoped, scopedNotice := countReq(r.ws, map[string]any{
		"kinds": []int{policy.KindMembershipBinding}, "authors": []string{memberPK}})
	check("author-scoped COUNT of 9011 is rejected BY THE BINDING GUARD",
		nScoped == 0 && strings.Contains(scopedNotice, "not readable"),
		fmt.Sprintf("count=%d notice=%q", nScoped, scopedNotice))

	nBound, _ := countReq(r.ws, map[string]any{
		"kinds": []int{policy.KindMembershipBinding}, "authors": []string{memberPK}})
	_, unboundPK := keypair()
	nUnbound, _ := countReq(r.ws, map[string]any{
		"kinds": []int{policy.KindMembershipBinding}, "authors": []string{unboundPK}})
	check("COUNT cannot distinguish a BOUND npub from an unbound one (no is-member oracle)",
		nBound == 0 && nUnbound == 0,
		fmt.Sprintf("ORACLE: bound=%d unbound=%d", nBound, nUnbound))

	// Control: COUNT still works for ordinary kinds, so the zeros above are the guard biting and
	// not COUNT being broken/unsupported relay-wide.
	nPosts, notice := countReq(r.ws, map[string]any{"kinds": []int{1}, "authors": []string{memberPK}})
	check("control: COUNT of the member's kind-1 posts is a REAL non-zero tally",
		nPosts >= 1 && notice == "",
		fmt.Sprintf("count=%d notice=%q — COUNT may be broken, invalidating the zeros above", nPosts, notice))

	// The kind-LESS path: this filter names no kind, so it passes RejectBindingReads. Only the
	// result-suppression wrapper stops the binding coming back.
	closed, cmsg, evs := query(r.ws, map[string]any{"authors": []string{memberPK}})
	check("kind-less author REQ is ALLOWED (ordinary reads still work)", !closed, "closed: "+cmsg)
	check("kind-less author REQ returns the member's kind-1", hasKind(evs, 1),
		fmt.Sprintf("got %d events, kinds missing 1", len(evs)))
	check("kind-less author REQ does NOT leak the 9011 binding",
		!hasKind(evs, policy.KindMembershipBinding),
		fmt.Sprintf("LEAK: binding present among %d events", len(evs)))

	fmt.Println()
	fmt.Println("== B. live binary: a spare binding credential is burned (R2c) ==")
	// Same npub re-presents a DIFFERENT, unused credential. Pre-fix the relay short-circuited on
	// "already bound" and left the credential unspent, so it could later bind a fresh npub.
	spare := makeCredential(issuerSK)
	ok, msg = publish(r.ws, bindingEvent(memberSK, spare))
	check("re-bind by an already-bound npub is accepted (idempotent)", ok, "rejected: "+msg)

	freshSK, _ := keypair()
	ok, msg = publish(r.ws, bindingEvent(freshSK, spare))
	check("that spare credential can NO LONGER bind a fresh npub", !ok,
		"BAN-EVASION HOLE: the spare credential bound a second npub")

	fmt.Println()
	fmt.Println("== C. live binary: allowed_kinds omissions are named at startup ==")
	r2 := startRelay(binary, issuerPEM, map[string]any{
		// Deliberately omits 1984 and 30078 among others.
		"allowed_kinds": []int{0, 1, 7},
	})
	time.Sleep(500 * time.Millisecond)
	logs := r2.stderr.String()
	r2.stop()
	check("startup WARNING names the omitted default kinds",
		strings.Contains(logs, "WARNING") && strings.Contains(logs, "1984"),
		"no warning naming 1984 in startup logs:\n"+logs)

	fmt.Println()
	fmt.Println("== D. live binary: a clean config warns about nothing ==")
	check("no spurious allowed_kinds warning on the default config",
		!strings.Contains(r.stderr.String(), "WARNING"),
		"unexpected warning:\n"+r.stderr.String())

	fmt.Println()
	if failures > 0 {
		fmt.Printf("RESULT: %d FAILED\n", failures)
		os.Exit(1)
	}
	fmt.Println("RESULT: ALL LIVE CHECKS PASSED")
}
