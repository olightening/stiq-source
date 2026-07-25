package fmd

import (
	"fmt"
	"testing"
)

// dmsPerMemberPerDay mirrors the T18-S2/S3 simulation-harness baseline (base.dmsPerMemberPerDay = 8),
// so the per-REQ message count projected here (totalDms = N * dmsPerMemberPerDay) matches the
// TypeScript sweep and S3's report can fold the two together.
const dmsPerMemberPerDay = 8

// TestFMDSelfConsistency is a light sanity check (not a formal correctness gate): a holder's own
// full-precision detection key must Test true on its own flags, and Test must run the real n-bit
// group work the projection is meant to cost. Without this, a silently broken Test (early false)
// would make the cost projection meaningless.
func TestFMDSelfConsistency(t *testing.T) {
	sk, pk := GenerateKeypair(8)
	fl := GenerateFlag(pk)
	if !Test(sk, len(sk), fl) {
		t.Fatal("holder's own full-precision key did not Test true on its own flag")
	}
}

// BenchmarkTest reports ns/op for a single relay-side Test() at n=4 and n=8 (T18-S5 acceptance:
// `go test -bench . ./internal/research/fmd/...` prints ns/op for both). Keygen + flag are set up
// once outside the timed loop so the benchmark measures Test() alone.
func BenchmarkTest(b *testing.B) {
	for _, n := range []int{4, 8} {
		n := n
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			sk, pk := GenerateKeypair(n)
			fl := GenerateFlag(pk)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				sink = Test(sk, n, fl)
			}
		})
	}
}

// sink defeats dead-code elimination of the benchmarked Test() result.
var sink bool

// TestProjectRelayCost logs the projected per-REQ relay Test() wall-time at community sizes
// N ∈ {100,1000,5000} (msgsPerReq = N * dmsPerMemberPerDay) and the per-Test latency at n=4 and
// n=8 (ns/op) so S3's report can fold in relayTestMs. It asserts only that every projection is a
// positive duration — this is a projection, not a correctness gate.
func TestProjectRelayCost(t *testing.T) {
	const n = 4 // detection precision used for the projection (p = 2^-4)

	// Per-Test latency (step 4: emit ns/op so S3 can fold in relayTestMs).
	for _, pn := range []int{4, 8} {
		perTest := measureTestLatency(pn)
		if perTest <= 0 {
			t.Fatalf("n=%d: per-Test latency must be positive, got %v", pn, perTest)
		}
		t.Logf("per-Test latency n=%d: %d ns/op (%.4f ms)", pn, perTest.Nanoseconds(),
			float64(perTest.Nanoseconds())/1e6)
	}

	for _, N := range []int{100, 1000, 5000} {
		msgsPerReq := N * dmsPerMemberPerDay // totalDms for the community
		d := ProjectRelayCostPerReq(n, msgsPerReq)
		if d <= 0 {
			t.Fatalf("N=%d: projected per-REQ duration must be positive, got %v", N, d)
		}
		t.Logf("N=%d msgsPerReq=%d n=%d -> projected relay Test() wall-time per REQ = %v (%.1f ms)",
			N, msgsPerReq, n, d, float64(d.Microseconds())/1000)
	}
}
