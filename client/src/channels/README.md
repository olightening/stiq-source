# src/channels — Telegram-like channels (PLAN.md §3.7 / Steps 20–21)

Account-owned broadcast channels (NIP-28).

- `channels.ts` — `createChannel` (kind 40, owned by the signer's account),
  `broadcastToChannel` (kind 42), `getChannel` / `channelMessages` (read by id from cache),
  `parseChannel` / `messageChannelId`.
- `view.ts` — `buildChannelView(store, channelId, viewer)` → `{channel, messages, isOwner}`.
- `components/ChannelView` — header + broadcasts + owner-only composer.
- `components/CreateChannel` — minimal create form.

`AppRuntime.createChannel` / `postToChannel` sign + publish + cache. The relay permits kind
40/41/42 from bound members and scopes reads via the discovery guard (§3.8) — channels are
found only through a post author's **profile** (`src/profile/`), never a directory.

## Remaining UI wiring (navigation)

The screens (`ProfileScreen`, `ChannelView`, `CreateChannel`) exist and are render-tested.
Threading them into a navigation stack (post author → profile → channel) is left for the
same nav-library decision noted in `src/app/README.md`; the data/view-models are tested.
