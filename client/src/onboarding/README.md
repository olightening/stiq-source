# src/onboarding — anonymous, unlinkable membership (PLAN.md §3.3 / Step 6)

Members are not handed a key. Their app **generates its own key on-device**, and the
organizer issues an *unlinkable* membership credential via a two-way scan. Organizers never
learn which account a member posts under — even if they also run the relay.

## Flow

```
MEMBER (blank app)                         ORGANIZER (offline issuer)
──────────────────                         ─────────────────────────
scan community QR  (relay + issuer key)
Enrollment.begin()
  → generate key ON-DEVICE
  → blind a random token
  → show requestQR (blinded token)  ──────▶ scan it; blind-sign (cmd/issuer)
                                            (never sees the token or npub)
                                   ◀──────── show responseQR (blind signature)
Enrollment.complete(responseQR)
  → unblind → credential (token, sig)
  → build kind-9011 binding event (signed on-device)
→ Session {key, relay, credential, bindingEvent}
```

On first connect the app publishes `bindingEvent`; the relay verifies the credential, marks
the token spent, and binds the npub (relay `internal/membership`). After that the member
posts normally.

## Wire formats

| QR | Format | Direction |
|---|---|---|
| Community bootstrap | `stiq:community:1;<onion>;<issuerPubB64>` | (non-secret) → member |
| Issuance request | `stiq:cred-req:1;<blindedTokenB64>` | member → organizer |
| Issuance response | `stiq:cred-resp:1;<blindSigB64>` | organizer → member |

## Pieces

| File | Role |
|---|---|
| `community.ts` | Parse the non-secret bootstrap QR (onion + issuer key). |
| `blindrsa.ts` | `BlindRsaClient` interface + `MockBlindRsa` (tests). |
| `enrollment.ts` | On-device key gen, two-way exchange, binding-event construction. |
| `session.ts` | `SessionManager` holds the result until Step 7 stores it; `clear()` = duress. |

## Native / integration seam

`blindrsa.ts` is wired in production to **`@cloudflare/blindrsa-ts`** (RFC 9474,
SHA384-PSS-Deterministic — matching the relay's circl verifier). It uses WebCrypto, which on
RN needs a SubtleCrypto polyfill, so the *real* blind-RSA + the TS↔Go interop is validated
on-device against the relay. The relay-side verification (the security-critical half) is
already real-tested in Go (`relay/internal/membership`). The enrollment orchestration,
payload formats, and binding-event construction are tested here with `MockBlindRsa`.
