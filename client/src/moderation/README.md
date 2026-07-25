# src/moderation — moderation (PLAN.md §3.4 / Steps 8–9)

Moderation is **append-only**: posts are never deleted. A moderator's "Remove" emits a
signed NIP-56 report (kind 1984) referencing the offending post; clients then hide it.

- `organizerConfig.ts` — the **dynamic** moderation root of trust. The organizer key (carried
  in the community code, v2) publishes a kind-30078 `stiq:moderators` roster and a
  `stiq:limits` policy. `currentModerators` / `currentLimits` read the latest; granting or
  withdrawing a moderator is just the organizer republishing the roster — no app rebuild.
- `moderators.ts` — `MODERATOR_NPUBS` is now only a **build-time fallback** used when no
  organizer is configured (legacy v1 community). `isModerator` consults the dynamic roster.
- `limits.ts` — client-side quota pre-check (friendly warning). The **relay** is the hard
  enforcer of per-user post/comment/channel caps + the community-wide DM rate.
- `modlog.ts` — builds the unified, searchable/filterable moderation-action log (hides,
  restores, user-hides) joined to the targeted content.
- `report.ts` — `buildRemoveReport(postId, …)` → unsigned kind-1984 event;
  `removePost(signer, postId, …)` signs it via the keystore (`Identity`); `reportedPostId`
  extracts the targeted post id.
- `filter.ts` (Step 9) — `filterFeed(posts, reports)` / `buildModeratedFeed(store)` split
  the cache into `visible` (main feed) and `moderationLog` (hidden posts + the moderator
  npub that hid each). The "Moderation Log" tab renders `moderationLog`; both views come
  from this one pure function. The tabbed UI itself lands with the feed UI (Step 12).

A moderation event flows through the same membership gate as any post — the moderator is a
bound member, so the relay accepts their kind-1984 event (kind 1984 is permitted).

Populate `MODERATOR_NPUBS` per community deployment.
