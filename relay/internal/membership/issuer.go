package membership

import (
	"crypto/rand"
	"crypto/rsa"
	"io"

	"github.com/cloudflare/circl/blindsign/blindrsa"
)

// Issuer is the organizer side: it holds the RSA private key and blind-signs members'
// blinded tokens WITHOUT seeing the token. It runs offline (PLAN.md §3.3 / issuer tool).
type Issuer struct {
	signer blindrsa.Signer
}

func NewIssuer(sk *rsa.PrivateKey) *Issuer {
	return &Issuer{signer: blindrsa.NewSigner(sk)}
}

// BlindSign signs a blinded token. The issuer never learns the underlying token.
func (i *Issuer) BlindSign(blindedMsg []byte) ([]byte, error) {
	return i.signer.BlindSign(blindedMsg)
}

// RequestCredential runs the full client side of RFC 9474 against a blind-signing
// function. It is the reference implementation the TS client mirrors, and is used in
// tests to exercise the real end-to-end blind flow. `blindSign` stands in for the
// organizer (it only ever sees the blinded message, never the token).
func RequestCredential(
	pub *rsa.PublicKey,
	token []byte,
	blindSign func(blindedMsg []byte) ([]byte, error),
) (Credential, error) {
	return requestCredential(rand.Reader, pub, token, blindSign)
}

func requestCredential(
	random io.Reader,
	pub *rsa.PublicKey,
	token []byte,
	blindSign func(blindedMsg []byte) ([]byte, error),
) (Credential, error) {
	client, err := blindrsa.NewClient(Variant, pub)
	if err != nil {
		return Credential{}, err
	}
	prepared, err := client.Prepare(random, token)
	if err != nil {
		return Credential{}, err
	}
	blindedMsg, state, err := client.Blind(random, prepared)
	if err != nil {
		return Credential{}, err
	}
	blindedSig, err := blindSign(blindedMsg)
	if err != nil {
		return Credential{}, err
	}
	sig, err := client.Finalize(state, blindedSig)
	if err != nil {
		return Credential{}, err
	}
	return Credential{Token: prepared, Signature: sig}, nil
}
