# relay/

Membership-gated Nostr relay — a "dumb" message broker that verifies signatures and
anonymous membership, then stores text (PLAN.md §3.1, §3.3).

## Decision (resolves PLAN.md Step 2 open question)

**Go + [khatru](https://github.com/fiatjaf/khatru)** (fiatjaf's relay framework) rather
than forking and patching `nostr-rs-relay`'s internals. khatru exposes `RejectEvent`
policy hooks, so admission control is a first-class policy function. Storage uses the
`eventstore` family (in-memory `slicestore`, or badger when `data_dir` is set).

## Anonymous membership (PLAN.md §3.3)

Instead of a static `allowed_pubkeys` list (which would let organizers link a member to
their account), the relay verifies **unlinkable membership credentials**:

- Members generate their key **on-device**; organizers never see the `npub`.
- A credential is an RFC 9474 RSA **blind signature** over a random token — the organizer
  ("issuer") signs it without seeing it. The relay holds only the issuer **public** key(s).
- A new member publishes a one-time **binding event** (kind `9011`) carrying the
  credential. The relay verifies it, marks the token spent, and binds that `npub`.
- One credential binds exactly one account (spent-token set), so credentials can't be
  shared to mint many accounts.

## Layout

| Path | Purpose |
|---|---|
| `main.go` | Loads config, builds the relay, serves plain WebSocket (localhost only). |
| `internal/membership/` | RFC 9474 blind credentials (circl): verify, issue, spent/bound store. |
| `internal/policy/signature.go` | Signature-check admission hook. |
| `internal/policy/membership.go` | Binding + bound-npub admission hook. |
| `internal/config/config.go` | Loads `config.json` (issuer PEM keys, kinds, paths). |
| `internal/relayapp/relay.go` | Wires khatru + policies + storage together. |

## Admission rules (applied before storage, in order)

1. **`RequireValidSignature`** — reject any event with a missing/forged signature.
2. **`Membership.RejectEvent`** —
   - a binding event (kind `9011`): accept iff it carries a valid, unspent credential
     (then bind the signer's `npub`);
   - any other event: accept iff the signer is a bound member and the kind is permitted.

Permitted member kinds: `1` (posts), `7` (votes), `1111` (NIP-22 comments),
`1984` (NIP-56 reports). Kind `1059` (NIP-17 DM gift wrap) is **excluded** pending the
accepted-set-vs-NIP-17 decision (PLAN.md §4.1, implemented in Step 16).

The relay **fails closed** in two ways: it refuses to start if `issuer_public_keys` is
empty (it could not verify membership), and it refuses to bind a non-loopback interface
(`config.LoopbackOnly`). It is meant to be reachable **only** through the Tor hidden
service in `deploy/`.

## Run

```sh
cp config.example.json config.json   # then set issuer_public_keys (+ optional paths)
go run .                             # serves ws://127.0.0.1:3334 (loopback only)
```

- Set `"data_dir"` in the config for persistent (badger) storage; empty means in-memory.
- The relay writes **no logs** by default (zero-logging, PLAN.md §3.2). Set
  `STIQ_RELAY_DEBUG_LOG=1` for startup diagnostics during development only.

## Bandwidth over Tor

Every byte this relay serves crosses a Tor circuit to a phone, so both round-trips and bytes
are expensive. Two things address that, and it is worth being precise about what each buys.

**`websocket_compression`** (default `true`) enables RFC 7692 permessage-deflate. It is
strictly opt-in from the client side — a client that does not offer the extension in its
handshake gets a byte-identical handshake response and byte-identical frames — so it is safe
to leave on for an un-updated fleet, and safe to turn off with `"websocket_compression": false`
if the host is under memory pressure (compression costs ~0.8 MB of transient heap per
concurrently-writing connection). Set it before starting the relay; it is restart-only.

Measured, per message, at the fixed settings the library gives us:

| frame | before | after |
|---|---|---|
| kind-1 plaintext post | 1097 B | 827 B (75%) |
| kind-7 reaction | 511 B | 335 B (66%) |
| REQ with feed filters | 173 B | 134 B (78%) |
| kind-1059 NIP-44 DM | 1804 B | 1810 B (**grew**) |
| kind-30351 media blob | 267 KB | 267 KB (**unchanged**) |

The win is real but narrow: it applies to JSON envelopes with prose in them, and is **zero**
on ciphertext and base64 media, which do not compress. Do not budget for a general saving.
`internal/relayapp/wscompress.go` documents which websocket library khatru actually uses,
which settings it does and does not let us choose, and why no CRIME/BREACH-class concern
applies here; `wscompress_test.go` re-measures the table above on every run.

**Honest NIP-11 limits.** A client that cannot read a relay's real limits discovers them by
sending a request that fails, and over Tor a failed REQ costs a full circuit round-trip — so
`limitation` advertises the numbers the relay actually enforces, derived from the same values
the enforcement reads rather than restated by hand: the websocket frame ceiling
(`max_message_length` — the only limit whose breach kills the connection rather than returning
an error), the weight caps, the event store's real `max_limit`/`default_limit`, and
`restricted_writes`. `min_pow_difficulty` stays 0 deliberately: NIP-11's field is a global
floor, while this relay's PoW bars are per-kind and are advertised in `stiq-capabilities.pow`.

## Deploy as a Tor hidden service

See [`deploy/`](deploy/) for the `torrc`, hardened systemd unit, firewall rules, and the
on-box verification checklist (`.onion`-only reachability, external port scan, no-logs
audit, persistence).

## Test

```sh
go test ./...
```

- `internal/membership` — real RFC 9474 blind round trip (issuer never sees the token),
  wrong-issuer rejection, one-shot binding, persistence across reload.
- `internal/relayapp` — integration test over a **real WebSocket**: bind a member with a
  real credential then post (accepted), non-member rejected, reused/foreign credential
  rejected, disallowed kind rejected.

## Deferred to later steps

- **Step 16** — kind `1059` handling for NIP-17 DMs, with NIP-13 proof-of-work
  (recommended) to keep spam cost high without identifying senders.

## Do not commit key material

`.onion` host keys (`hs_ed25519_secret_key`, `hostname`) and any real `config.json` are
git-ignored. Never commit them.
