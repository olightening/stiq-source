package relayapp

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// newRepoDir builds a temp F-Droid-style layout (dir/repo/index-v1.jar) and returns the repo root
// plus the file's bytes.
func newRepoDir(t *testing.T) (dir string, want []byte) {
	t.Helper()
	dir = t.TempDir()
	repo := filepath.Join(dir, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	want = []byte("PK\x03\x04 fake index-v1.jar bytes")
	if err := os.WriteFile(filepath.Join(repo, "index-v1.jar"), want, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir, want
}

func TestFDroidHandlerDisabledWhenUnset(t *testing.T) {
	// Empty dir ⇒ disabled (ships dark).
	if h, ok := FDroidHandler(""); ok || h != nil {
		t.Fatalf(`FDroidHandler("") = (%v,%v); want (nil,false)`, h, ok)
	}
	// A path that does not exist ⇒ disabled.
	if h, ok := FDroidHandler(filepath.Join(t.TempDir(), "nope")); ok || h != nil {
		t.Fatalf("FDroidHandler(missing) = (%v,%v); want (nil,false)", h, ok)
	}
	// A regular file (not a directory) ⇒ disabled.
	f := filepath.Join(t.TempDir(), "afile")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if h, ok := FDroidHandler(f); ok || h != nil {
		t.Fatalf("FDroidHandler(file) = (%v,%v); want (nil,false)", h, ok)
	}
}

func TestFDroidHandlerServesFile(t *testing.T) {
	dir, want := newRepoDir(t)
	h, ok := FDroidHandler(dir)
	if !ok {
		t.Fatal("FDroidHandler(dir) ok=false; want true")
	}
	srv := httptest.NewServer(h)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/repo/index-v1.jar")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d; want 200", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q; want no-store", cc)
	}
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("body = %q; want %q", got, want)
	}

	// A missing file under the repo 404s (and still stays inside the served dir).
	resp2, err := http.Get(srv.URL + "/repo/missing.jar")
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("missing-file status = %d; want 404", resp2.StatusCode)
	}
}

func TestFDroidHandlerRejectsNonGet(t *testing.T) {
	dir, _ := newRepoDir(t)
	h, _ := FDroidHandler(dir)
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(m, "/repo/index-v1.jar", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d; want 405", m, rec.Code)
		}
		if allow := rec.Header().Get("Allow"); allow != "GET, HEAD" {
			t.Fatalf("%s Allow = %q; want %q", m, allow, "GET, HEAD")
		}
	}
	// HEAD is permitted (used for update polling) and returns 200.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/repo/index-v1.jar", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD status = %d; want 200", rec.Code)
	}
}

func TestFDroidHandlerRejectsTraversal(t *testing.T) {
	dir, _ := newRepoDir(t)
	h, _ := FDroidHandler(dir)
	// Drive the handler directly with a RAW path so net/http's client/ServeMux path cleaning does
	// not pre-normalize the ".." away — this exercises the handler's own traversal guard.
	for _, p := range []string{"/../etc/passwd", "/repo/../../secret", "/repo/..%2f..%2fx"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "http://relay/", nil)
		req.URL.Path = p
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("traversal %q status = %d; want 404", p, rec.Code)
		}
	}
}
