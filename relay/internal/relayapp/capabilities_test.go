package relayapp

import (
	"bytes"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	secp256k1 "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/nbd-wtf/go-nostr"

	"github.com/stiq/relay/internal/config"
	"github.com/stiq/relay/internal/membership"
	"github.com/stiq/relay/internal/policy"
)

// roundTrip marshals the capabilities map and unmarshals it back into a generic map, exactly as a
// client would see it over the wire (JSON numbers become float64). This asserts the map is valid
// JSON and lets the tests read the advertised shape by key.
func roundTrip(t *testing.T, cfg *config.Config) map[string]any {
	t.Helper()
	b, err := json.Marshal(StiqCapabilities(cfg))
	if err != nil {
		t.Fatalf("marshal capabilities: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal capabilities: %v", err)
	}
	return m
}

func TestStiqCapabilitiesShape(t *testing.T) {
	_, enrollPEM := issuerKeyPEM(t)
	_, postingPEM := issuerKeyPEM(t)

	cfg := &config.Config{
		IssuerPublicKeys:        []string{enrollPEM},
		PostingIssuerPublicKeys: []string{postingPEM},
		// BindingIssuerPublicKeys intentionally empty → binding fingerprints must be [].
		BlindRequired:        true,
		BytesPerToken:        256,
		PrivateGroupReadAuth: true,
		PoWDifficulty:        20,
		// EnrollPoW 0 → effective enroll PoW falls back to PoWDifficulty (20).
		// AllowedKinds empty → falls back to config.DefaultAllowedKinds.
	}

	m := roundTrip(t, cfg)

	if got := m["schema_version"].(float64); int(got) != config.SchemaVersion {
		t.Errorf("schema_version = %v, want %d", got, config.SchemaVersion)
	}

	enforced := m["enforced"].(map[string]any)
	if enforced["blind_required"] != true {
		t.Errorf("enforced.blind_required = %v, want true", enforced["blind_required"])
	}
	if got := enforced["bytes_per_token"].(float64); int(got) != 256 {
		t.Errorf("enforced.bytes_per_token = %v, want 256", got)
	}
	if enforced["private_group_read_auth"] != true {
		t.Errorf("enforced.private_group_read_auth = %v, want true", enforced["private_group_read_auth"])
	}

	pow := m["pow"].(map[string]any)
	if got := pow["enroll"].(float64); int(got) != 20 {
		t.Errorf("pow.enroll = %v, want 20 (fallback to dm)", got)
	}
	if got := pow["dm"].(float64); int(got) != 20 {
		t.Errorf("pow.dm = %v, want 20", got)
	}

	if m["token_domain_sep"] != true {
		t.Errorf("token_domain_sep = %v, want true (posting keys present)", m["token_domain_sep"])
	}

	fps := m["issuer_key_fingerprints"].(map[string]any)
	enroll := fps["enroll"].([]any)
	posting := fps["posting"].([]any)
	binding := fps["binding"].([]any)
	if len(enroll) != 1 {
		t.Fatalf("issuer_key_fingerprints.enroll = %v, want 1 entry", enroll)
	}
	if len(posting) != 1 {
		t.Fatalf("issuer_key_fingerprints.posting = %v, want 1 entry", posting)
	}
	if len(binding) != 0 {
		t.Errorf("issuer_key_fingerprints.binding = %v, want empty", binding)
	}
	if fp := enroll[0].(string); !strings.HasPrefix(fp, "sha256:") {
		t.Errorf("enroll fingerprint %q missing sha256: prefix", fp)
	}
	if fp := posting[0].(string); !strings.HasPrefix(fp, "sha256:") {
		t.Errorf("posting fingerprint %q missing sha256: prefix", fp)
	}

	kinds := m["allowed_kinds"].([]any)
	if len(kinds) != len(config.DefaultAllowedKinds) {
		t.Errorf("allowed_kinds len = %d, want default %d", len(kinds), len(config.DefaultAllowedKinds))
	}

	if got := m["reject_codes_version"].(float64); int(got) != policy.RejectCodesVersion {
		t.Errorf("reject_codes_version = %v, want %d", got, policy.RejectCodesVersion)
	}
}

// TestStiqCapabilitiesEnrollPoWExplicit verifies EnrollPoW wins over PoWDifficulty when set, and
// that an empty posting-key list flips token_domain_sep off (the dark/default state).
func TestStiqCapabilitiesEnrollPoWExplicit(t *testing.T) {
	_, enrollPEM := issuerKeyPEM(t)
	cfg := &config.Config{
		IssuerPublicKeys: []string{enrollPEM},
		PoWDifficulty:    20,
		EnrollPoW:        8,
	}
	m := roundTrip(t, cfg)

	pow := m["pow"].(map[string]any)
	if got := pow["enroll"].(float64); int(got) != 8 {
		t.Errorf("pow.enroll = %v, want 8 (explicit EnrollPoW)", got)
	}
	if m["token_domain_sep"] != false {
		t.Errorf("token_domain_sep = %v, want false (no posting keys)", m["token_domain_sep"])
	}
	fps := m["issuer_key_fingerprints"].(map[string]any)
	if posting := fps["posting"].([]any); len(posting) != 0 {
		t.Errorf("posting fingerprints = %v, want empty", posting)
	}
}

// TestStiqCapabilitiesIssuerKeysCidInvariant asserts issuer_keys.enroll is present, decodes as
// valid base64-encoded SPKI, and that sha256(utf8(issuer_keys.enroll))[:16] reproduces the cid a
// v2 join code would pin (join.ts's enrollKeyMatchesCid / organizer's buildJoinCode both compute
// cid this same way: sha256 over the UTF-8 bytes of the base64 STRING, not the decoded DER). It
// also pins schema_version strictly below the client's CAPS_SCHEMA_PURPOSE_FINGERPRINTS=2 gate
// (client/src/nostr/capabilities.ts), so the unrelated C5 fingerprint-enforcement step never
// silently activates as a side effect of this change.
func TestStiqCapabilitiesIssuerKeysCidInvariant(t *testing.T) {
	_, enrollPEM := issuerKeyPEM(t)
	cfg := &config.Config{
		IssuerPublicKeys: []string{enrollPEM},
		// PostingIssuerPublicKeys and the read list are left empty: posting/read must be "".
	}

	m := roundTrip(t, cfg)

	keys, ok := m["issuer_keys"].(map[string]any)
	if !ok {
		t.Fatalf("stiq-capabilities missing issuer_keys block: %v", m["issuer_keys"])
	}
	enrollB64, ok := keys["enroll"].(string)
	if !ok || enrollB64 == "" {
		t.Fatalf("issuer_keys.enroll = %v, want non-empty base64 string", keys["enroll"])
	}
	if keys["posting"] != "" {
		t.Errorf("issuer_keys.posting = %v, want \"\" (no posting keys configured)", keys["posting"])
	}
	if keys["read"] != "" {
		t.Errorf("issuer_keys.read = %v, want \"\" (no read key list exists yet)", keys["read"])
	}

	// issuer_keys.enroll must decode as valid standard base64...
	der, err := base64.StdEncoding.DecodeString(enrollB64)
	if err != nil {
		t.Fatalf("issuer_keys.enroll is not valid base64: %v", err)
	}
	// ...and the decoded bytes must be a valid SPKI public key (the same DER pem.Decode(enrollPEM)
	// would yield), confirming firstKeyB64 round-trips the organizer's issuer_public.b64 exactly.
	if _, err := x509.ParsePKIXPublicKey(der); err != nil {
		t.Fatalf("issuer_keys.enroll does not decode as SPKI: %v", err)
	}
	block, _ := pem.Decode([]byte(enrollPEM))
	if block == nil {
		t.Fatal("test fixture PEM failed to decode")
	}
	if !bytes.Equal(der, block.Bytes) {
		t.Error("issuer_keys.enroll DER does not match the configured PEM's DER bytes")
	}

	// cid = sha256(utf8(base64_std_DER_SPKI))[:16] — hash the base64 STRING, not the decoded DER.
	sum := sha256.Sum256([]byte(enrollB64))
	cid := hex.EncodeToString(sum[:])[:16]
	if len(cid) != 16 {
		t.Fatalf("derived cid %q, want 16 hex chars", cid)
	}
	// Recomputing from the same enrollB64 must be deterministic (what a client re-deriving cid on
	// a second fetch, or the organizer computing it independently at invite-build time, relies on).
	sum2 := sha256.Sum256([]byte(enrollB64))
	if hex.EncodeToString(sum2[:])[:16] != cid {
		t.Error("cid derivation from issuer_keys.enroll is not deterministic")
	}

	// clientCapsSchemaPurposeFingerprints mirrors CAPS_SCHEMA_PURPOSE_FINGERPRINTS in
	// client/src/nostr/capabilities.ts. This must stay a strict `<`, never `<=` or bumped in
	// lockstep, until the relay and client schemas are deliberately advanced together (see the
	// CRITICAL INVARIANT note in CLIENT_C5_FINGERPRINT_CONTRACT.md).
	const clientCapsSchemaPurposeFingerprints = 2
	if got := m["schema_version"].(float64); int(got) >= clientCapsSchemaPurposeFingerprints {
		t.Errorf("schema_version = %v, want strictly below client's CAPS_SCHEMA_PURPOSE_FINGERPRINTS=%d", got, clientCapsSchemaPurposeFingerprints)
	}
	if config.SchemaVersion >= clientCapsSchemaPurposeFingerprints {
		t.Errorf("config.SchemaVersion = %d, want strictly below client's CAPS_SCHEMA_PURPOSE_FINGERPRINTS=%d", config.SchemaVersion, clientCapsSchemaPurposeFingerprints)
	}
}

// TestStiqCapabilitiesAdvertisesHolderProofRequired asserts the P3 holder-bound-token gate is
// advertised in the enforced block, ships dark (false) by default, and reflects true when set.
func TestStiqCapabilitiesAdvertisesHolderProofRequired(t *testing.T) {
	_, enrollPEM := issuerKeyPEM(t)

	dark := roundTrip(t, &config.Config{IssuerPublicKeys: []string{enrollPEM}})
	enforcedDark := dark["enforced"].(map[string]any)
	if enforcedDark["holder_proof_required"] != false {
		t.Errorf("enforced.holder_proof_required = %v, want false (ships dark)", enforcedDark["holder_proof_required"])
	}

	lit := roundTrip(t, &config.Config{IssuerPublicKeys: []string{enrollPEM}, HolderProofRequired: true})
	enforcedLit := lit["enforced"].(map[string]any)
	if enforcedLit["holder_proof_required"] != true {
		t.Errorf("enforced.holder_proof_required = %v, want true", enforcedLit["holder_proof_required"])
	}
}

// TestRejectCodesVersionPinnedAtFive pins policy.RejectCodesVersion at 5 (v5 added codeBodyTooLong
// for the universal long-body cap on non-article bodies, on top of v4's space-write token gate and
// v3's organizer/group codes). A client switches on this exact number to know the reject-code
// vocabulary it can rely on, so an accidental revert/bump here must fail loudly.
func TestRejectCodesVersionPinnedAtFive(t *testing.T) {
	if policy.RejectCodesVersion != 5 {
		t.Fatalf("policy.RejectCodesVersion = %d, want 5 (v5 body_too_long)", policy.RejectCodesVersion)
	}
}

// TestSpaceTokensRequiredGatedOnKeys (tokens-everywhere) locks in that the advertised
// space_tokens_required is true ONLY when the verifying keys are also configured — a flag without
// space_write_issuer_public_keys can never be satisfied (gateSpaceTokens rejects every token-tagged
// space event), so advertising it would make compliant clients attach tokens that brick every space
// write. Mirrors the media_write_domains key-gating.
func TestSpaceTokensRequiredGatedOnKeys(t *testing.T) {
	_, enrollPEM := issuerKeyPEM(t)
	_, spacePEM := issuerKeyPEM(t)

	// Flag set but NO space keys → advertised false (safe: clients won't attach).
	flagOnly := roundTrip(t, &config.Config{IssuerPublicKeys: []string{enrollPEM}, SpaceTokensRequired: true})
	if flagOnly["enforced"].(map[string]any)["space_tokens_required"] != false {
		t.Error("space_tokens_required must advertise false when space_write_issuer_public_keys is empty")
	}

	// Flag set AND space keys present → advertised true.
	both := roundTrip(t, &config.Config{
		IssuerPublicKeys:           []string{enrollPEM},
		SpaceWriteIssuerPublicKeys: []string{spacePEM},
		SpaceTokensRequired:        true,
	})
	if both["enforced"].(map[string]any)["space_tokens_required"] != true {
		t.Error("space_tokens_required must advertise true when flag AND keys are both set")
	}

	// Keys present but flag off → advertised false (dark).
	keysOnly := roundTrip(t, &config.Config{
		IssuerPublicKeys:           []string{enrollPEM},
		SpaceWriteIssuerPublicKeys: []string{spacePEM},
	})
	if keysOnly["enforced"].(map[string]any)["space_tokens_required"] != false {
		t.Error("space_tokens_required must advertise false while the flag is off")
	}
}

// TestMediaWriteDomainsGatedOnEnabled (tokens-everywhere / Phase 4d) locks in that
// media_write_domains is advertised ONLY when MediaTokensEnabled is true AND the domain's keys are
// configured — so the dashboard-flippable bool is the ON/OFF, and the keys (hot-reloadable in their
// own right since T1.1) stay loaded and dark until the operator enables the advertisement.
func TestMediaWriteDomainsGatedOnEnabled(t *testing.T) {
	_, enrollPEM := issuerKeyPEM(t)
	_, picPEM := issuerKeyPEM(t)
	_, audPEM := issuerKeyPEM(t)

	// Keys present but NOT enabled → field omitted entirely (dark).
	keysOnly := roundTrip(t, &config.Config{
		IssuerPublicKeys:             []string{enrollPEM},
		PictureWriteIssuerPublicKeys: []string{picPEM},
		AudioWriteIssuerPublicKeys:   []string{audPEM},
	})
	if _, present := keysOnly["media_write_domains"]; present {
		t.Error("media_write_domains must be omitted while MediaTokensEnabled is false, even with keys")
	}

	// Enabled but NO keys → omitted (nothing to advertise / verify).
	enabledNoKeys := roundTrip(t, &config.Config{IssuerPublicKeys: []string{enrollPEM}, MediaTokensEnabled: true})
	if _, present := enabledNoKeys["media_write_domains"]; present {
		t.Error("media_write_domains must be omitted when enabled but no media keys are configured")
	}

	// Enabled AND both keys present → both domains advertised.
	both := roundTrip(t, &config.Config{
		IssuerPublicKeys:             []string{enrollPEM},
		PictureWriteIssuerPublicKeys: []string{picPEM},
		AudioWriteIssuerPublicKeys:   []string{audPEM},
		MediaTokensEnabled:           true,
	})
	domains, ok := both["media_write_domains"].([]any)
	if !ok || len(domains) != 2 {
		t.Fatalf("media_write_domains must list both domains when enabled + keyed, got %v", both["media_write_domains"])
	}
	seen := map[string]bool{}
	for _, d := range domains {
		seen[d.(string)] = true
	}
	if !seen["picture"] || !seen["audio"] {
		t.Errorf("expected picture+audio, got %v", domains)
	}

	// Enabled with only the picture key → only picture advertised.
	picOnly := roundTrip(t, &config.Config{
		IssuerPublicKeys:             []string{enrollPEM},
		PictureWriteIssuerPublicKeys: []string{picPEM},
		MediaTokensEnabled:           true,
	})
	domains2, _ := picOnly["media_write_domains"].([]any)
	if len(domains2) != 1 || domains2[0].(string) != "picture" {
		t.Errorf("expected only picture, got %v", picOnly["media_write_domains"])
	}
}

// TestMediaFingerprintsUnconditionalUnlikeMediaWriteDomains (T1.3, enables F6) locks in that
// issuer_key_fingerprints.picture/audio are advertised UNCONDITIONALLY from configured keys — unlike
// media_write_domains (TestMediaWriteDomainsGatedOnEnabled above), which additionally requires
// MediaTokensEnabled. A client's drift-detector needs the true enforced-key fingerprint regardless
// of whether the operator has also flipped the advertisement bool, so these two gates must stay
// independent.
func TestMediaFingerprintsUnconditionalUnlikeMediaWriteDomains(t *testing.T) {
	_, enrollPEM := issuerKeyPEM(t)
	_, picPEM := issuerKeyPEM(t)
	_, audPEM := issuerKeyPEM(t)

	// Keys present but MediaTokensEnabled=false: media_write_domains stays omitted (existing
	// behaviour), but the fingerprints must STILL be advertised.
	m := roundTrip(t, &config.Config{
		IssuerPublicKeys:             []string{enrollPEM},
		PictureWriteIssuerPublicKeys: []string{picPEM},
		AudioWriteIssuerPublicKeys:   []string{audPEM},
	})
	if _, present := m["media_write_domains"]; present {
		t.Error("media_write_domains must stay omitted while MediaTokensEnabled is false")
	}
	fps := m["issuer_key_fingerprints"].(map[string]any)
	picture, ok := fps["picture"].([]any)
	if !ok || len(picture) != 1 {
		t.Fatalf("issuer_key_fingerprints.picture = %v, want 1 entry even with media_write_domains dark", fps["picture"])
	}
	audio, ok := fps["audio"].([]any)
	if !ok || len(audio) != 1 {
		t.Fatalf("issuer_key_fingerprints.audio = %v, want 1 entry even with media_write_domains dark", fps["audio"])
	}
	if fp := picture[0].(string); !strings.HasPrefix(fp, "sha256:") {
		t.Errorf("picture fingerprint %q missing sha256: prefix", fp)
	}
	if fp := audio[0].(string); !strings.HasPrefix(fp, "sha256:") {
		t.Errorf("audio fingerprint %q missing sha256: prefix", fp)
	}

	// No media keys configured at all → both fingerprint arrays are empty, non-nil.
	dark := roundTrip(t, &config.Config{IssuerPublicKeys: []string{enrollPEM}})
	darkFPs := dark["issuer_key_fingerprints"].(map[string]any)
	if p := darkFPs["picture"].([]any); len(p) != 0 {
		t.Errorf("issuer_key_fingerprints.picture = %v, want empty with no picture keys configured", p)
	}
	if a := darkFPs["audio"].([]any); len(a) != 0 {
		t.Errorf("issuer_key_fingerprints.audio = %v, want empty with no audio keys configured", a)
	}
}

// rsaKeyFingerprints computes the "sha256:<hex>" fingerprint of each ENFORCED *rsa.PublicKey the
// same way capabilities.go's keyFingerprints hashes a PEM-configured key: sha256 over the
// STANDARD-BASE64 ENCODING of the DER SPKI bytes (see CLIENT_C5_FINGERPRINT_CONTRACT.md), not the
// raw DER bytes. x509.MarshalPKIXPublicKey re-derives the identical DER encoding
// config.ParseIssuerKeys parsed it FROM, so this reproduces keyFingerprints' output byte-for-byte
// for the same key.
func rsaKeyFingerprints(t *testing.T, keys []*rsa.PublicKey) []string {
	t.Helper()
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		der, err := x509.MarshalPKIXPublicKey(k)
		if err != nil {
			t.Fatalf("marshal enforced key: %v", err)
		}
		b64 := base64.StdEncoding.EncodeToString(der)
		sum := sha256.Sum256([]byte(b64))
		out = append(out, "sha256:"+hex.EncodeToString(sum[:]))
	}
	return out
}

// stringsFromAny converts a decoded-JSON []any (each element expected to be a string) into []string,
// failing loudly on any non-string entry rather than panicking on the type assertion.
func stringsFromAny(t *testing.T, raw []any) []string {
	t.Helper()
	out := make([]string, 0, len(raw))
	for _, r := range raw {
		s, ok := r.(string)
		if !ok {
			t.Fatalf("expected a string fingerprint entry, got %v (%T)", r, r)
		}
		out = append(out, s)
	}
	return out
}

func toStringSet(strs []string) map[string]bool {
	set := make(map[string]bool, len(strs))
	for _, s := range strs {
		set[s] = true
	}
	return set
}

// assertAdvertisedMatchesEnforced is the T1.2 core assertion: the ADVERTISED fingerprint array for
// one domain (as read off the live capabilities map) must be the exact same SET as the fingerprints
// of the key set Membership actually ENFORCES for that domain. A mismatch means either a stale
// advertisement (enforcement rotated, the advertised NIP-11 doc didn't) or a stale enforcement
// (config/advertisement rotated, enforcement didn't) — the exact advertise-vs-enforce divergence
// that bricked space-write (F5) and left the client's drift-detector blind (F6).
func assertAdvertisedMatchesEnforced(t *testing.T, phase, domain string, advertisedAny []any, enforced []*rsa.PublicKey) {
	t.Helper()
	advertised := stringsFromAny(t, advertisedAny)
	enforcedFPs := rsaKeyFingerprints(t, enforced)
	want, got := toStringSet(enforcedFPs), toStringSet(advertised)
	if len(want) != len(got) {
		t.Fatalf("%s: issuer_key_fingerprints.%s: advertised=%v (n=%d) but Membership enforces fingerprints=%v (n=%d)",
			phase, domain, advertised, len(got), enforcedFPs, len(want))
	}
	for fp := range want {
		if !got[fp] {
			t.Errorf("%s: issuer_key_fingerprints.%s does not advertise enforced fingerprint %s (advertised=%v)", phase, domain, fp, advertised)
		}
	}
}

// assertFingerprintRotated fails unless oldKey's fingerprint is ABSENT from the currently-enforced
// key set — the belt-and-suspenders half of the T1.1/T1.2 reload proof: without it, a
// Reloader.Apply that silently no-ops the reload would still pass assertAdvertisedMatchesEnforced
// (advertised and enforced would agree with each other, just both wrongly still holding the OLD
// key), so this additionally pins that the value actually changed.
func assertFingerprintRotated(t *testing.T, domain string, oldKey *rsa.PublicKey, enforcedNow []*rsa.PublicKey) {
	t.Helper()
	oldFP := rsaKeyFingerprints(t, []*rsa.PublicKey{oldKey})[0]
	for _, fp := range rsaKeyFingerprints(t, enforcedNow) {
		if fp == oldFP {
			t.Fatalf("%s issuer fingerprint unchanged after SIGHUP rotation — the reload did not actually take effect", domain)
		}
	}
}

// TestCapabilitiesAdvertisedMatchesEnforcedAcrossDomains is the T1.2 regression guard for F5/F6:
// for every relay-ENFORCED domain (enroll, posting, binding, space_write, picture, audio), the
// NIP-11 issuer_key_fingerprints.<domain> the relay ADVERTISES must equal the fingerprint SET of the
// key set Membership actually ENFORCES — both immediately after construction and after a SIGHUP
// Reloader.Apply reload. Before T1.1, posting/binding/picture/audio were "construction-only": a
// SIGHUP that rotated their config-file keys updated the ADVERTISED fingerprint (capabilities reads
// the live cfg Reloader.Config() returns) while leaving ENFORCEMENT on the stale key in memory —
// exactly the advertise-vs-enforce divergence that bricked space-write (F5). This test fails loudly
// if any domain regresses to that shape.
//
// `read` is intentionally NOT one of the domains asserted here: it is organizer-verified, not
// relay-verified (the relay never touches read tokens), so its fingerprint provenance is deferred to
// Phase 5/T5.2 per the plan's Appendix A / NB-6.
func TestCapabilitiesAdvertisedMatchesEnforcedAcrossDomains(t *testing.T) {
	_, enrollPEM := issuerKeyPEM(t)
	postingSK, postingPEM := issuerKeyPEM(t)
	bindingSK, bindingPEM := issuerKeyPEM(t)
	spaceSK, spacePEM := issuerKeyPEM(t)
	pictureSK, picturePEM := issuerKeyPEM(t)
	audioSK, audioPEM := issuerKeyPEM(t)

	cfg := config.Config{
		Listen:                       "127.0.0.1:0",
		IssuerPublicKeys:             []string{enrollPEM},
		PostingIssuerPublicKeys:      []string{postingPEM},
		BindingIssuerPublicKeys:      []string{bindingPEM},
		SpaceWriteIssuerPublicKeys:   []string{spacePEM},
		PictureWriteIssuerPublicKeys: []string{picturePEM},
		AudioWriteIssuerPublicKeys:   []string{audioPEM},
		AllowedKinds:                 config.DefaultAllowedKinds,
	}
	_, closeStore, reloader, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)

	checkAllDomains := func(phase string) {
		t.Helper()
		fps, ok := roundTrip(t, reloader.Config())["issuer_key_fingerprints"].(map[string]any)
		if !ok {
			t.Fatalf("%s: stiq-capabilities missing issuer_key_fingerprints", phase)
		}
		assertAdvertisedMatchesEnforced(t, phase, "enroll", fps["enroll"].([]any), reloader.m.EnrollIssuers())
		assertAdvertisedMatchesEnforced(t, phase, "posting", fps["posting"].([]any), reloader.m.PostingIssuers())
		assertAdvertisedMatchesEnforced(t, phase, "binding", fps["binding"].([]any), reloader.m.BindingIssuers())
		assertAdvertisedMatchesEnforced(t, phase, "space_write", fps["space_write"].([]any), reloader.m.SpaceWriteIssuers())
		assertAdvertisedMatchesEnforced(t, phase, "picture", fps["picture"].([]any), reloader.m.PictureWriteIssuers())
		assertAdvertisedMatchesEnforced(t, phase, "audio", fps["audio"].([]any), reloader.m.AudioWriteIssuers())
	}

	// Phase 1: immediately at construction.
	checkAllDomains("construction")

	// Phase 2: SIGHUP with ROTATED keys for every hot-reloadable domain. `enroll` is deliberately
	// left UNCHANGED — the general issuer_public_keys are restart-only / out of T1.1's scope (see
	// Membership.EnrollIssuers' doc) — so its construction-time equality trivially continues to
	// hold; a real config.Load()-driven SIGHUP always re-supplies the same on-disk value unless an
	// operator deliberately edits it (an explicitly unsupported, restart-required change).
	_, postingPEM2 := issuerKeyPEM(t)
	_, bindingPEM2 := issuerKeyPEM(t)
	_, spacePEM2 := issuerKeyPEM(t)
	_, picturePEM2 := issuerKeyPEM(t)
	_, audioPEM2 := issuerKeyPEM(t)
	reloaded := cfg
	reloaded.PostingIssuerPublicKeys = []string{postingPEM2}
	reloaded.BindingIssuerPublicKeys = []string{bindingPEM2}
	reloaded.SpaceWriteIssuerPublicKeys = []string{spacePEM2}
	reloaded.PictureWriteIssuerPublicKeys = []string{picturePEM2}
	reloaded.AudioWriteIssuerPublicKeys = []string{audioPEM2}
	reloader.Apply(reloaded)

	checkAllDomains("post-SIGHUP")

	// Belt-and-suspenders: prove the reload ACTUALLY rotated every hot-reloadable domain's enforced
	// key (not a vacuous no-op that would still pass checkAllDomains if Apply silently did nothing).
	assertFingerprintRotated(t, "posting", &postingSK.PublicKey, reloader.m.PostingIssuers())
	assertFingerprintRotated(t, "binding", &bindingSK.PublicKey, reloader.m.BindingIssuers())
	assertFingerprintRotated(t, "space_write", &spaceSK.PublicKey, reloader.m.SpaceWriteIssuers())
	assertFingerprintRotated(t, "picture", &pictureSK.PublicKey, reloader.m.PictureWriteIssuers())
	assertFingerprintRotated(t, "audio", &audioSK.PublicKey, reloader.m.AudioWriteIssuers())
}

// TestStiqCapabilitiesPushBlock asserts the optional T1 push discovery block round-trips: it is
// present with both onions when configured, present carrying whichever single onion is set (the
// other empty), absent entirely when both are empty, and never disturbs the sibling capability
// fields (schema_version / enforced / reject_codes_version). The push block is purely descriptive,
// so this only pins the advertised SHAPE, not any admission behaviour.
func TestStiqCapabilitiesPushBlock(t *testing.T) {
	_, enrollPEM := issuerKeyPEM(t)
	base := func() *config.Config { return &config.Config{IssuerPublicKeys: []string{enrollPEM}} }

	const watcherOnion = "watcherabc23def45678901234567890123456789012345678901234abcd.onion"
	const ntfyOnion = "ntfyxyz1234567890abcdef1234567890abcdef1234567890abcdef012.onion"

	t.Run("both onions present", func(t *testing.T) {
		cfg := base()
		cfg.PushWatcherOnion = watcherOnion
		cfg.PushNtfyOnion = ntfyOnion
		m := roundTrip(t, cfg)

		push, ok := m["push"].(map[string]any)
		if !ok {
			t.Fatalf("stiq-capabilities missing push block: %v", m["push"])
		}
		if push["watcher"] != watcherOnion {
			t.Errorf("push.watcher = %v, want %q", push["watcher"], watcherOnion)
		}
		if push["ntfy"] != ntfyOnion {
			t.Errorf("push.ntfy = %v, want %q", push["ntfy"], ntfyOnion)
		}

		// Sibling fields must survive untouched (in particular the reject-code vocabulary version).
		if got := m["reject_codes_version"].(float64); int(got) != policy.RejectCodesVersion {
			t.Errorf("reject_codes_version = %v, want %d (unchanged by push)", got, policy.RejectCodesVersion)
		}
		if got := m["schema_version"].(float64); int(got) != config.SchemaVersion {
			t.Errorf("schema_version = %v, want %d (unchanged by push)", got, config.SchemaVersion)
		}
		if _, ok := m["enforced"].(map[string]any); !ok {
			t.Errorf("enforced block missing/altered when push is set: %v", m["enforced"])
		}
	})

	t.Run("only watcher set", func(t *testing.T) {
		cfg := base()
		cfg.PushWatcherOnion = watcherOnion
		m := roundTrip(t, cfg)
		push, ok := m["push"].(map[string]any)
		if !ok {
			t.Fatalf("push block should be present when only the watcher onion is set: %v", m["push"])
		}
		if push["watcher"] != watcherOnion {
			t.Errorf("push.watcher = %v, want %q", push["watcher"], watcherOnion)
		}
		if push["ntfy"] != "" {
			t.Errorf("push.ntfy = %v, want \"\" (ntfy onion unset)", push["ntfy"])
		}
	})

	t.Run("only ntfy set", func(t *testing.T) {
		cfg := base()
		cfg.PushNtfyOnion = ntfyOnion
		m := roundTrip(t, cfg)
		push, ok := m["push"].(map[string]any)
		if !ok {
			t.Fatalf("push block should be present when only the ntfy onion is set: %v", m["push"])
		}
		if push["ntfy"] != ntfyOnion {
			t.Errorf("push.ntfy = %v, want %q", push["ntfy"], ntfyOnion)
		}
		if push["watcher"] != "" {
			t.Errorf("push.watcher = %v, want \"\" (watcher onion unset)", push["watcher"])
		}
	})

	t.Run("absent when both empty", func(t *testing.T) {
		m := roundTrip(t, base())
		if _, ok := m["push"]; ok {
			t.Errorf("push block must be omitted when both onions are empty, got %v", m["push"])
		}
	})
}

// makeCredentialForToken mirrors relay_integration_test.go's makeCredential but blind-signs a
// CALLER-CHOSEN token rather than random bytes — needed for holder-proof tests where token 0 must
// equal a specific BIP-340 x-only pubkey Q, not arbitrary bytes.
func makeCredentialForToken(t *testing.T, issuerSK *rsa.PrivateKey, token []byte) membership.Credential {
	t.Helper()
	cred, err := membership.RequestCredential(&issuerSK.PublicKey, token, membership.NewIssuer(issuerSK).BlindSign)
	if err != nil {
		t.Fatalf("RequestCredential: %v", err)
	}
	return cred
}

// spendProofForTest signs the P3 spend-message digest for a token i>=1 with its secret q,
// independently re-deriving the shared contract's formula — sha256("stiq-spend-v1" || evPub) —
// rather than reaching into policy's unexported spendMessage, exactly as the client does on its
// side (the two don't share a file).
func spendProofForTest(t *testing.T, qHex, evPubHex string) []byte {
	t.Helper()
	qBytes, err := hex.DecodeString(qHex)
	if err != nil {
		t.Fatalf("decode q: %v", err)
	}
	evPub, err := hex.DecodeString(evPubHex)
	if err != nil {
		t.Fatalf("decode event pubkey: %v", err)
	}
	digest := sha256.Sum256(append([]byte("stiq-spend-v1"), evPub...))
	sig, err := schnorr.Sign(secp256k1.PrivKeyFromBytes(qBytes), digest[:])
	if err != nil {
		t.Fatalf("schnorr sign: %v", err)
	}
	return sig.Serialize()
}

// TestHolderProofHookOrderRegression is the end-to-end companion to
// policy.TestHolderProofHookOrderInvariant: it drives the SAME forged shape (pubkey == a captured
// Q whose token 0 would satisfy the holder-proof shortcut, but with a garbage signature) through
// the REAL wired relay (New(), over an actual WebSocket). It must never be admitted.
//
// NOTE on what enforces this in practice: khatru's own EVENT-envelope handler validates event.ID
// and event.CheckSignature() BEFORE invoking any RejectEvent hook at all (including our own
// policy.RequireValidSignature), so on this exact transport path the invariant is enforced twice
// over. The load-bearing, policy-level version of the claim — that policy.Membership.RejectEvent
// run WITHOUT a prior signature check is fooled by the token0==event.pubkey shortcut, and that
// ordering RequireValidSignature first in relay.go's RejectEvent chain is what prevents that — is
// pinned precisely (and independent of khatru's gate) by
// policy.TestHolderProofHookOrderInvariant. This test additionally pins the observable outcome on
// the real, fully wired relay.
func TestHolderProofHookOrderRegression(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	cfg := config.Config{
		Listen:              "127.0.0.1:0",
		IssuerPublicKeys:    []string{issuerPEM},
		AllowedKinds:        config.DefaultAllowedKinds,
		HolderProofRequired: true,
	}
	relay, closeStore, _, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	srv := httptest.NewServer(relay)
	t.Cleanup(srv.Close)
	ws := "ws" + strings.TrimPrefix(srv.URL, "http")

	_, Q := keypair(t) // a real BIP-340 x-only pubkey; deliberately never signed with its own secret
	Qbytes, err := hex.DecodeString(Q)
	if err != nil {
		t.Fatalf("decode Q: %v", err)
	}
	cred := makeCredentialForToken(t, issuerSK, Qbytes) // token 0 == Q: shortcut would pass if reached

	ev := &nostr.Event{
		Kind:      1,
		PubKey:    Q,
		CreatedAt: nostr.Now(),
		Content:   "forged",
		Tags: nostr.Tags{
			{"stiq_token", base64.StdEncoding.EncodeToString(cred.Token)},
			{"stiq_sig", base64.StdEncoding.EncodeToString(cred.Signature)},
		},
	}
	ev.ID = ev.GetID()
	ev.Sig = strings.Repeat("ab", 64) // garbage 64-byte "signature", never produced by Q's secret

	ok, msg := publish(t, ws, ev)
	if ok {
		t.Fatal("an event with pubkey=Q (token 0 match) but an invalid signature must never be admitted")
	}
	if !strings.Contains(msg, "signature") {
		t.Fatalf("must be rejected at the SIGNATURE stage (before membership/holder-proof), got: %q", msg)
	}
}

// TestHolderProofAdmitsRealSignedMultiTokenPostEndToEnd drives a genuine holder-bound multi-token
// post (real BIP-340 event signature, not just the policy-package unit tests) through the actual
// wired relay with HolderProofRequired=true — proving the full admission chain (signature -> weight
// -> membership/holder-proof) accepts the exact wire shape blind/blindPost.ts emits.
func TestHolderProofAdmitsRealSignedMultiTokenPostEndToEnd(t *testing.T) {
	issuerSK, issuerPEM := issuerKeyPEM(t)
	cfg := config.Config{
		Listen:              "127.0.0.1:0",
		IssuerPublicKeys:    []string{issuerPEM},
		AllowedKinds:        config.DefaultAllowedKinds,
		HolderProofRequired: true,
	}
	relay, closeStore, _, err := New(cfg)
	if err != nil {
		t.Fatalf("build relay: %v", err)
	}
	t.Cleanup(closeStore)
	srv := httptest.NewServer(relay)
	t.Cleanup(srv.Close)
	ws := "ws" + strings.TrimPrefix(srv.URL, "http")

	q0, Q0 := keypair(t)
	Q0Bytes, err := hex.DecodeString(Q0)
	if err != nil {
		t.Fatalf("decode Q0: %v", err)
	}
	cred0 := makeCredentialForToken(t, issuerSK, Q0Bytes)

	q1, Q1 := keypair(t)
	Q1Bytes, err := hex.DecodeString(Q1)
	if err != nil {
		t.Fatalf("decode Q1: %v", err)
	}
	cred1 := makeCredentialForToken(t, issuerSK, Q1Bytes)
	proof1 := spendProofForTest(t, q1, Q0)

	ev := &nostr.Event{
		Kind:      1,
		CreatedAt: nostr.Now(),
		Content:   "hello holder-bound world",
		Tags: nostr.Tags{
			{"stiq_token", base64.StdEncoding.EncodeToString(cred0.Token)},
			{"stiq_sig", base64.StdEncoding.EncodeToString(cred0.Signature)},
			{"stiq_token", base64.StdEncoding.EncodeToString(cred1.Token)},
			{"stiq_sig", base64.StdEncoding.EncodeToString(cred1.Signature)},
			{"stiq_spend", base64.StdEncoding.EncodeToString(proof1)},
		},
	}
	if err := ev.Sign(q0); err != nil { // event.pubkey becomes Q0, a real BIP-340 signature
		t.Fatalf("sign: %v", err)
	}

	ok, msg := publish(t, ws, ev)
	if !ok {
		t.Fatalf("a real holder-bound multi-token post should be admitted: %q", msg)
	}
}

// TestFirstKeyB64EmptyAndBadPEM asserts firstKeyB64 fails closed (returns "") on an empty list and
// on a list whose first entry is not valid PEM, mirroring keyFingerprints' skip-don't-panic policy.
func TestFirstKeyB64EmptyAndBadPEM(t *testing.T) {
	if got := firstKeyB64(nil); got != "" {
		t.Errorf("firstKeyB64(nil) = %q, want \"\"", got)
	}
	if got := firstKeyB64([]string{}); got != "" {
		t.Errorf("firstKeyB64([]string{}) = %q, want \"\"", got)
	}
	if got := firstKeyB64([]string{"not a pem"}); got != "" {
		t.Errorf("firstKeyB64 with undecodable PEM = %q, want \"\"", got)
	}
}

// TestKeyFingerprintsHashesBase64OfDER (F-A regression) pins the exact preimage keyFingerprints
// must hash: the STANDARD-BASE64 ENCODING of the decoded DER SPKI bytes, not the raw DER bytes
// themselves. It builds a PEM from a freshly generated key, computes the fingerprint two ways —
// via keyFingerprints and via the formula spelled out in CLIENT_C5_FINGERPRINT_CONTRACT.md
// (sha256(base64.StdEncoding(der))) — and asserts they're byte-identical. A relay that regresses
// to hashing the raw DER (the pre-fix bug) would fail this test.
func TestKeyFingerprintsHashesBase64OfDER(t *testing.T) {
	_, goodPEM := issuerKeyPEM(t)
	block, _ := pem.Decode([]byte(goodPEM))
	if block == nil {
		t.Fatal("test fixture PEM failed to decode")
	}

	b64 := base64.StdEncoding.EncodeToString(block.Bytes)
	sum := sha256.Sum256([]byte(b64))
	want := "sha256:" + hex.EncodeToString(sum[:])

	got := keyFingerprints([]string{goodPEM})
	if len(got) != 1 {
		t.Fatalf("keyFingerprints returned %d entries, want 1: %v", len(got), got)
	}
	if got[0] != want {
		t.Errorf("keyFingerprints = %q, want %q (sha256 of the base64-STRING encoding of the DER, not the raw DER bytes)", got[0], want)
	}

	// The wrong (pre-fix) preimage — sha256 of the raw DER bytes directly — must NOT match, else
	// this test would pass vacuously for a key whose base64 and DER hashes happen to collide.
	rawDERSum := sha256.Sum256(block.Bytes)
	wrongFP := "sha256:" + hex.EncodeToString(rawDERSum[:])
	if got[0] == wrongFP {
		t.Fatalf("keyFingerprints matches the OLD raw-DER hash %q — the base64 and DER hashes cannot both be right; the fix did not take effect", wrongFP)
	}
}

// TestKeyFingerprintsReproducesClientC5ContractVector (F-A regression) drives the degenerate test
// vector published in CLIENT_C5_FINGERPRINT_CONTRACT.md ("aXNz", the client unit-test issuer key)
// — which the client's walletKeyFingerprint (client/src/blind/wallet.ts) and the organizer's
// pubB64 fingerprint (issuer/organizer-server.mjs) both already satisfy — through keyFingerprints
// and asserts the relay reproduces the same 16-hex prefix. The vector's INPUT_STRING is
// standard-base64; it is decoded to raw bytes, wrapped in a PEM block (pem.Decode does not
// validate ASN.1 structure, so a degenerate non-SPKI byte string round-trips fine), and fed
// through the real keyFingerprints function exactly as a configured issuer key would be.
//
// NOTE: the contract doc's SECOND ("realistic RSA DER-SPKI") test vector is not exercised here —
// its INPUT_STRING as published (301 chars) is not a valid base64 length (not a multiple of 4;
// verified independently with `base64 -d`), so it cannot decode at all. That looks like a
// transcription bug in CLIENT_C5_FINGERPRINT_CONTRACT.md itself (outside relay/**, not touched by
// this fix) rather than anything about the relay's algorithm — the degenerate vector plus
// TestKeyFingerprintsHashesBase64OfDER (which pins the formula against a freshly generated real
// key) already cover the two things that vector would have: a real-shaped key and exact-value
// pinning.
func TestKeyFingerprintsReproducesClientC5ContractVector(t *testing.T) {
	vectors := []struct {
		name      string
		inputB64  string
		want16Hex string
	}{
		{
			name:      "degenerate short vector (client unit-test issuer key)",
			inputB64:  "aXNz",
			want16Hex: "7d8bfd74a49541a4",
		},
	}

	for _, v := range vectors {
		t.Run(v.name, func(t *testing.T) {
			der, err := base64.StdEncoding.DecodeString(v.inputB64)
			if err != nil {
				t.Fatalf("test vector INPUT_STRING is not valid base64: %v", err)
			}
			pemBytes := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
			if pemBytes == nil {
				t.Fatal("pem.EncodeToMemory returned nil")
			}

			got := keyFingerprints([]string{string(pemBytes)})
			if len(got) != 1 {
				t.Fatalf("keyFingerprints returned %d entries, want 1: %v", len(got), got)
			}
			fp := strings.TrimPrefix(got[0], "sha256:")
			if len(fp) < 16 || fp[:16] != v.want16Hex {
				t.Errorf("keyFingerprints[0] = %q, want 16-hex prefix %q per CLIENT_C5_FINGERPRINT_CONTRACT.md", got[0], v.want16Hex)
			}

			// Cross-check against the contract's own Go reference formula for the same input.
			sum := sha256.Sum256([]byte(v.inputB64))
			refFP := hex.EncodeToString(sum[:])[:16]
			if refFP != v.want16Hex {
				t.Fatalf("contract self-check failed: sha256(utf8(%q))[:16] = %q, want %q — the test vector itself is wrong", v.inputB64, refFP, v.want16Hex)
			}
		})
	}
}

// TestKeyFingerprintsSkipsBadPEM asserts a malformed PEM string is skipped (never panics) rather
// than aborting the whole list.
func TestKeyFingerprintsSkipsBadPEM(t *testing.T) {
	_, goodPEM := issuerKeyPEM(t)
	fps := keyFingerprints([]string{"not a pem", goodPEM, "-----BEGIN GARBAGE-----"})
	if len(fps) != 1 {
		t.Fatalf("keyFingerprints returned %d, want 1 (bad PEMs skipped): %v", len(fps), fps)
	}
	if !strings.HasPrefix(fps[0], "sha256:") {
		t.Errorf("fingerprint %q missing sha256: prefix", fps[0])
	}
}

// TestNIP11HandlerAdvertisesCapabilities builds a real relay via New() and drives its NIP-11 handler
// through the same splice the "/" interceptor performs (render HandleNIP11 → unmarshal → inject
// stiq-capabilities built from the live Reloader.Config()), asserting the augmented document carries
// a well-formed stiq-capabilities block. This exercises the New()→Reloader.Config() wiring the
// interceptor depends on.
func TestNIP11HandlerAdvertisesCapabilities(t *testing.T) {
	_, issuerPEM := issuerKeyPEM(t)
	cfg := config.Config{
		Listen:           "127.0.0.1:0",
		IssuerPublicKeys: []string{issuerPEM},
		BlindRequired:    true,
	}
	relay, closeFn, reloader, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer closeFn()

	// The live config must be readable immediately after New() (interceptor reads it every request).
	if reloader.Config() == nil {
		t.Fatal("Reloader.Config() is nil after New(); interceptor would panic")
	}

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "application/nostr+json")
	rec := httptest.NewRecorder()
	relay.HandleNIP11(rec, req)

	var doc map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("relay NIP-11 doc is not valid JSON: %v", err)
	}
	caps, err := json.Marshal(StiqCapabilities(reloader.Config()))
	if err != nil {
		t.Fatalf("marshal capabilities: %v", err)
	}
	doc["stiq-capabilities"] = caps
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("re-marshal augmented doc: %v", err)
	}

	var augmented map[string]any
	if err := json.Unmarshal(out, &augmented); err != nil {
		t.Fatalf("augmented doc not valid JSON: %v", err)
	}
	block, ok := augmented["stiq-capabilities"].(map[string]any)
	if !ok {
		t.Fatalf("augmented NIP-11 doc missing stiq-capabilities block: %v", augmented["stiq-capabilities"])
	}
	if _, ok := block["reject_codes_version"]; !ok {
		t.Error("stiq-capabilities missing reject_codes_version")
	}
	enforced, ok := block["enforced"].(map[string]any)
	if !ok || enforced["blind_required"] != true {
		t.Errorf("stiq-capabilities.enforced.blind_required = %v, want true", enforced)
	}
	// The relay's own NIP-11 fields must survive the splice (name is set in New()).
	if _, ok := augmented["name"]; !ok {
		t.Error("augmented doc dropped the relay's own NIP-11 fields (name missing)")
	}
}
