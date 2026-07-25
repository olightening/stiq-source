# Secure links & visual content (PLAN.md §3.2)

The app's anonymity rests on one invariant: **every remote byte goes through Tor, never the
OS network stack.** Plain `<Image source={{uri}}>`, `fetch()`, and `react-native-webview`
all use the OS stack and would leak the user's real IP the instant a post is viewed or a link
opened. This subsystem closes that gap for links and images.

## The single chokepoint

`src/media/torHttp.ts` (`torFetch`) is the only sanctioned way to pull remote bytes. It:

- requires a live Tor circuit (`requireTorTransport`) — throws when offline, no clearnet fallback;
- refuses non-`.onion` hosts when `REQUIRE_ONION_MEDIA`, re-checked on every redirect hop;
- enforces a byte cap, a pinned generic User-Agent, and **never** sends `Referer`/`Cookie`;
- isolates each logical stream on its own Tor circuit (SOCKS user/pass → `IsolateSOCKSAuth`).

It's backed by the native `StiqHttp` module (Android `StiqHttpModule.kt`, iOS
`StiqHttpModule.swift`), which does a hand-rolled SOCKS5 CONNECT with **remote** DNS (ATYP=domain,
no DNS leak) + TLS for https — the same proven pattern as `StiqSocket`. Redirects are followed in
TS so policy applies to every hop; the native module does exactly one request.

Components reach this through the `MediaService` singleton (`src/media/mediaService.ts`), bound to
the live `TorManager` in `App.tsx`. When it's unset (tests, or a build without the native modules)
components degrade to a safe offline state — they never fall back to the OS stack.

## Opening links

`SafeWebView` (`src/ui/SafeWebView.tsx`):

1. **Reader-mode (default, only mode on iOS):** `readPage` fetches the HTML once over Tor and
   `extractReadable` (`src/reader/readerMode.ts`) renders just the title + text. No live page →
   no subresource requests, no scripts, no fingerprint surface.
2. **Opt-in full page (Android only):** routes a hardened, JS-disabled, incognito WebView through
   Tor's `HTTPTunnelPort` via the native `StiqWebProxy` (`androidx.webkit` ProxyController, **no**
   `addDirect()` fallback). iOS can't SOCKS-proxy WKWebView, so it stays reader-only.

The `LinkChip` dialog classifies the destination (🧅 onion stays inside Tor vs 🌐 clearnet exits
via a node), warns on punycode/IDN homographs, strips tracking params (`stripTrackingParams`), and
opens the cleaned URL. URL helpers live in `src/util/url.ts`.

## Visual content — the tiers

- **Tier 0 (zero network):** `BlurhashView` decodes an embedded NIP-94 BlurHash locally
  (`src/media/blurhash.ts`); `Identicon`/`GenerativeBanner` derive avatars/banners from a
  pubkey/post-id hash (`src/media/identicon.ts`). No image is hosted or fetched.
- **Tier 1 (fetch over Tor):** `ImagePlaceholderCard` shows the BlurHash by default and only on an
  explicit tap fetches the bytes over Tor (`fetchImage`), rendering from an in-memory `data:` URI.
- **Tier 2 (sanitize):** `fetchImage` sniffs magic bytes (allow-list), rejects animated/oversized
  files, and verifies the `imeta` sha256 (`src/media/image.ts`). Outbound, native `StiqImage`
  re-encodes to strip EXIF/GPS/ICC.
- **Tier 3 (upload):** the composer picks an image → `StiqImage` sanitizes + hashes + thumbnails →
  `encodeBlurhash` → `uploadToBlossom` PUTs it to a Blossom host over Tor (`src/media/upload.ts`).
  The relay stores no media; the post carries a NIP-94 `imeta` tag (url + sha256 + BlurHash).

## Native seams to finish on-device

All TS logic is unit-tested; the native modules compile but are unverified without a device build:

| Module | Android | iOS | Purpose |
|---|---|---|---|
| `StiqHttp` | `StiqHttpModule.kt` ✓ registered | `native/ios/StiqHttpModule.swift` | HTTP(S) over Tor SOCKS5 |
| `StiqWebProxy` | `StiqWebProxyModule.kt` ✓ + `androidx.webkit` dep | `native/ios/StiqWebProxyModule.swift` (reports unsupported) | full-page WebView via Tor HTTP tunnel |
| `StiqImage` | `StiqImageModule.kt` ✓ registered | `native/ios/StiqImageModule.swift` | decode → EXIF-strip → re-encode + thumbnail |
| `StiqTor.getHttpTunnelPort` | added to `StiqTorModule.kt` | — | exposes Tor `HTTPTunnelPort` to JS |

## Config (`src/config.ts`)

`MEDIA_BLOSSOM_ENDPOINT` (empty = uploads disabled; set an `.onion` host),
`REQUIRE_ONION_MEDIA`, `MEDIA_MAX_BYTES`, `MEDIA_ALLOWED_MIME`, `MEDIA_FETCH_TIMEOUT_MS`,
`READER_MODE_DEFAULT`, `ALLOW_FULL_PAGE_WEBVIEW`, `LINK_MAX_REDIRECTS`.

## Guardrail

`src/media/networkGuards.test.ts` fails CI if any code reintroduces a leak: a `react-native-webview`
import outside `SafeWebView`, an `<Image>` pointed at a remote http(s) URL, or a raw `fetch()`
anywhere but the documented pre-Tor bridge bootstrap.
