// Command issuer is the organizers' offline membership issuer (PLAN.md §3.3).
//
// It holds the RSA issuer private key and blind-signs members' BLINDED tokens — it never
// sees the underlying token, so it cannot link a member to the account they later post
// under. Run it on an offline device. A production organizer app wraps these same two
// operations behind a QR scan/show flow; this CLI is the reference + a usable fallback.
//
//	issuer keygen <dir>                  # writes issuer_private.pem (0600) + issuer_public.pem
//	issuer sign <private.pem> <blindedB64> # prints the base64 blind signature
//
// The public key (issuer_public.pem) goes into the relay config (issuer_public_keys) and
// is bundled into the client. The private key never leaves the offline device.
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"

	"github.com/stiq/relay/internal/membership"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "keygen":
		keygen()
	case "sign":
		signBlinded()
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: issuer keygen <dir> | issuer sign <private.pem> <blindedB64>")
	os.Exit(2)
}

func keygen() {
	if len(os.Args) != 3 {
		usage()
	}
	dir := os.Args[2]
	sk, err := rsa.GenerateKey(rand.Reader, 2048)
	check(err)

	privDER, err := x509.MarshalPKCS8PrivateKey(sk)
	check(err)
	privPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privDER})
	check(os.WriteFile(filepath.Join(dir, "issuer_private.pem"), privPEM, 0o600))

	pubDER, err := x509.MarshalPKIXPublicKey(&sk.PublicKey)
	check(err)
	pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER})
	check(os.WriteFile(filepath.Join(dir, "issuer_public.pem"), pubPEM, 0o644))

	fmt.Printf("wrote issuer_private.pem (keep offline) and issuer_public.pem in %s\n", dir)
}

func signBlinded() {
	if len(os.Args) != 4 {
		usage()
	}
	sk := loadPrivateKey(os.Args[2])
	blinded, err := base64.StdEncoding.DecodeString(os.Args[3])
	check(err)

	sig, err := membership.NewIssuer(sk).BlindSign(blinded)
	check(err)
	fmt.Println(base64.StdEncoding.EncodeToString(sig))
}

func loadPrivateKey(path string) *rsa.PrivateKey {
	data, err := os.ReadFile(path)
	check(err)
	block, _ := pem.Decode(data)
	if block == nil {
		fmt.Fprintln(os.Stderr, "issuer private key: not valid PEM")
		os.Exit(1)
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	check(err)
	sk, ok := key.(*rsa.PrivateKey)
	if !ok {
		fmt.Fprintln(os.Stderr, "issuer private key: not an RSA key")
		os.Exit(1)
	}
	return sk
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
