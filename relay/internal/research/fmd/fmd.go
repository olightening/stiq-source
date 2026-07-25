// Package fmd is an ISOLATED research reimplementation of the group operations of a compact
// Fuzzy Message Detection (FMD) scheme (Beck–Len–Miers–Green 2021, §5), used ONLY to PROJECT the
// relay-side per-message Test() cost if FMD were ever server-evaluated (T18-S5). It exists so the
// no-server-now decision (T18) can be informed by a concrete secp256k1/hash cost model.
//
// It is deliberately parked under internal/research and is NEVER imported by relayapp.New, the
// khatru wiring, or any admission / RejectFilter path — the relay does not evaluate FMD. Building
// or running this package changes nothing about how the relay admits events. See T18 §"NO new
// relay capability or server handler".
//
// COST-MODEL ASSUMPTIONS (this is a projection, not a shipped or audited construction):
//   - The group is secp256k1 via the same library the relay already vendors through go-nostr
//     (github.com/btcsuite/btcd/btcec/v2, aliased secp256k1), so the scalar-mult / point-add /
//     sha256 costs are representative of a real Go relay build.
//   - It mirrors the T18-S1 TypeScript compact scheme so the per-Test work matches: reconstruct
//     W = g^m · u^y, then n bit-checks, each doing one scalar-mult u^{x_i} + one sha256.
//   - Only Keygen / Flag / Test are implemented; there is no wire serialization (a cost benchmark
//     needs none), and no constant-time / side-channel hardening (irrelevant to a latency model).
package fmd

import (
	"crypto/rand"
	"crypto/sha256"
	"math/big"
	"time"

	secp256k1 "github.com/btcsuite/btcd/btcec/v2"
)

// curveN is the secp256k1 group order (number of points). Scalars live in [1, curveN).
var curveN, _ = new(big.Int).SetString(
	"fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16)

// Flag is an FMD flag: the compact-scheme proof (u, y) plus the packed encrypted key bits. A
// detection key of precision n Tests the first n bits.
//
// NOTE on naming: the flag-GENERATION function is GenerateFlag, not Flag — a Go package cannot
// expose both a type and a function named Flag (they share one identifier namespace).
type Flag struct {
	U    *secp256k1.PublicKey // g^r (33-byte compressed on the wire)
	Y    *big.Int             // (z - m) * r^{-1} mod n
	Bits []byte               // ceil(gamma/8) packed cipher bits c_i
}

// GenerateKeypair draws gamma secret scalars x_i and returns them alongside the public points
// pk[i] = g^{x_i}. gamma is the maximum detection precision (p = 2^-n for n <= gamma).
func GenerateKeypair(gamma int) (sk []*big.Int, pk []*secp256k1.PublicKey) {
	sk = make([]*big.Int, gamma)
	pk = make([]*secp256k1.PublicKey, gamma)
	for i := 0; i < gamma; i++ {
		x := randScalar()
		sk[i] = x
		pk[i] = baseMul(x) // g^{x_i}
	}
	return sk, pk
}

// GenerateFlag produces a flag addressed to the holder of pk. A holder's full-precision detection
// key always Tests true on its own flags; a non-recipient at precision n Tests true with prob 2^-n.
//
// Compact scheme: pick r,z; u=g^r, w=g^z; for each i, k_i = H(u ‖ pk[i]^r ‖ w) & 1, and store the
// encrypted constant bit c_i = k_i ⊕ 1. Then m = H(u ‖ bits) mod n and y = (z - m)·r^{-1} mod n,
// so a tester can reconstruct w = g^z as W = g^m · u^y without knowing z.
func GenerateFlag(pk []*secp256k1.PublicKey) Flag {
	gamma := len(pk)
	r := randScalar()
	z := randScalar()
	u := baseMul(r) // g^r
	w := baseMul(z) // g^z
	uEnc := u.SerializeCompressed()
	wEnc := w.SerializeCompressed()

	bits := make([]byte, (gamma+7)/8)
	for i := 0; i < gamma; i++ {
		hiR := pointMul(pk[i], r) // pk[i]^r = g^{x_i·r}
		ki := hashBit(uEnc, hiR.SerializeCompressed(), wEnc)
		ci := ki ^ 1 // encrypt the constant bit 1
		if ci == 1 {
			bits[i/8] |= 1 << (uint(i) % 8)
		}
	}

	m := hashToScalar(uEnc, bits)
	rInv := new(big.Int).ModInverse(r, curveN)
	y := new(big.Int).Sub(z, m)
	y.Mul(y, rInv)
	y.Mod(y, curveN)
	return Flag{U: u, Y: y, Bits: bits}
}

// Test evaluates the flag against the first n scalars of a detection key. This is the per-message
// cost the relay would pay if FMD were server-evaluated: one base-mult (g^m) + one scalar-mult
// (u^y) + one add to rebuild W, then n bit-checks, each a scalar-mult (u^{x_i}) plus a sha256.
func Test(sk []*big.Int, n int, fl Flag) bool {
	uEnc := fl.U.SerializeCompressed()
	m := hashToScalar(uEnc, fl.Bits)
	// W = g^m · u^y  (== g^z for a well-formed flag).
	w := pointAdd(baseMul(m), pointMul(fl.U, fl.Y))
	wEnc := w.SerializeCompressed()
	for i := 0; i < n; i++ {
		uxi := pointMul(fl.U, sk[i]) // u^{x_i} = g^{r·x_i}
		ki := hashBit(uEnc, uxi.SerializeCompressed(), wEnc)
		ci := (fl.Bits[i/8] >> (uint(i) % 8)) & 1
		if ci^ki != 1 {
			return false
		}
	}
	return true
}

// ProjectRelayCostPerReq projects the wall-clock cost of a relay evaluating FMD Test() over an
// entire REQ's worth of candidate messages: it measures the mean per-Test latency at the given
// detection precision and multiplies by msgsPerReq (the messages the relay would test per REQ,
// e.g. a community's totalDms). It is a projection, not a correctness gate.
func ProjectRelayCostPerReq(nPrecision, msgsPerReq int) time.Duration {
	return measureTestLatency(nPrecision) * time.Duration(msgsPerReq)
}

// measureTestLatency returns the mean wall-clock latency of one Test() at precision n, using a
// representative keypair+flag. Keygen/flag setup is excluded from the timed region.
func measureTestLatency(n int) time.Duration {
	sk, pk := GenerateKeypair(n)
	fl := GenerateFlag(pk)
	_ = Test(sk, n, fl) // warm up (fault-in code paths / allocator)
	const iters = 64
	start := time.Now()
	for i := 0; i < iters; i++ {
		_ = Test(sk, n, fl)
	}
	elapsed := time.Since(start)
	if elapsed <= 0 {
		// Guard against a coarse clock reporting zero on a very fast machine so the projection is
		// always strictly positive (the T18-S5 acceptance criterion).
		return 1
	}
	return elapsed / iters
}

// --- group / hash helpers (representative cost, not hardened) ---

// randScalar draws a uniform scalar in [1, curveN).
func randScalar() *big.Int {
	for {
		k, err := rand.Int(rand.Reader, curveN)
		if err != nil {
			panic("fmd: crypto/rand failed: " + err.Error())
		}
		if k.Sign() != 0 {
			return k
		}
	}
}

// scalar converts a big.Int into a secp256k1 ModNScalar (reduced mod n).
func scalar(k *big.Int) *secp256k1.ModNScalar {
	var buf [32]byte
	new(big.Int).Mod(k, curveN).FillBytes(buf[:])
	var s secp256k1.ModNScalar
	s.SetBytes(&buf)
	return &s
}

// baseMul returns g^k.
func baseMul(k *big.Int) *secp256k1.PublicKey {
	var r secp256k1.JacobianPoint
	secp256k1.ScalarBaseMultNonConst(scalar(k), &r)
	r.ToAffine()
	return secp256k1.NewPublicKey(&r.X, &r.Y)
}

// pointMul returns p^k.
func pointMul(p *secp256k1.PublicKey, k *big.Int) *secp256k1.PublicKey {
	var pj, r secp256k1.JacobianPoint
	p.AsJacobian(&pj)
	secp256k1.ScalarMultNonConst(scalar(k), &pj, &r)
	r.ToAffine()
	return secp256k1.NewPublicKey(&r.X, &r.Y)
}

// pointAdd returns a + b.
func pointAdd(a, b *secp256k1.PublicKey) *secp256k1.PublicKey {
	var aj, bj, r secp256k1.JacobianPoint
	a.AsJacobian(&aj)
	b.AsJacobian(&bj)
	secp256k1.AddNonConst(&aj, &bj, &r)
	r.ToAffine()
	return secp256k1.NewPublicKey(&r.X, &r.Y)
}

// hashBit returns the low bit of sha256(parts...).
func hashBit(parts ...[]byte) byte {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	sum := h.Sum(nil)
	return sum[0] & 1
}

// hashToScalar returns sha256(parts...) reduced mod curveN.
func hashToScalar(parts ...[]byte) *big.Int {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	sum := h.Sum(nil)
	return new(big.Int).Mod(new(big.Int).SetBytes(sum), curveN)
}
