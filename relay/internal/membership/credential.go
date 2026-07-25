// Package membership implements anonymous, unlinkable membership credentials
// (PLAN.md §3.3, §4.3) using RFC 9474 RSA blind signatures via cloudflare/circl.
//
// A member's app generates its own Nostr key on-device. Separately it obtains a
// credential: a blind signature from an organizer ("issuer") over a random token the
// issuer never sees. Once unblinded, the credential is a normal RSA signature over the
// token, verifiable by anyone holding the issuer public key — but unlinkable to the
// issuance session. The relay verifies credentials here; it never learns who a member is.
package membership

import (
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"

	"github.com/cloudflare/circl/blindsign/blindrsa"
)

// Variant is the RFC 9474 variant used throughout. Deterministic means Prepare() leaves
// the token unchanged, so the relay can verify (token, signature) directly.
const Variant = blindrsa.SHA384PSSDeterministic

// Credential is what a member presents to bind their npub: a token and the issuer's
// (unblinded) signature over it.
type Credential struct {
	Token     []byte
	Signature []byte
}

// TokenID is a stable identifier for the spent-token set (the raw token is never logged).
func TokenID(token []byte) string {
	sum := sha256.Sum256(token)
	return hex.EncodeToString(sum[:])
}

// Verify reports whether the credential carries a valid issuer signature.
func Verify(pub *rsa.PublicKey, cred Credential) bool {
	verifier, err := blindrsa.NewVerifier(Variant, pub)
	if err != nil {
		return false
	}
	return verifier.Verify(cred.Token, cred.Signature) == nil
}

// VerifyAny reports whether the credential is valid under any configured issuer key
// (supports issuer-key rotation, PLAN.md §8).
func VerifyAny(pubs []*rsa.PublicKey, cred Credential) bool {
	for _, pub := range pubs {
		if Verify(pub, cred) {
			return true
		}
	}
	return false
}
