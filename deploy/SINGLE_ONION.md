# Single-onion mode: compatibility gate, flip, and rollback

Single-onion mode (`HiddenServiceNonAnonymousMode 1` + `HiddenServiceSingleHopMode 1`) drops the
service side of the rendezvous from three hops to one. It cuts latency noticeably. It also
**gives up the server's location anonymity** — the relay host becomes as exposed as any clearnet
server. Clients keep their full three-hop anonymity either way.

That trade is only acceptable if you already treat the relay host as identifiable. STIQ's
default is off, and `deploy/stiq-up.sh` will auto-degrade to standard onion mode rather than fail
if your tor rejects the combination.

**This never touches `hs_ed25519_secret_key`, so your `.onion` address does not change.** Every
join code and link your members hold keeps working across a flip or a rollback.

## Why there is a gate at all

STIQ relays use **client authorization** (`authorized_clients/`) for members-only communities.
Tor documents client-auth and single-onion mode independently, but not their interaction. If they
turn out to be incompatible on your tor build, the failure mode is bad in both directions: either
the onion silently becomes reachable *without* a key, or key-holding members are locked out.

So: prove it on your own box, on a throwaway service, before touching the real relay.

---

## Part (a) — compatibility gate (throwaway; do this first)

Everything here happens in a scratch directory. It never touches the real relay's config, keys,
or hidden-service state.

### a.1 — Stand up a throwaway single-onion + client-auth service

```sh
# A fresh, disposable HS dir — NOT /var/lib/tor/stiq-relay.
install -d -o debian-tor -g debian-tor -m 0700 /var/lib/tor/gate-test
install -d -o debian-tor -g debian-tor -m 0700 /var/lib/tor/gate-test/authorized_clients

# Mint a throwaway x25519 client-auth keypair (the same recipe stiq-up.sh uses).
openssl genpkey -algorithm x25519 -out /tmp/gate-test-client.pem
PRIV_B32="$(openssl pkey -in /tmp/gate-test-client.pem -outform DER | tail -c 32 | base32 | tr -d '=')"
PUB_B32="$(openssl pkey -in /tmp/gate-test-client.pem -pubout -outform DER | tail -c 32 | base32 | tr -d '=')"
echo "priv=$PRIV_B32"
echo "pub=$PUB_B32"

printf 'descriptor:x25519:%s\n' "$PUB_B32" > /var/lib/tor/gate-test/authorized_clients/gate.auth
chown debian-tor:debian-tor /var/lib/tor/gate-test/authorized_clients/gate.auth
chmod 600 /var/lib/tor/gate-test/authorized_clients/gate.auth

# A trivial loopback backend. Use python3's http.server, NOT `nc -lk`: it speaks real HTTP, so
# success is an unambiguous 200 rather than "some bytes appeared in a log", and it survives more
# than one connection.
setsid nohup python3 -m http.server 18080 --bind 127.0.0.1 >/tmp/gate-test-http.log 2>&1 </dev/null &
echo $! > /tmp/gate-test-http.pid

# VERIFY THE BACKEND IS UP before trusting anything below. This is not a formality: if it died
# with EADDRINUSE, every client fails with a SOCKS error that looks EXACTLY like an onion/auth
# failure — which reads a PASSING tor as a FAILING one and aborts a perfectly good flip.
ss -ltn | grep 127.0.0.1:18080 || echo "backend NOT up — fix this before trusting any result below"
curl -s -o /dev/null -w '%{http_code}\n' -m 5 http://127.0.0.1:18080/   # expect: 200

cat > /etc/tor/torrc.d/zzz-gate-test.conf <<'EOF'
# THROWAWAY — compatibility gate only. Remove after Part (a), before Part (b).
SocksPort 0
HiddenServiceNonAnonymousMode 1
HiddenServiceSingleHopMode 1
HiddenServiceDir /var/lib/tor/gate-test/
HiddenServiceVersion 3
HiddenServicePort 80 127.0.0.1:18080
EOF
chown debian-tor:debian-tor /etc/tor/torrc.d/zzz-gate-test.conf
```

### a.2 — Does tor accept the combination at all?

```sh
tor --verify-config
```

**If it fails** — non-zero exit, or any error mentioning `SingleHopMode`, `NonAnonymousMode`,
`ClientAuth`, or the HS dir — **stop.** This is exactly what the gate exists to catch. Record the
tor version and the error text, tear down (a.4), and do not proceed. Run the real deploy with
`sudo bash deploy/stiq-up.sh --no-single-onion`, or simply leave the box on its current mode.
(A genuine incompatibility is worth reporting upstream to the Tor Project.)

**If it passes:**

```sh
systemctl reload tor@default    # or restart, if reload doesn't pick up new HS dirs
sleep 5
GATE_ONION="$(cat /var/lib/tor/gate-test/hostname)"
echo "$GATE_ONION"
```

If `hostname` never appears after ~15s, check `journalctl -u tor@default -n 80` — same failure
class, discovered slightly later (config validated, but the service didn't come up).

### a.3 — Prove client auth still gates access

Test from a **separate** machine, or Tor Browser on your laptop — not from the relay box.

1. **Keyless attempt — expect failure.**
   ```sh
   torsocks curl -m 20 -sv http://$GATE_ONION/ 2>&1 | tail -20
   ```
   Expect a descriptor-fetch/rendezvous failure: without the auth key, tor cannot even decrypt
   the published descriptor. This confirms the onion is not accidentally public.

2. **Key-holding attempt — expect success.** Add the throwaway private key to your test client's
   `ClientOnionAuthDir` as a `.auth_private` file containing
   `<GATE_ONION-without-.onion>:descriptor:x25519:<PRIV_B32 from a.1>`, or paste it into Tor
   Browser when prompted. Then repeat the curl. Expect **HTTP 200**.

**Read tor's log, not curl's exit code.** curl reports every SOCKS problem as a generic proxy
failure, so a dead backend and a refused descriptor look identical from outside. At `Log info`
the client log is unambiguous:

- `Fail to decrypt descriptor …` → auth genuinely blocked it.
- `Got RENDEZVOUS2 cell` / `rend joined circ` → **auth succeeded**; anything failing after that
  point is your backend, not tor.

**Before concluding "the key-holding client is refused", run the control.** That verdict aborts
the flip, so make it survive one cheap check: re-run the same client against the same hidden
service with single-onion **off** (drop the two mode lines, keep the same `HiddenServiceDir` and
auth key).

- Still refused with the mode off → your **rig** is broken (dead backend, bad key derivation,
  malformed `.auth_private`), not tor. Fix it and re-run.
- Works with the mode off but not on → **a real incompatibility.** Abort the flip.

**Gate result:** both checks behave as expected → proceed. Either behaves unexpectedly (keyless
client connects, or the key-holder is also refused) → **stop; do not flip the real relay.**

### a.4 — Tear down the throwaway (always, pass or fail)

```sh
kill "$(cat /tmp/gate-test-http.pid)" 2>/dev/null
rm -f /etc/tor/torrc.d/zzz-gate-test.conf
rm -rf /var/lib/tor/gate-test
rm -f /tmp/gate-test-client.pem /tmp/gate-test-http.log /tmp/gate-test-http.pid
systemctl reload tor@default
```

Confirm the real relay onion is untouched (it never should have been, but confirm):

```sh
cat /var/lib/tor/stiq-relay/hostname   # must be UNCHANGED
```

---

## Part (b) — flip production

Only if Part (a) passed cleanly.

Record a latency baseline first, so "it feels faster" becomes a number:

```sh
# BEFORE — time a few requests through the onion from a client machine
for i in 1 2 3 4 5; do torsocks curl -m 30 -s -o /dev/null -w '%{time_total}\n' http://<relay-onion>/; done
```

Then flip and verify:

```sh
sudo bash deploy/flip-single-onion.sh
```

That script performs the flip and the verification below. Check by hand if you prefer:

```sh
# 1. The .onion is UNCHANGED — load-bearing; every saved join code depends on it
cat /var/lib/tor/stiq-relay/hostname

# 2. tor is healthy and single-onion is actually live
sudo bash relay/deploy/tor_defense_check.sh
#    expect: SINGLE_ONION_MODE=on, RELAY_ONION_DESCRIPTOR=published, VERIFY_CONFIG=ok

# 3. Members can still reach the relay — test enrolment and a post from a real client
```

Re-run the latency loop afterwards and compare.

---

## Part (c) — rollback

Rollback is removing the two mode lines and restarting. It is safe: the onion address is
unchanged, because the flip never touched the secret key.

```sh
sudo bash deploy/flip-single-onion.sh --rollback   # or edit the torrc drop-in by hand
sudo systemctl restart tor@default
```

**Restart, don't reload.** tor does not un-apply `SocksPort 0` on a reload. A config file saying
`SocksPort 9050` proves nothing if the process never restarted — verify the port actually came
back, on the right instance:

```sh
ss -ltnp | grep 9050          # must be held by the MAIN tor instance
sudo bash relay/deploy/tor_defense_check.sh
```

`tor_defense_check.sh` fails loudly on exactly this mismatch: config claiming one thing while the
running process does another.
