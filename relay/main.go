// Command stiq-relay is a whitelisted Nostr relay (PLAN.md Steps 2-3).
//
// The relay binds to a loopback interface only and speaks plain WebSocket. It is meant to
// be fronted by a Tor v3 hidden service that forwards onion traffic to this local port
// (see deploy/). The relay process never needs to know about Tor.
//
// Zero logging (PLAN.md §3.2): by default the relay writes no connection/address logs.
// Set STIQ_RELAY_DEBUG_LOG=1 to surface startup diagnostics on stderr during development.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/pprof"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/stiq/relay/internal/config"
	"github.com/stiq/relay/internal/relayapp"
	"github.com/stiq/relay/internal/safebrowsing"
)

func main() {
	path := os.Getenv("STIQ_RELAY_CONFIG")
	if path == "" {
		path = "config.json"
	}

	cfg, err := config.Load(path)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	// Fail closed: without an issuer key the relay cannot verify membership, so it would
	// be open. Refuse to start.
	if len(cfg.IssuerPublicKeys) == 0 {
		log.Fatal("config: issuer_public_keys is empty; refusing to start an unverifiable relay")
	}
	// Fail closed: never bind a public interface. The relay is reachable only via Tor.
	if os.Getenv("STIQ_RELAY_ALLOW_PUBLIC_BIND") != "1" {
		if err := config.LoopbackOnly(cfg.Listen); err != nil {
			log.Fatalf("config: %v (set STIQ_RELAY_ALLOW_PUBLIC_BIND=1 only for isolated testing)", err)
		}
	}
	if err := startDiagnosticsServer(os.Getenv("STIQ_RELAY_DIAGNOSTICS_ADDR")); err != nil {
		log.Fatalf("diagnostics: %v", err)
	}

	relay, closeStore, reloader, err := relayapp.New(cfg)
	if err != nil {
		log.Fatalf("relay: %v", err)
	}

	if os.Getenv("STIQ_RELAY_DEBUG_LOG") == "1" {
		storage := "in-memory (ephemeral)"
		if cfg.DataDir != "" {
			storage = cfg.DataDir
		}
		log.Printf("stiq-relay listening on %s (loopback only; front with Tor)", cfg.Listen)
		log.Printf("issuer keys: %d; kinds %v; storage: %s",
			len(cfg.IssuerPublicKeys), cfg.AllowedKinds, storage)
	}

	// SIGHUP hot-reload: re-reads config.json and atomically swaps the mutable fields.
	//
	// Reloaded via SIGHUP (send `kill -HUP <pid>` or `systemctl reload stiq-relay`):
	//   - organizer_pubkeys      — updates the organizer exemption set + ConfigHolder
	//   - private_group_read_auth — flips NIP-29 private-group read enforcement on/off; ON requires
	//     clients to speak NIP-42 AUTH (none currently do), so the relay logs a loud warning on every
	//     reload where this is true (see relayapp.warnIfPrivateGroupReadAuthEnabled)
	//
	// Reloaded live (no restart/SIGHUP needed — organizer republishes kind-30078 events):
	//   - rate limits         — per-user daily/weekly/monthly caps, global DM cap
	//   - tag_policy          — community tag set + member-authored-tag permission
	//   - allow_voice         — whether NIP-A0 voice messages (kinds 1222/1244) are accepted
	//   - moderators          — the mod roster (used for rate-limit exemptions)
	//
	// NOT reloadable (require process restart):
	//   - listen              — would require rebinding the OS socket
	//   - issuer_public_keys  — credential verification keys; swapping mid-stream is unsafe
	//   - data_dir / membership_file — storage paths; reopen would lose consistency
	//   - pow_difficulty / enroll_pow — baked into Membership at construction time
	//   - allowed_kinds       — baked into Membership at construction time
	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGHUP)
		for range ch {
			newCfg, err := config.Load(path)
			if err != nil {
				log.Printf("sighup: config reload failed: %v (keeping current config)", err)
				continue
			}
			reloader.Apply(newCfg)
			log.Printf("sighup: config reloaded (organizer_pubkeys=%d)", len(newCfg.OrganizerPubkeys))
		}
	}()

	mux := http.NewServeMux()
	// /health — loopback-only liveness check for systemd/monitoring; no auth needed since
	// the listener is on 127.0.0.1 only (enforced above by LoopbackOnly).
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintln(w, "ok")
	})
	// Safe Browsing reputation proxy (POST /safebrowsing). ALWAYS registered; it self-disables
	// (503) until an API key is set. The key comes from config.json's safe_browsing_api_key (or the
	// SAFE_BROWSING_API_KEY env var) and forwards 4-byte URL-hash prefixes to Google over Tor's
	// SOCKS port (STIQ_TOR_SOCKS, default 127.0.0.1:9050). A background watcher hot-reloads the key
	// when the organizer dashboard rewrites config.json — no relay restart needed.
	socks := os.Getenv("STIQ_TOR_SOCKS")
	if socks == "" {
		socks = "127.0.0.1:9050"
	}
	sbService := safebrowsing.New(resolveSafeBrowsingKey(cfg), socks)
	mux.Handle("/safebrowsing", sbService)
	go watchSafeBrowsingKey(path, sbService)

	// F-Droid update repo (T9): when fdroid_repo_dir names a readable directory, serve a signed
	// F-Droid-format repository under /fdroid/ from the SAME loopback mux the onion targets — no new
	// listener, no new port. The route is only registered when the dir is present, so the feature
	// ships DARK: with fdroid_repo_dir unset the handler is nil and /fdroid/ falls through to khatru
	// (a 404), byte-identical to before. fdroid_repo_dir is RESTART-ONLY — it is read here once at
	// boot and is intentionally NOT wired into the SIGHUP Reloader.Apply hot-path (same class as
	// data_dir). The relay stays author-blind (streams bytes, no content inspection); the client
	// verifies the signed index + pinned cert. ServeMux matches the more-specific /fdroid/ prefix
	// before "/", so khatru is unaffected.
	if h, ok := relayapp.FDroidHandler(reloader.Config().FDroidRepoDir); ok {
		mux.Handle("/fdroid/", http.StripPrefix("/fdroid/", h))
	}

	// Everything else (WebSocket upgrades + NIP-11 GET) goes to khatru, except that a NIP-11 GET is
	// intercepted to splice the stiq-capabilities block into the document (see stiqNIP11Handler). The
	// live config is read through reloader.Config() so the advertised capabilities reflect SIGHUP
	// hot-reloads (blind_required / bytes_per_token / organizer_pubkeys / issuer keys).
	mux.Handle("/", stiqNIP11Handler(relay, reloader))

	// Bound the pre-upgrade header-read and idle-keepalive phases so a peer can't pin a goroutine +
	// FD by dribbling headers one byte at a time (slow-loris) from behind Tor with no address to
	// attribute. ReadHeaderTimeout and IdleTimeout do NOT truncate an already-upgraded WebSocket
	// (khatru owns the hijacked conn and applies its own PongWait deadlines), so long-lived relay
	// connections are unaffected. Mirrors the diagnostics server below. (findings #33/#42)
	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// Graceful shutdown on SIGINT/SIGTERM. ListenAndServe blocks and its error path is log.Fatal
	// (which os.Exit's, skipping every deferred cleanup), so a `defer closeStore()` never runs on a
	// real termination signal — the badger event store and spent-set would close uncleanly. Instead we
	// serve in a goroutine and, on a termination signal, drain in-flight requests within a bounded
	// window and then close the store EXPLICITLY. SIGHUP keeps its hot-reload semantics (its own
	// goroutine above); it is intentionally NOT in this set, so a reload never triggers a shutdown.
	serveErr := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			serveErr <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-serveErr:
		// The listener failed to bind/serve — nothing to drain. Close the store, then exit non-zero.
		closeStore()
		log.Fatal(err)
	case sig := <-stop:
		if os.Getenv("STIQ_RELAY_DEBUG_LOG") == "1" {
			log.Printf("stiq-relay shutting down on %s", sig)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("graceful shutdown: %v", err)
		}
		// Close the store on the clean path so badger flushes and releases its locks before we exit.
		closeStore()
	}
}

// stiqNIP11Handler wraps the khatru relay's "/" handler to splice a stiq-capabilities block into the
// NIP-11 document. Only a NIP-11 request (GET with Accept: application/nostr+json) is intercepted;
// every other request — websocket upgrades, plain GET "/", the NIP-86 management path — falls
// straight through to relay.ServeHTTP unchanged, so a generic Nostr client and the current shipped
// client are unaffected. The capabilities are built from the LIVE config (reloader.Config()), so
// they reflect SIGHUP hot-reloads. On any marshaling hiccup we emit the relay's original document
// unchanged (fail open to a valid, if un-augmented, NIP-11 doc) rather than erroring.
func stiqNIP11Handler(relay http.Handler, reloader *relayapp.Reloader) http.Handler {
	nip11, ok := relay.(interface {
		HandleNIP11(http.ResponseWriter, *http.Request)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only intercept a NIP-11 GET (Accept: application/nostr+json). A websocket upgrade carries an
		// Upgrade header and never this Accept; fall it through to khatru untouched, matching khatru's
		// own upgrade-before-Accept precedence so a request carrying both headers is never mis-handled.
		if !ok || r.Method != http.MethodGet || r.Header.Get("Upgrade") != "" || r.Header.Get("Accept") != "application/nostr+json" {
			relay.ServeHTTP(w, r)
			return
		}
		// khatru serves NIP-11 through its CORS middleware (Access-Control-Allow-Origin: *); calling
		// HandleNIP11 directly bypasses that, so re-attach the headers a browser-based generic client
		// needs to read the cross-origin response. (OPTIONS preflights still fall through to khatru.)
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Vary", "Origin")
		// Render khatru's NIP-11 document into a buffer so we can augment it.
		rec := httptest.NewRecorder()
		nip11.HandleNIP11(rec, r)
		body := rec.Body.Bytes()

		var doc map[string]json.RawMessage
		if err := json.Unmarshal(body, &doc); err == nil {
			// Drop the two created_at bounds go-nostr emits as an unconditional 0. This relay
			// enforces no created_at window, and `"created_at_upper_limit":0` read literally says it
			// rejects every event newer than the epoch — see relayapp.PruneNIP11Limitation.
			if lim, ok := doc["limitation"]; ok {
				if pruned, changed := relayapp.PruneNIP11Limitation(lim); changed {
					doc["limitation"] = pruned
				}
			}
			if caps, err := json.Marshal(relayapp.StiqCapabilities(reloader.Config())); err == nil {
				doc["stiq-capabilities"] = caps
				if out, err := json.Marshal(doc); err == nil {
					w.Header().Set("Content-Type", "application/nostr+json")
					w.WriteHeader(rec.Code)
					_, _ = w.Write(out)
					return
				}
			}
		}
		// Fallback: relay the original document verbatim (headers + status + body) if anything above
		// failed, so a NIP-11 request always gets a valid response.
		for k, vs := range rec.Header() {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(body)
	})
}

// diagnosticsMux exposes Go's standard profiling endpoints plus a small JSON runtime snapshot.
// It is served on a separate listener so profiling can never compete for routing with relay traffic.
func diagnosticsMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.HandleFunc("/debug/runtime", func(w http.ResponseWriter, _ *http.Request) {
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			Time       time.Time                   `json:"time"`
			Goroutines int                         `json:"goroutines"`
			Memory     runtime.MemStats            `json:"memory"`
			Relay      relayapp.DiagnosticSnapshot `json:"relay"`
		}{
			Time:       time.Now().UTC(),
			Goroutines: runtime.NumGoroutine(),
			Memory:     mem,
			Relay:      relayapp.Diagnostics(),
		})
	})
	return mux
}

// startDiagnosticsServer enables opt-in production diagnostics. Heap profiles may contain process
// memory (including the in-memory Safe Browsing API key and cached event material), so the endpoint
// is rejected unless it binds to loopback AND is protected by a bearer token. The relay shares its
// host with the organizer dashboard/mailbox, so loopback binding alone is not a trust boundary
// against other local processes — a co-located service could otherwise scrape /debug/pprof/heap.
// The token comes from STIQ_RELAY_DIAGNOSTICS_TOKEN; without it the server refuses to start (fail
// closed) rather than exposing pprof unauthenticated. (finding #70)
func startDiagnosticsServer(addr string) error {
	if addr == "" {
		return nil
	}
	if err := config.LoopbackOnly(addr); err != nil {
		return fmt.Errorf("refusing non-loopback bind %q: %w", addr, err)
	}
	token := os.Getenv("STIQ_RELAY_DIAGNOSTICS_TOKEN")
	if token == "" {
		return fmt.Errorf("refusing to start diagnostics on %q without STIQ_RELAY_DIAGNOSTICS_TOKEN "+
			"(pprof/heap can leak the API key and event material to any local process)", addr)
	}
	// The shipped diagnostics drop-in carries this literal placeholder; a real, unguessable token is
	// required. Refusing it (same fail-closed path as an empty token) stops an operator from leaving
	// the endpoint protected by a secret readable straight out of the repo.
	if token == "REPLACE_WITH_A_LONG_RANDOM_SECRET" {
		return fmt.Errorf("refusing to start diagnostics on %q: STIQ_RELAY_DIAGNOSTICS_TOKEN is still "+
			"the placeholder — set a real random secret (openssl rand -hex 32)", addr)
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler:           requireBearer(token, diagnosticsMux()),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("diagnostics server stopped: %v", err)
		}
	}()
	log.Printf("diagnostics listening on %s (loopback only, token-gated)", addr)
	return nil
}

// requireBearer wraps h so every request must present Authorization: Bearer <token>. The compare is
// constant-time so a co-located process can't recover the token by timing. Applied to the
// diagnostics (pprof) listener even though it is loopback-bound (finding #70).
func requireBearer(token string, h http.Handler) http.Handler {
	want := []byte("Bearer " + token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get("Authorization"))
		if subtle.ConstantTimeCompare(got, want) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// resolveSafeBrowsingKey returns the Safe Browsing API key from config.json, falling back to the
// SAFE_BROWSING_API_KEY env var. Empty means the feature is disabled.
func resolveSafeBrowsingKey(cfg config.Config) string {
	if cfg.SafeBrowsingAPIKey != "" {
		return cfg.SafeBrowsingAPIKey
	}
	return os.Getenv("SAFE_BROWSING_API_KEY")
}

// watchSafeBrowsingKey polls the config file's mtime and hot-swaps the Safe Browsing key when it
// changes, so the organizer dashboard can enable/disable/rotate the key by rewriting config.json
// without a relay restart (the dashboard runs as the same user but is non-root and can't signal us).
func watchSafeBrowsingKey(configPath string, svc *safebrowsing.Service) {
	stat := func() (time.Time, bool) {
		fi, err := os.Stat(configPath)
		if err != nil {
			return time.Time{}, false
		}
		return fi.ModTime(), true
	}
	last, _ := stat()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		mod, ok := stat()
		if !ok || !mod.After(last) {
			continue
		}
		last = mod
		newCfg, err := config.Load(configPath)
		if err != nil {
			continue
		}
		svc.SetKey(resolveSafeBrowsingKey(newCfg))
	}
}
