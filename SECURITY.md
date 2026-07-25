# Security policy

STIQ is used by communities whose members can be harmed if the software fails. Please
treat findings accordingly.

## Reporting a vulnerability

**Do not open a public issue for a security bug.** Use GitHub's private reporting:
**Security → Report a vulnerability** on this repository.

Please include what you need to make the report actionable — affected component
(`client/`, `relay/`, `issuer/`), version or commit, reproduction steps, and what an
attacker gains. If you have a suggested fix, even better.

We will acknowledge receipt and keep you updated as we work the issue. Please give us a
reasonable window to ship a fix before publishing.

## Scope

In scope:

- **Deanonymization** — anything that lets the relay, the organizer, a network observer,
  or another member link a post, vote, comment, or DM to a member's identity.
- **Key material** — extraction of the on-device `nsec`, the membership credential, or
  content-encryption keys from the client, including via the lock/PIN path.
- **Membership bypass** — publishing to or reading from a community without a valid,
  unrevoked credential.
- **Token forgery** — minting, replaying, or double-spending blind-signed tokens.
- **Tor leaks** — any traffic that leaves the device outside the bundled Tor circuit.

Out of scope:

- Findings that require a compromised or rooted device with an already-unlocked app.
- Denial of service against a relay by an authenticated member (rate limits are
  organizer-tunable policy, not a security boundary).
- Reports against a third-party community's deployment rather than this codebase. Contact
  that community's organizer.

## Things that look like bugs but are design

Read these before reporting:

- **Moderation is advisory, not enforced.** The relay is deliberately blind to authorship,
  so it *cannot* enforce a ban — it has no way to tell whose event it is. Hides and bans
  are advisories that conforming clients honor. A modified client can ignore them and keep
  posting. This is the cost of the relay not knowing who anyone is, and it is intentional.
- **The relay stores ciphertext it cannot read.** Bodies are sealed; the relay is a dumb
  append-only store plus a membership gate.
- **`issuer/organizer_nostr.json` is a committed private key.** It is a deliberately burnt
  test fixture derived from a public seed documented in the file itself. It is not a
  secret, and no real deployment may use it — a real organizer key is generated on the
  server by `deploy/stiq-up.sh` and never leaves it.

## Operators

If you run a STIQ community, the security of your members depends on your deployment, not
only on this code. At minimum: keep `issuer/organizer_nostr.json`, `issuer/invites.json`,
your relay's `hs_ed25519_secret_key`, and any `.pem` key material off version control and
off shared machines. The repository `.gitignore` is written to help with that; it is not a
substitute for checking.
