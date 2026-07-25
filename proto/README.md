# proto/

Protocol notes shared by `client/` and `relay/`. Nostr event kinds and NIPs this
platform uses. No proprietary extensions — every behavior maps to a published NIP.

## Event kinds in use

| Kind | Meaning | NIP | Produced by | Notes |
|---|---|---|---|---|
| `1` | Post (single-community feed item) | NIP-01 | Client | Carries `t` tags (NIP-12) for flair-style tags. |
| `7` | Reaction (up/down vote) | NIP-25 | Client | `+` / `-` content; score aggregated client-side. |
| `1111` / reply `1` | Threaded comment | NIP-22 / NIP-10 | Client | Replies reference parent via `e` tags. |
| `1984` | Moderation report ("remove" / "restore") | NIP-56 | Moderator client | References offending post/comment `id`; filtered client-side. A `['stiq-action','restore']` tag marks an un-hide; latest action per target wins. |
| `1059` | Gift wrap (sealed DM envelope) | NIP-17 | Client | Outer signer is an **ephemeral** key — see whitelist note. |
| `9011` | Membership binding | stiq (§3.3) | Client (once) | Binds a member's on-device npub to a blind credential. Tags: `stiq_token`, `stiq_sig` (base64). Not subscribed to / not shown in feeds. |
| `10000` | Mute list | NIP-51 | Owner / Moderator | Content owner's commenter block list. When authored by a **current moderator** it is honored **globally** to hide all of a user's content ("hide user", §3.4). |
| `30078` | Organizer moderation config | NIP-78 | Organizer key | Addressable by `d` tag, signed by the organizer key (community-code v2). `d=stiq:moderators` → moderator roster (`p` tags, grant/withdraw at runtime); `d=stiq:limits` → rate-limit policy JSON. Relay + clients honor these only from the organizer key. |
| `13` / `14` | Seal / chat (inside the gift wrap) | NIP-17 / NIP-44 | Client | NIP-44 encryption; never leaves the device decrypted. |

## Tags

- **Topic/flair tags:** lowercase `t` tags (NIP-12), e.g. `["t", "announcements"]`.
- **Reply threading:** `e` / `p` tags per NIP-10.

## Whitelist vs NIP-17 (critical — PLAN.md §4.1)

The relay's `allowed_pubkeys` whitelist rejects events from non-whitelisted signers, but
NIP-17 gift wraps (`1059`) are signed by **ephemeral random** keys to hide the sender.
A strict whitelist therefore rejects **all DMs**. Resolution options:

- **(a)** Exempt kind `1059` from the whitelist (reopens spam/DDoS surface).
- **(b) [recommended]** Require NIP-13 proof-of-work on `1059` events.
- **(c)** Rate-limit `1059` per Tor circuit.

Decide before implementing Step 16.

## Moderation & rate limits (§3.4)

- **Trust root:** the organizer holds one Nostr key, carried in the community code (v2). It
  signs kind-30078 `stiq:moderators` (roster) and `stiq:limits` (policy). Granting/withdrawing
  a moderator = republishing the roster — no app rebuild.
- **Hide actions:** moderators hide posts/comments via kind-1984 (and restore with the
  `stiq-action=restore` tag), and hide users by adding them to their kind-10000 mute list
  (honored globally). All append-only; the searchable Moderation Log reconstructs the timeline.
- **Rate limits (relay-enforced):** per-user caps on posts (kind 1 root), comments (kind 1111 +
  hybrid kind-1 `stiq-comment`), and channel messages (kind 42 / 1311), across daily/weekly/
  monthly windows. DMs (kind 1059) are ephemeral-signed so they can't be attributed to a user —
  they get a single **community-wide** per-minute cap instead. Clients pre-warn; the relay is
  the hard enforcer (bounds spam + storage cost).

## Sorting (client-side, over cached events)

- **New** — by `created_at` descending.
- **Top** — by aggregated reaction score.
- **Hot** — score with a recency-decay weighting.
