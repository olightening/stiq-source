# Organizer service deployment (server)

> **Most people don't need this.** [`deploy/stiq-up.sh`](../../deploy/) provisions the relay
> and this dashboard together in one command, generating all keys on the box. The notes below
> are the manual breakdown of what that installer automates (and the layout it produces).

The organizer dashboard + auto-enrollment mailbox run as a persistent systemd service on the
relay host, so enrollment is automatic and config (tags/limits/roster/voice/guide) can be
published any time. Layout on the server:

```
/opt/stiq-organizer/
  issuer/    # this dir's files + keys (issuer_private.pem, organizer_nostr.json), stiq:stiq, keys 600
  client/    # node_modules the organizer imports via ../client/node_modules
```

## One-time setup

1. Install Node 20 LTS (NodeSource).
2. Copy `issuer/` (with `issuer_private.pem` — gitignored, from the canonical machine) to
   `/opt/stiq-organizer/issuer`, owned `stiq:stiq`, keys `chmod 600`.
3. Create `/opt/stiq-organizer/client/package.json` from `deploy/client-deps.package.json`
   and run `npm install` there (pulls `@cloudflare/blindrsa-ts`, `nostr-tools`, `ws`).
4. `npm install` in `issuer/` (pulls `qrcode`, `socks-proxy-agent`, `ws`, `jsqr`).
5. Install `deploy/stiq-organizer.service` to `/etc/systemd/system/`, `daemon-reload`,
   `systemctl enable --now stiq-organizer`.

## Env (in the unit)

- `RELAY_WS=ws://127.0.0.1:3334` — reach the co-located relay over loopback (no Tor hop).
- `STIQ_ENROLL_POW=12` — MUST equal the relay's `enroll_pow`.
- `STIQ_BIND=127.0.0.1` — dashboard is loopback-only; reach it via
  `ssh -L 7799:127.0.0.1:7799 <host>` then http://localhost:7799. Set `STIQ_BIND` to a
  non-loopback address only with `STIQ_ORG_PASSWORD` set (the unit/code enforce this).

## Verify end-to-end

Mint an invite in the dashboard, then on the server:

```
cd /opt/stiq-organizer/issuer
RELAY_WS=ws://127.0.0.1:3334 STIQ_ENROLL_POW=12 node verify_enroll.mjs <INVITE-CODE>
```

It runs the full member side (9020 → mailbox → 9023 → unblind → 9011 binding) and should end
with `unblinded credential valid: true` and the relay accepting the binding. NOTE: this spends
the invite and binds a throwaway npub.
