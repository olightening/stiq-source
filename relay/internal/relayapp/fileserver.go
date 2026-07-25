package relayapp

import (
	"net/http"
	"os"
	"strings"
)

// FDroidHandler returns an http.Handler that statically serves the F-Droid-format update
// repository rooted at dir, together with ok=true, when dir names a readable directory. When
// dir=="" (the default; config field fdroid_repo_dir unset) or dir is missing / not a directory,
// it returns (nil,false) so main.go can skip registering the /fdroid/ route entirely — the T9
// in-app-update feature ships DARK and the relay's routing is byte-identical until an operator
// sets fdroid_repo_dir (a /fdroid/ GET then falls through to khatru's 404).
//
// The relay stays AUTHOR-BLIND here: this handler only streams file bytes and performs ZERO
// content inspection. The update's authenticity is enforced entirely CLIENT-side (a signed
// index-v1.jar verified against a pinned repo cert, plus APK same-signer + versionCode checks),
// so the relay is granted no trust over the repo — it is a dumb static byte pump on the existing
// loopback listener.
//
// fdroid_repo_dir is a RESTART-ONLY field (same class as data_dir): it is read once at boot in
// main.go and is intentionally NOT part of the SIGHUP hot-reload set, so changing it requires a
// relay restart.
func FDroidHandler(dir string) (http.Handler, bool) {
	if dir == "" {
		return nil, false
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return nil, false
	}
	fs := http.FileServer(http.Dir(dir))
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Read-only surface: the repo is static, so only GET/HEAD are meaningful. Anything else
		// is a 405 (never let a client mutate anything through this route).
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// Defense-in-depth: http.FileServer already cleans the path and refuses escapes, but reject
		// any request still carrying a ".." segment outright so a traversal attempt can never reach
		// the filesystem layer. (When mounted via http.StripPrefix on the real mux, ServeMux also
		// pre-cleans, so this only fires for a hand-crafted raw path.)
		if strings.Contains(r.URL.Path, "..") {
			http.NotFound(w, r)
			return
		}
		// The index/APK bytes are integrity-checked by the client (signed index-v1.jar + pinned
		// cert), so tell every cache never to store them — an update check must always see fresh
		// bytes, and nothing here should linger in an intermediary.
		w.Header().Set("Cache-Control", "no-store")
		// Emit a neutral Content-Type ONLY if the FileServer leaves it empty, so we never send an
		// empty Content-Type (some proxies choke on it). http.ServeContent normally sets one (via
		// extension lookup / sniffing), so this fallback only fires on the rare path where it can't.
		fs.ServeHTTP(&contentTypeFallback{ResponseWriter: w, fallback: "application/octet-stream"}, r)
	})
	return h, true
}

// contentTypeFallback wraps an http.ResponseWriter to set a default Content-Type at WriteHeader
// time only when the wrapped handler didn't set one. http.FileServer normally sets Content-Type
// before writing the header, so this leaves the common path untouched and only supplies a neutral
// default for the rare file it can't classify.
type contentTypeFallback struct {
	http.ResponseWriter
	fallback    string
	wroteHeader bool
}

func (c *contentTypeFallback) WriteHeader(code int) {
	if !c.wroteHeader {
		if c.Header().Get("Content-Type") == "" {
			c.Header().Set("Content-Type", c.fallback)
		}
		c.wroteHeader = true
	}
	c.ResponseWriter.WriteHeader(code)
}

func (c *contentTypeFallback) Write(b []byte) (int, error) {
	if !c.wroteHeader {
		c.WriteHeader(http.StatusOK)
	}
	return c.ResponseWriter.Write(b)
}
