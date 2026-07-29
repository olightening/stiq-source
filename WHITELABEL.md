# Whitelabeling STIQ

You can rebrand STIQ — name, icon, colours, bundle identifier — and run it as your own app.
This document exists mainly to stop you doing it the obvious way, which breaks the protocol.

## Read this first: `stiq` is two different things

The string `stiq` appears in **382 files** under `client/src`. Most of them are **not branding**.

STIQ's wire protocol namespaces its Nostr events and embeds under a literal `stiq:` prefix —
kind-30078 parameterized-replaceable `d` tags, embed URI schemes, and credential message types.
There are **36 distinct** such identifiers, including:

```
stiq:community      stiq:token-keys     stiq:draft        stiq:content-epoch
stiq:cred-req       stiq:cred-resp      stiq:log-page     stiq:gov
stiq:featured       stiq:bridges        stiq:events       stiq:guide
stiq:member-roll
```

These are **on-the-wire contract**, shared by the client, the relay, and the organizer
dashboard. Rename them and your client stops interoperating: it will publish events the relay's
gates don't recognise and fail to read events other clients wrote. Your fork silently becomes a
separate, incompatible network.

> **A project-wide find-and-replace of `stiq` will break your app.** Not at build time — at
> runtime, in the field, after everything looked fine.

Rebrand the presentation layer. Leave the protocol namespace alone.

## What to actually change

Everything a rebrand needs is in these files. Nothing else needs to be touched.

### Identity

| File | What to change |
|---|---|
| `client/app.json` | `name` and `displayName` |
| `client/android/app/build.gradle` | `namespace` and `applicationId` (both `com.stiq.client`) |
| `client/android/app/src/main/res/values/strings.xml` | `app_name` |
| `client/ios/stiq/Info.plist` | `CFBundleDisplayName` |
| `client/ios/stiq.xcodeproj/project.pbxproj` | `PRODUCT_BUNDLE_IDENTIFIER` — **four** occurrences: `com.stiq.client` in the app's Debug and Release, `com.stiq.client.tests` in the test bundle's |

Changing `applicationId` makes your build a *different app* to Android: it installs alongside
STIQ rather than upgrading it, and it cannot read an existing STIQ install's data. That is
usually what you want for a fork. If you are shipping an upgrade to an existing community, keep
the original `applicationId`. The same is true of the iOS bundle identifier.

> **iOS signing is yours to configure.** The identifiers are set, but the project carries no
> `DEVELOPMENT_TEAM` and no `CODE_SIGN_STYLE` — it cannot be signed, distributed, or submitted
> until you add yours (Xcode → *Signing & Capabilities*). CI builds iOS with signing disabled, so
> it will stay green whether or not your signing is right. The iOS app has only ever been
> exercised on the simulator.

### Appearance

| File | What to change |
|---|---|
| `client/src/ui/theme.ts` | `darkColors` — the whole palette. Also `space`, `radius`, `type`, `weight` if you want different metrics |
| `client/android/app/src/main/res/values/colors.xml` | `splash_background` and `status_bar_background` — **must match `darkColors.bg`** |
| `client/android/app/src/main/res/mipmap-*/` | launcher icons, all five densities |
| `client/ios/stiq/Images.xcassets/AppIcon.appiconset/` | iOS app icon |
| `client/assets/` | in-app imagery |

The app is **dark-only** — there is no light palette and no theme toggle, so `darkColors` is the
single source of truth. `colors.xml` duplicates the background colour for the native launch
window, which paints before JS starts; if you change one and not the other you get a visible
colour flash on every cold start.

### Visible text

The brand appears as a literal in the UI — most visibly the `Stiq.` wordmark in the main screen
header, which also opens Settings. There are **525 occurrences of `Stiq` across 122 files** in
`client/src`; the user-visible ones are concentrated in `src/app/screens/`.

`client/src/config.ts` exports `APP_NAME = 'stiq'`, but **nothing reads it** — it is not wired to
the UI. Don't assume changing it renames anything. Either replace the literals, or wire
`APP_NAME` through and change it in one place.

When you go through the literals, keep the distinction from the top of this document in mind:
`Stiq.` in a `<Text>` is branding; `'stiq:community'` in a tag builder is protocol.

## Your community's identity is not in this repo

Rebranding the app is separate from running a community. Your relay `.onion`, issuer RSA key,
organizer Nostr key, invite codes, and moderator roster are all generated on **your** server by
`deploy/stiq-up.sh` and never appear in source. See [`deploy/README.md`](deploy/README.md).

Two consequences worth stating plainly:

- A rebranded client is still a *STIQ-protocol* client. It can join any STIQ community whose
  join code it is given, including ones you don't run.
- Nothing in this repository reports to, or depends on, any community — including the one it was
  originally built for.

### Moderators are not a build-time setting

`client/src/moderation/moderators.ts` exports `MODERATOR_NPUBS`, and its comment invites you to
fill it in. **Don't.** It ships empty and is only a fallback for communities that predate the
organizer key. The live trust root is your organizer Nostr key: it publishes the roster as a
signed kind-30078 `d="stiq:moderators"` event, so adding or removing a moderator is a republish
from the dashboard, with **no app rebuild** (PLAN.md §3.4).

## Before you ship

- **Generate your own signing keystore first.** This is the one decision you cannot revisit: once
  members install a build signed with the repo's debug keystore, an APK signed with your key is
  refused as an update, and reinstalling destroys their identity. See
  [`BUILDING.md`](BUILDING.md).
- `cd client && npm run verify-deps` — see [`BUILDING.md`](BUILDING.md). This guards a
  dependency trap that produces an app which builds cleanly and **cannot enrol anyone**.
- Build `assembleRelease`, never `assembleDebug`, for anything you hand to a real user.
- Bump `versionCode` *and* `versionName` in `client/android/app/build.gradle`.
- If you changed protocol identifiers by accident, you will not find out from the test suite —
  you will find out when two devices fail to see each other. Diff your changes against this
  document's file list before releasing.
