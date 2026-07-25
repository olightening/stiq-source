// Package relayapp wires the khatru relay together with the stiq policies and storage.
package relayapp

import (
	"context"
	"crypto/rsa"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/fiatjaf/eventstore/badger"
	"github.com/fiatjaf/khatru"
	"github.com/nbd-wtf/go-nostr"
	"github.com/nbd-wtf/go-nostr/nip11"

	"github.com/stiq/relay/internal/badgeropts"
	"github.com/stiq/relay/internal/config"
	"github.com/stiq/relay/internal/groups"
	"github.com/stiq/relay/internal/membership"
	"github.com/stiq/relay/internal/policy"
	"github.com/stiq/relay/internal/ratelimit"
)

// maxNegentropyEvents bounds how many events a single NIP-77 reconciliation session may load into
// memory. It is generous enough for real feed sync yet caps a malicious unscoped NEG-OPEN so it
// cannot pull the entire store (finding #74). ~64K ids+timestamps ≈ a few MB per session.
const maxNegentropyEvents = 65536

// Reloader holds the live policy objects that can be updated on SIGHUP without restarting
// the relay. Call Apply with a freshly-loaded config to atomically update the mutable fields
// (organizer_pubkeys, rate limits, max_tags_per_post). Fields that require a restart (listen
// address, storage path, the general enrollment issuer_public_keys) are silently ignored.
type Reloader struct {
	holder *policy.ConfigHolder
	m      *policy.Membership
	// gg lets Apply hot-reload private_group_read_auth (see the GroupGuard.SetPrivateGroupReadAuth
	// call below) — the same hot-reload treatment as organizer_pubkeys/blind_required/etc., closing
	// the boot-only landmine documented on config.PrivateGroupReadAuth.
	gg *policy.GroupGuard
	// cfg holds the most recent full config: the boot config at New(), then whatever every SIGHUP
	// Apply stores. The NIP-11 capabilities builder (main.go) reads it through Config() so the
	// advertised stiq-capabilities always reflect hot-reloaded blind_required / bytes_per_token /
	// organizer_pubkeys without a restart. atomic.Pointer makes the swap lock-free and race-free.
	cfg atomic.Pointer[config.Config]
}

// Config returns the live config last stored by New() or Apply(). Never nil after New(). Callers
// must treat the returned *config.Config as read-only (it is shared with future readers).
func (r *Reloader) Config() *config.Config { return r.cfg.Load() }

// issuerKeySet pairs one hot-reloadable issuer-key domain's raw PEM list (read fresh off disk on
// every SIGHUP) with the Membership setter that installs its parsed form. T1.1 (finding F5): before
// this table existed, Apply hard-coded a single bespoke `if len(cfg.SpaceWriteIssuerPublicKeys) > 0
// { ... UpdateSpaceWriteIssuers(...) }` block — space-write was the only domain that ever got a
// hot-reload path, while posting/picture-write/audio-write/binding stayed "construction-only" even
// though capabilities.go advertises all of them from the SAME live config. Driving the reload loop
// off this table instead means a domain can never again go silently un-reloaded by omission: adding
// a new hot-reloadable issuer set means adding one row here, not writing (and possibly forgetting)
// another bespoke if-block.
type issuerKeySet struct {
	// name identifies the domain in a reload-failure log line. Deliberately NOT the wire "purpose"
	// vocabulary (post/read/picture-write/...) or the NIP-11 fingerprint-key vocabulary — just a
	// human-readable label; see Appendix A in TOKEN_FIXING_PLAN.md on why those two must not be
	// conflated.
	name string
	pems []string
	// update installs the freshly-parsed key set into Membership. Always one of the mutex-guarded
	// Update*Issuers methods, so the swap is race-free against concurrent request handling.
	update func([]*rsa.PublicKey)
}

// Apply atomically updates the organizer pubkeys in both the ConfigHolder and the Membership
// guard. Rate limits and tag policy are applied live whenever the organizer republishes their
// kind-30078 events; no extra action is needed here for those. The config.json fields that affect
// live behaviour and need explicit Apply are the STATIC (not organizer-published) ones:
// organizer_pubkeys (who may publish kind-30078 at all), blind_required, bytes_per_token,
// space_tokens_required, private_group_read_auth, and EVERY hot-reloadable issuer key set (see
// issuerKeySet above).
func (r *Reloader) Apply(cfg config.Config) {
	r.holder.UpdateOrganizers(cfg.OrganizerPubkeys)
	r.m.UpdateOrganizers(r.holder.Organizers())
	// private_group_read_auth (finding #38 follow-up): a static config.json flag that used to be
	// wired ONLY at construction (relay.go's old `if cfg.PrivateGroupReadAuth { ... }` at New time),
	// so an operator could enable it without a restart-free way back off — a landmine, since the
	// client fleet has zero NIP-42 support and enabling it blanks every private group with no error.
	// Reload it BOTH directions on every SIGHUP, and warn loudly whenever the reloaded value is on.
	r.gg.UpdatePrivateGroupReadAuth(cfg.PrivateGroupReadAuth)
	warnIfPrivateGroupReadAuthEnabled(cfg.PrivateGroupReadAuth)
	// blind_required is a static config.json flag (not organizer-published), so apply it on reload
	// too — an operator can flip the bound-npub bypass closed via SIGHUP without a full restart.
	r.m.UpdateBlindRequired(cfg.BlindRequired)
	// holder_proof_required is likewise a static config.json flag (P3 holder-bound-token gate), so
	// reload it on SIGHUP too — an operator can flip it on (typically alongside a K_post rotation at
	// an epoch boundary) without a full restart. Ships dark (false).
	r.m.UpdateHolderProofRequired(cfg.HolderProofRequired)
	// bytes_per_token is likewise a static config.json flag (weight-priced anti-spam), so reload it
	// on SIGHUP for the same reason — an operator can tune the per-byte token price without a full
	// restart, consistent with blind_required above. 0 keeps one-token-per-event (dark).
	r.m.UpdateBytesPerToken(cfg.BytesPerToken)
	// space_tokens_required (tokens-everywhere) is likewise a static config.json flag, reloadable so
	// the operator can flip space-token enforcement on via SIGHUP once the fleet updates. Dark (false).
	r.m.UpdateSpaceTokensRequired(cfg.SpaceTokensRequired)
	// Every issuer key set that can hot-reload (T1.1, finding F5): binding / posting /
	// picture-write / audio-write / space-write, all under ONE table so no domain can be added here
	// and silently stay construction-only — the exact advertise-vs-enforce gap that originally
	// bricked space-write. (The general enrollment/draw issuer_public_keys are deliberately NOT in
	// this table: main.go documents them as restart-only, and rotating that key set mid-stream is an
	// unscoped decision — see EnrollIssuers' doc in membership.go.)
	//
	// A parse failure keeps the previously-loaded keys for that domain (log + skip) rather than
	// dropping them — a bad reload must not brick verification — and an empty list is left to a full
	// restart, mirroring New() (which only sets when non-empty; the dark default is nil/empty).
	issuerKeySets := []issuerKeySet{
		{"binding", cfg.BindingIssuerPublicKeys, r.m.UpdateBindingIssuers},
		{"posting", cfg.PostingIssuerPublicKeys, r.m.UpdatePostingIssuers},
		{"picture", cfg.PictureWriteIssuerPublicKeys, r.m.UpdatePictureWriteIssuers},
		{"audio", cfg.AudioWriteIssuerPublicKeys, r.m.UpdateAudioWriteIssuers},
		{"space_write", cfg.SpaceWriteIssuerPublicKeys, r.m.UpdateSpaceWriteIssuers},
	}
	for _, set := range issuerKeySets {
		if len(set.pems) == 0 {
			continue
		}
		issuers, err := config.ParseIssuerKeys(set.pems)
		if err != nil {
			log.Printf("relay: SIGHUP reload of %s issuer keys failed, keeping previous keys: %v", set.name, err)
			continue
		}
		set.update(issuers)
	}
	// Retain the freshly-loaded config so the NIP-11 capabilities builder reflects this reload
	// (blind_required / bytes_per_token / organizer_pubkeys / issuer keys). Store a copy so a later
	// caller mutation can't race concurrent Config() readers.
	next := cfg
	r.cfg.Store(&next)
}

// New builds a khatru relay with the signature + membership policies and storage wired in.
//
// Admission (PLAN.md §3.3): verify the Nostr signature, then enforce membership — accept a
// one-time binding event carrying a valid credential, and accept normal events only from
// bound npubs. The relay never learns who a member is.
//
// Event storage is persistent (badger) when cfg.DataDir is set, otherwise in-memory. The
// returned close function releases the storage backend.
func New(cfg config.Config) (*khatru.Relay, func(), *Reloader, error) {
	relay := khatru.NewRelay()
	relay.Info.Name = "stiq-relay"
	relay.Info.Description = "Membership-gated Nostr relay (PLAN.md §3.3)"
	relay.Log = log.New(io.Discard, "", 0)

	// NIP-77 (Negentropy set reconciliation): lets clients sync deltas instead of refetching
	// overlapping history — a big bandwidth win over Tor. khatru handles the NEG-OPEN/NEG-MSG
	// frames entirely; the reconciliation session is built from the same QueryEvents path and
	// runs the same RejectFilter chain as a normal REQ, so RequireScopedDiscovery (anti-
	// enumeration) still applies and no allow-list change is needed. Setting this flag also
	// makes khatru advertise NIP-77 in its NIP-11 document.
	relay.Negentropy = true

	// Websocket transport frame ceiling (mediasize_probe_test.go). khatru's underlying
	// fasthttp/websocket connection defaults MaxMessageSize to 512000 bytes, completely independent
	// of max_event_bytes below. When max_event_bytes is raised above that ceiling (524288 in prod,
	// pushed 2026-07-05), any frame between the two sizes is dropped by the TRANSPORT before it ever
	// reaches WeightGate: the connection is closed with code 1009 and NO OK frame is sent, so the
	// relay logs nothing and the publisher just sees a timeout (this silently ate outsized mailbox
	// responses and inline-media posts). Derive the transport ceiling from the SAME effective
	// max_event_bytes the weight gate below enforces (0/unset falls back to
	// config.DefaultMaxEventBytes, mirroring config.Load's own substitution) plus 64KiB of headroom
	// for the WS envelope + JSON structure the weight gate doesn't count (event id/pubkey/sig/kind/
	// created_at fields, tag-array brackets, the ["EVENT", ...] wrapper) — so a frame at exactly
	// max_event_bytes always reaches the weight gate instead of being clipped below it.
	//
	// BOOT-TIME ONLY: khatru reads MaxMessageSize once per NEW connection at handshake
	// (SetReadLimit in its accept goroutine, not per message), and the field is a plain
	// unsynchronized int64 on khatru.Relay — not something Reloader.Apply can safely swap under
	// live connections. max_event_bytes stays restart-only here, exactly like the WeightGate it must
	// stay in lockstep with (see policy.NewWeightGate below).
	effectiveMaxEventBytes := cfg.MaxEventBytes
	if effectiveMaxEventBytes <= 0 {
		effectiveMaxEventBytes = config.DefaultMaxEventBytes
	}
	relay.MaxMessageSize = int64(effectiveMaxEventBytes) + 64*1024

	// Advertise and enforce query limits (NIP-11 Limitation). MaxLimit caps the `limit`
	// field on incoming REQ filters so one subscription can't replay unbounded history.
	// DefaultLimit applies when the client sends no limit at all. Both are silently clamped
	// (OverwriteFilter), not rejected, so well-behaved clients aren't broken.
	// Advertise the content-neutral weight caps (NIP-11) so clients know the size/tag limits
	// before posting. These are always set (config defaults them), independent of the query
	// limits below.
	lim := &nip11.RelayLimitationDocument{}
	if cfg.MaxEventBytes > 0 {
		lim.MaxContentLength = cfg.MaxEventBytes
	}
	if cfg.MaxTagsPerEvent > 0 {
		lim.MaxEventTags = cfg.MaxTagsPerEvent
	}
	relay.Info.Limitation = lim

	if cfg.MaxLimit > 0 || cfg.DefaultLimit > 0 {
		if cfg.MaxLimit > 0 {
			lim.MaxLimit = cfg.MaxLimit
		}
		if cfg.DefaultLimit > 0 {
			lim.DefaultLimit = cfg.DefaultLimit
		}

		maxLimit := cfg.MaxLimit
		defaultLimit := cfg.DefaultLimit
		relay.OverwriteFilter = append(relay.OverwriteFilter, func(_ context.Context, filter *nostr.Filter) {
			if defaultLimit > 0 && filter.Limit == 0 && !filter.LimitZero {
				filter.Limit = defaultLimit
			}
			if maxLimit > 0 && filter.Limit > maxLimit {
				filter.Limit = maxLimit
			}
		})
	}

	var closeFn func()
	var queryFn func(context.Context, nostr.Filter) (chan *nostr.Event, error)
	// saveEvent stores a relay-generated event (NIP-29 group state) through the same backend
	// as member events, bypassing the RejectEvent path. The 39000-39005 state kinds are all
	// addressable (30000-39999), so they route through ReplaceEvent: each emission deletes the
	// prior version for the same (kind, relay-author, d-tag) instead of appending forever
	// (finding #26 — raw SaveEvent let superseded state accumulate in badger unbounded).
	// deleteEvent removes one outright (used to purge a deleted group's state events).
	var saveEvent func(context.Context, *nostr.Event) error
	var deleteEvent func(context.Context, *nostr.Event) error
	// delGuard wraps the QueryEvents backend registered with khatru to bound NIP-09 deletion query
	// amplification per connection (finding #37(a); see deletionguard.go). queryFn below stays the RAW
	// backend so startup config replay + group-guard lookups are never subject to the deletion cap.
	delGuard := newDeletionQueryGuard()
	if cfg.DataDir != "" {
		db := &badger.BadgerBackend{
			Path:                  cfg.DataDir,
			BadgerOptionsModifier: badgeropts.EventStore,
			// Cap negentropy (NIP-77) reconciliation set size. The backend otherwise defaults this to
			// 16,777,216, so an unscoped NEG-OPEN on kind 1 would build an in-memory fingerprint vector
			// over EVERY note in the store — defeating the ~250-event bound an equivalent REQ gets and
			// scaling with DB size across concurrent sessions. Reads are unauthenticated, so bound it.
			// (finding #74)
			MaxLimitNegentropy: maxNegentropyEvents,
		}
		if err := db.Init(); err != nil {
			return nil, nil, nil, err
		}
		relay.StoreEvent = append(relay.StoreEvent, db.SaveEvent)
		relay.QueryEvents = append(relay.QueryEvents, delGuard.wrap(db.QueryEvents))
		relay.DeleteEvent = append(relay.DeleteEvent, db.DeleteEvent)
		// NIP-45 COUNT: lets clients tally comments/reactions/etc. without pulling raw events
		// over Tor. Setting CountEvents also makes khatru advertise NIP-45 in its NIP-11 doc.
		relay.CountEvents = append(relay.CountEvents, db.CountEvents)
		queryFn = db.QueryEvents
		saveEvent = db.ReplaceEvent
		deleteEvent = db.DeleteEvent
		// Periodic Badger value-log GC: reclaims space from deleted/overwritten events.
		// 0.5 = run GC only if ≥50% of value-log bytes are reclaimable (Badger default).
		gcTicker := time.NewTicker(15 * time.Minute)
		gcDone := make(chan struct{})
		go func() {
			for {
				select {
				case <-gcTicker.C:
					_ = db.RunValueLogGC(0.5)
				case <-gcDone:
					return
				}
			}
		}()
		closeFn = func() {
			gcTicker.Stop()
			close(gcDone)
			db.Close()
		}
	} else {
		db := &lockedSliceStore{}
		if err := db.Init(); err != nil {
			return nil, nil, nil, err
		}
		relay.StoreEvent = append(relay.StoreEvent, db.SaveEvent)
		relay.QueryEvents = append(relay.QueryEvents, delGuard.wrap(db.QueryEvents))
		relay.DeleteEvent = append(relay.DeleteEvent, db.DeleteEvent)
		relay.CountEvents = append(relay.CountEvents, db.CountEvents)
		queryFn = db.QueryEvents
		saveEvent = db.ReplaceEvent
		deleteEvent = db.DeleteEvent
		closeFn = func() { db.Close() }
	}

	issuers, err := config.ParseIssuerKeys(cfg.IssuerPublicKeys)
	if err != nil {
		return nil, nil, nil, err
	}

	var memStore membership.Store
	if cfg.MembershipFile != "" {
		var ms *membership.MemStore
		var err error
		if cfg.DataDir != "" {
			// Persistent relay: keep the small bound/boundAt state in the JSON file but back the
			// unbounded spent-token set with its own badger DB (no O(n) full-file rewrite per spend).
			ms, err = membership.LoadMemStoreWithBadgerSpent(cfg.MembershipFile, filepath.Join(cfg.DataDir, "spent"))
		} else {
			ms, err = membership.LoadMemStore(cfg.MembershipFile)
		}
		if err != nil {
			return nil, nil, nil, err
		}
		memStore = ms
		// Chain the spent-set close onto the storage closeFn (built above for the event store).
		prevClose := closeFn
		closeFn = func() {
			prevClose()
			_ = ms.Close()
		}
	} else {
		memStore = membership.NewMemStore()
	}

	m := policy.NewMembership(issuers, memStore, cfg.AllowedKinds, cfg.PoWDifficulty, cfg.EnrollPoW)
	// Token domain separation (finding #16): when the organizer signs enrollment/membership
	// credentials under a DISTINCT key, supply its public half here so a kind-9011 binding is verified
	// ONLY against it — a plentiful posting/read/draw token can then no longer double as a scarce
	// membership-binding credential. Empty ⇒ binding falls back to the general issuers (dark: no
	// behaviour change until the organizer scheme provides the separate key; see findings #3/#4).
	if len(cfg.BindingIssuerPublicKeys) > 0 {
		bindingIssuers, err := config.ParseIssuerKeys(cfg.BindingIssuerPublicKeys)
		if err != nil {
			return nil, nil, nil, err
		}
		m.SetBindingIssuers(bindingIssuers)
	}
	// Posting-token domain separation (finding #16, symmetric to the binding key above): when the
	// organizer mints per-post blind tokens under a DISTINCT key, supply its public half here so
	// handleBlindPost verifies posting tokens ONLY against it. Empty ⇒ posting falls back to the general
	// issuers (dark: no behaviour change until the organizer scheme provides the separate key). This is
	// the relay half of the rollout, so the intended flip no longer forces repurposing issuer_public_keys.
	if len(cfg.PostingIssuerPublicKeys) > 0 {
		postingIssuers, err := config.ParseIssuerKeys(cfg.PostingIssuerPublicKeys)
		if err != nil {
			return nil, nil, nil, err
		}
		m.SetPostingIssuers(postingIssuers)
	}
	// Media posting-token domain separation (asks #3/#4): when the organizer mints picture/audio WRITE
	// tokens under distinct keys, supply their public halves so a post claiming that stiq_dom must
	// verify against them. Empty ⇒ that domain falls back to the posting keys (dark; byte-identical).
	if len(cfg.PictureWriteIssuerPublicKeys) > 0 {
		picWriteIssuers, err := config.ParseIssuerKeys(cfg.PictureWriteIssuerPublicKeys)
		if err != nil {
			return nil, nil, nil, err
		}
		m.SetPictureWriteIssuers(picWriteIssuers)
	}
	if len(cfg.AudioWriteIssuerPublicKeys) > 0 {
		audWriteIssuers, err := config.ParseIssuerKeys(cfg.AudioWriteIssuerPublicKeys)
		if err != nil {
			return nil, nil, nil, err
		}
		m.SetAudioWriteIssuers(audWriteIssuers)
	}
	// Space-write token keys (tokens-everywhere): the domain metering bound-npub space content +
	// DM wraps. Absent ⇒ token-tagged space kinds stay rejected (dark), like the media domains.
	if len(cfg.SpaceWriteIssuerPublicKeys) > 0 {
		spaceWriteIssuers, err := config.ParseIssuerKeys(cfg.SpaceWriteIssuerPublicKeys)
		if err != nil {
			return nil, nil, nil, err
		}
		m.SetSpaceWriteIssuers(spaceWriteIssuers)
	}
	// Space-token enforcement flag. Ships dark (false) — see config.SpaceTokensRequired.
	m.SetSpaceTokensRequired(cfg.SpaceTokensRequired)
	// Weight-priced tokens: 0 (default) keeps one-token-per-event (dark); >0 charges by size. See
	// config.BytesPerToken — turning it on is a deliberate clients-first migration.
	m.SetBytesPerToken(cfg.BytesPerToken)
	// Close the bound-npub content bypass when the community is blind. Ships dark (false) — see
	// config.BlindRequired.
	m.SetBlindRequired(cfg.BlindRequired)
	// P3 holder-bound-token verification. Ships dark (false) — see config.HolderProofRequired.
	m.SetHolderProofRequired(cfg.HolderProofRequired)

	// Organizer moderation config (PLAN.md §3.4): the holder gates `stiq:` kind-30078 events
	// to the organizer key and tracks the latest roster + rate-limit policy. Organizers are
	// exempt from the membership gate so they can publish config without binding a credential.
	holder := policy.NewConfigHolder(cfg.OrganizerPubkeys)
	m.SetOrganizers(holder.Organizers())
	// Let the holder read bind age so the organizer's newcomer rules (stiq:gov) can enforce a
	// link/channel-creation cooldown on recently-joined members.
	holder.SetMemberInfo(memStore)
	holder.LoadFrom(context.Background(), queryFn)

	// Per-user / global rate limiting (PLAN.md §3.4): bounds how much each member can write so
	// the relay can't grow without limit. Reads its caps live from the organizer's policy.
	limiter := ratelimit.New(holder)
	// Drop per-connection mailbox counters at the exact end of the WebSocket lifetime. Without this,
	// the limiter's idle fallback retained Khatru's heavy *WebSocket objects for five minutes; a
	// connection churn flood could therefore pin enough closed sockets to OOM a small relay host.
	relay.OnDisconnect = append(relay.OnDisconnect, limiter.ForgetConnection)
	// Release the per-connection deletion-lookup counter when the socket closes (keeps delGuard's map
	// bounded by live connections, mirroring the limiter above).
	relay.OnDisconnect = append(relay.OnDisconnect, delGuard.forget)
	enableRelayDiagnostics(relay, limiter)

	// NIP-29 relay-managed groups. State is persisted alongside the membership data; the relay
	// signs the 39000-39003 state events with a stable per-relay identity key (generated once
	// and stored in DataDir, or ephemeral for an in-memory relay).
	var groupStore *groups.Store
	if cfg.DataDir != "" {
		gs, err := groups.LoadStore(filepath.Join(cfg.DataDir, "groups.json"))
		if err != nil {
			return nil, nil, nil, err
		}
		groupStore = gs
	} else {
		groupStore = groups.NewStore()
	}
	relaySK, relayPK, err := loadOrCreateRelayKey(cfg.DataDir)
	if err != nil {
		return nil, nil, nil, err
	}
	groupGuard := policy.NewGroupGuard(groupStore, relaySK, relayPK, func(e *nostr.Event) {
		// Persist the relay-generated state (39000-39005), THEN push it to open subscriptions.
		// khatru only runs notifyListeners for CLIENT-published events (handlers.go), so state we
		// generate internally — a member add/remove, a metadata edit, a pending-queue change —
		// would otherwise land in badger but never reach a live subscriber; they'd see it only
		// after a reconnect re-REQs the group. BroadcastEvent closes that gap, so an approved
		// join-request (and kicks/edits/admin changes) surface live instead of on next reconnect.
		if err := saveEvent(context.Background(), e); err == nil {
			relay.BroadcastEvent(e)
		}
	}, queryFn, deleteEvent)

	// The content-neutral weight gate: max event size + tag count. It consults no identity, so
	// it is the only body-dependent admission check and runs early (right after the signature)
	// to shed oversized events before the costlier RSA token verification.
	weight := policy.NewWeightGate(cfg.MaxEventBytes, cfg.MaxTagsPerEvent)

	// Order matters: verify the signature first (so a binding event's npub is authentic), then
	// the weight gate (cheap, body-only), then enforce membership (bound npub OR a valid per-post
	// blind token + kind allow-list) — VERIFY ONLY, no token spend — then the organizer-config gate,
	// then per-user rate limits, then NIP-29 group role/membership rules, and finally the token
	// COMMIT (see the F1 note on the commit hook below).
	//
	// PINNED INVARIANT (P3 crypto red-team mustFix #3, see policy.TestHolderProofHookOrderInvariant
	// and TestHolderProofHookOrderRegression): signature MUST stay ordered before membership.
	// policy.Membership.checkHolderProof's "token 0 == event.pubkey needs no proof" shortcut is
	// sound ONLY because an event with a forged/invalid signature is already rejected by
	// RequireValidSignature before m.VerifyEvent ever runs. (On this khatru-driven WebSocket path
	// event.ID/signature are ALSO checked upstream, before any RejectEvent hook — see
	// khatru/handlers.go — so this ordering is currently belt-and-suspenders for that specific path;
	// it remains the load-bearing guarantee for any other caller of Membership.VerifyEvent, so do
	// not reorder these two hooks.)
	//
	// The rate limiter runs BEFORE the group guard (finding #40): GroupGuard.Apply rewrites the whole
	// groups.json (marshal + fsync) and re-signs group state on EVERY accepted management event, so a
	// limiter placed after it could never bound that flood — the expensive write already happened.
	// Running the limiter first sheds an over-cap management event before GroupGuard touches disk. The
	// tradeoff is that a management event which passes the cap but then fails group validation still
	// consumes quota; that is acceptable (it deters failed-management spam) since group-chat kinds
	// aren't rate-limited (categorize → catNone) and content kinds are unaffected by the group guard.
	//
	// F1 (token committed before later rejects): the membership hook is now m.VerifyEvent (verify the
	// blind/space token chain, no spend) and the token is committed only in m.CommitSpend, appended as
	// the LAST reject hook. khatru runs the reject chain sequentially with a first-reject short-circuit
	// and stores only after the WHOLE chain passes (adding.go/ephemeral.go), so a token can no longer
	// be burned for an event that organizer/ratelimit/group/admitAttributed then rejects. Double-spend
	// authority is preserved: two concurrent same-token distinct events both pass verify, then serialize
	// at the commit — the loser gets ErrTokenSpent and is rejected pre-store; the same event retried
	// re-commits idempotently by event ID. INVARIANT: a token is committed only after all reject hooks pass.
	eventDiagnostics := os.Getenv("STIQ_RELAY_EVENT_DIAGNOSTICS") == "1"
	relay.RejectEvent = append(relay.RejectEvent,
		diagnosticRejectHook(eventDiagnostics, "signature", policy.RequireValidSignature),
		diagnosticRejectHook(eventDiagnostics, "weight", weight.RejectEvent),
		diagnosticRejectHook(eventDiagnostics, "membership", m.VerifyEvent),
		diagnosticRejectHook(eventDiagnostics, "organizer", holder.RejectEvent),
		diagnosticRejectHook(eventDiagnostics, "ratelimit", limiter.RejectEvent),
		diagnosticRejectHook(eventDiagnostics, "group", groupGuard.RejectEvent),
		diagnosticRejectHook(eventDiagnostics, "commit", m.CommitSpend),
	)
	enableEventDiagnostics(relay)
	// Anti-enumeration: discovery (profile/channel) and group queries must be scoped (§3.8).
	relay.RejectFilter = append(relay.RejectFilter,
		policy.RequireScopedDiscovery,
		policy.RequireScopedGroupQuery,
	)
	// Private-group read enforcement (finding #38) ships DARK: it requires clients to speak NIP-42
	// AUTH, so enable it only once they do (a coordinated flip), otherwise private-group reads break.
	// When off, the `private` flag remains metadata only and private content relies on client-side
	// encryption. The hook is now ALWAYS registered (hot-reloadable, unlike a boot-only if-branch
	// here) — RequirePrivateGroupReadAuth itself gates on the live privateGroupReadAuth flag, which
	// SetPrivateGroupReadAuth/Reloader.Apply can flip on SIGHUP without a restart. This closes the
	// landmine where an operator who enabled it against a client fleet with zero NIP-42 support (every
	// private group goes empty for every member) could not undo that short of a full restart.
	relay.RejectFilter = append(relay.RejectFilter, groupGuard.RequirePrivateGroupReadAuth)
	groupGuard.SetPrivateGroupReadAuth(cfg.PrivateGroupReadAuth)
	warnIfPrivateGroupReadAuthEnabled(cfg.PrivateGroupReadAuth)
	// khatru applies RejectFilter only to REQ; NIP-45 COUNT goes through RejectCountFilter, which was
	// unset — so an unscoped COUNT bypassed the scoping above, becoming an O(N) full-index scan AND an
	// exact enumeration oracle (member count, total notes, channel volume). Mirror the REQ scoping
	// onto counts and additionally reject any fully-unscoped count. (finding #39)
	relay.RejectCountFilter = append(relay.RejectCountFilter,
		policy.RequireScopedDiscovery,
		policy.RequireScopedGroupQuery,
		policy.RequireScopedCount,
	)
	// NIP-09 deletions (kind 5) are processed by khatru BEFORE the RejectEvent chain runs, so stiq's
	// membership/organizer/group/weight/rate-limit gates never see them. khatru's default outcome is
	// standard NIP-09: a target is deletable iff it was authored by the same key as the kind-5. This
	// hook keeps EXACTLY that self-deletion rule but states it explicitly, closing the finding #37
	// moderation-bypass concern (a kind-5 must never delete ANOTHER author's event — reports, other
	// members' content) while allowing an owner to delete their OWN events. That self-deletion path is
	// what the client's channel deletion relies on: AppRuntime.deleteChannel signs a kind-5 with an 'a'
	// tag for its 30311 coordinate, authored by the channel owner, so target.PubKey == deletion.PubKey
	// and the channel is removed. Blind posts are signed by throwaway keys nobody retains, so they can
	// never be self-deleted and stay immutable. An unresolvable target never reaches this hook (khatru
	// skips it), and if one somehow does we do NOT force-allow it. (findings #37, M1)
	relay.OverwriteDeletionOutcome = append(relay.OverwriteDeletionOutcome,
		func(_ context.Context, target *nostr.Event, deletion *nostr.Event) (bool, string) {
			if target == nil {
				return false, "blocked: deletion target could not be resolved"
			}
			if target.PubKey != deletion.PubKey {
				return false, "blocked: cannot delete another author's event"
			}
			return true, ""
		},
	)
	// Advertise NIP-29 (relay-managed groups) and NIP-53 (live activities / channels) in NIP-11.
	relay.Info.AddSupportedNIP(29)
	relay.Info.AddSupportedNIP(53)

	reloader := &Reloader{holder: holder, m: m, gg: groupGuard}
	// Retain the boot config so the NIP-11 capabilities builder (main.go) can read it via Config();
	// every SIGHUP Apply overwrites it. Store a copy so a later caller mutation can't race readers.
	bootCfg := cfg
	reloader.cfg.Store(&bootCfg)
	return relay, closeFn, reloader, nil
}

// warnIfPrivateGroupReadAuthEnabled logs an impossible-to-miss warning at boot and on every SIGHUP
// reload whenever private_group_read_auth is on. The flag requires clients to speak NIP-42 AUTH; the
// current stiq client fleet has ZERO NIP-42 support, so enabling it makes every private group's
// content kinds (chat/thread/reply/reaction/metadata/roster) look EMPTY to every member, with no
// error surfaced anywhere in the client — a silent, total private-group outage. This is intentionally
// always printed (not gated behind STIQ_RELAY_DEBUG_LOG) because it flags an operator misconfiguration
// that bricks a whole feature, not routine diagnostics.
func warnIfPrivateGroupReadAuthEnabled(enabled bool) {
	if !enabled {
		return
	}
	log.Printf("relay: WARNING private_group_read_auth is ENABLED — current stiq clients implement " +
		"NO NIP-42 AUTH, so every private NIP-29 group will appear EMPTY to ALL members (chat, " +
		"threads, reactions, roster) until the client fleet ships NIP-42 support. This is a " +
		"coordinated clients-first flip (finding #38); do not enable it ahead of the clients.")
}

// loadOrCreateRelayKey returns the relay's NIP-29 signing identity. With a DataDir it persists a
// hex secret key at <DataDir>/relay_identity.key so the relay-generated 39000-39003 state events
// keep a stable author (and thus replace correctly) across restarts; without one (in-memory
// relay) it returns an ephemeral key.
func loadOrCreateRelayKey(dataDir string) (sk, pk string, err error) {
	gen := func() (string, string, error) {
		s := nostr.GeneratePrivateKey()
		p, e := nostr.GetPublicKey(s)
		return s, p, e
	}
	if dataDir == "" {
		return gen()
	}
	path := filepath.Join(dataDir, "relay_identity.key")
	if data, readErr := os.ReadFile(path); readErr == nil {
		s := strings.TrimSpace(string(data))
		if p, e := nostr.GetPublicKey(s); e == nil {
			return s, p, nil
		}
		// fall through and regenerate if the stored key is unreadable
	}
	s, p, e := gen()
	if e != nil {
		return "", "", e
	}
	if mkErr := os.MkdirAll(dataDir, 0o700); mkErr == nil {
		_ = os.WriteFile(path, []byte(s), 0o600)
	}
	return s, p, nil
}
