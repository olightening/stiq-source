# src/dm — encrypted direct messages (PLAN.md §3, §4.1 / Step 16)

NIP-17 sealed DMs via nostr-tools (seal = NIP-44 encryption, gift-wrap = NIP-59). The gift
wrap (kind 1059) is signed by an **ephemeral** key, so the relay and any observer never learn
the sender — only the recipient's key opens it.

- `dm.ts` — `sealDM(senderSK, recipientPub, text)` → kind-1059 wrap; `openDM(wrap, mySK)` →
  `{sender, text}`; `readInbox(wraps, mySK, cache?)` decrypts only our wraps (others are
  reported in `failedIds` for age-based pruning, not thrown) and returns `{messages, failedIds}`.
  A `ConversationKeyCache` (`makeConversationKeyCache()`) memoises the per-sender NIP-44 inner-seal
  conversation key so a repeat sender derives its ECDH once, not per wrap (efficiency finding #2);
  the outer wrap key stays per-wrap (ephemeral). Production drives `decryptInboxChunk` directly so
  it can re-enter the key guard and yield the JS thread between 32-wrap chunks (finding #1).
  Decrypted plaintext is **never persisted** — only the sealed wraps live in the cache (PLAN.md
  §4.1); they decrypt in memory on demand. The persisted *negative* cache holds only public wrap
  ids proven undecryptable-for-us (finding #4), never plaintext.
- `nip13.ts` — `mineEvent(event, difficulty)` mines a `nonce` tag to the target leading-zero
  bits; `countLeadingZeroBits`. This is how a sender pays the relay's DM proof-of-work gate
  (the §4.1 resolution; the relay verifies it in `relay/internal/membership/pow.go`).

## NIP-13 PoW — RESOLVED

PoW is wired. `identity.ts#sealDM()` routes through `createDmSeal` (builds the inner seal
using the sender's key, locked behind `useSecretKey`) + `mineGiftWrap` (assembles the outer
kind-1059 wrap with a fixed-width nonce placeholder and mines to `DM_POW_DIFFICULTY = 20`).
The outer wrap is signed by an ephemeral key, so mining runs outside the key guard.

The bare `sealDM()` exported from `dm.ts` (wraps via `nostr-tools/nip17.wrapEvent`, no PoW)
is kept only for test fixtures that don't hit the relay — it is never on the send path.

## Inbox (Step 17)

- `conversations.ts` — `buildConversations(messages)` groups decrypted DMs by peer (newest
  conversation first). `Identity.readInbox(wraps)` does the decryption via the keystore's
  transient `useSecretKey`, so plaintext never persists. `AppRuntime.sendDM`/`refreshInbox`
  wire it in; the duress wipe clears the gift wraps with the cache (tested).
- `components/InboxList`, `components/ConversationView` — the Messages tab UI.

## Native / on-device

- WebCrypto/randomness for sealing needs the RN polyfill (same as elsewhere).
