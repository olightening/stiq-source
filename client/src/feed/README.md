# src/feed — Reddit-style feed + tagged composer (PLAN.md §2 / Step 12)

The single-community feed and the post composer. Data layer is fully tested; the RN
components are real and render-tested via react-test-renderer.

## Data layer

- `tags.ts` — NIP-12 `t` tag handling: `normalizeTag` (strip `#`, lowercase, trim),
  `normalizeTags` (dedupe), `postTags(event)` (extract).
- `compose.ts` — `buildPost(content, tags)` → unsigned kind-1 event with normalized `t`
  tags (throws on empty); `publishPost(signer, …)` signs it via the keystore.
- `feed.ts` — `buildFeed(store)` applies the Step-9 moderation filter and maps cached events
  to `FeedItem`s (npub + content + tags), returning the main list **and** the moderation log
  from one source. `itemsWithTag` is the basis for the Step-15 tag bar.
- `voting.ts` (Step 13) — `castVote` emits a NIP-25 kind-7 reaction (`+`/`-`); `scoreForPost`
  / `scoreReactions` aggregate the score from cached reactions (one latest vote per pubkey),
  so it survives restarts; `myVote` reports the viewer's current vote.

## Components (presentation)

- `components/PostCard.tsx` — one feed card (author npub, content, tag chips).
- `components/FeedList.tsx` — the main list (FlatList of cards; empty state).
- `components/Composer.tsx` — content input + flair tag picker; calls `onSubmit(content, tags)`.
- `components/VoteBar.tsx` — up/down arrows + live score (Step 13).

## Still to come

- Threaded comments (Step 14), tag bar + Hot/New/Top sort (Step 15).
- Wiring the feed + composer + Moderation Log into app navigation, and publishing composed
  posts through the Tor relay client (Step 5) once connected.
