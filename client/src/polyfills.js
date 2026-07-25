/**
 * Global polyfills — imported as the FIRST statement in index.js so these
 * are set before any library code runs. No `import` statements here so
 * Babel does not hoist deps above the polyfill assignments.
 *
 * Hermes on some React Native 0.76 builds does not expose TextDecoder /
 * TextEncoder in the global scope; @noble/hashes and nostr-tools require them
 * for UTF-8 string ↔ Uint8Array conversion during Schnorr signing and event
 * serialisation.
 */

// Full WHATWG-compliant URL — the Hermes built-in URL class throws
// "not implemented" for most property getters (protocol, pathname, search…).
// whatwg-url is already in node_modules as a transitive dep; we replace
// global.URL when the built-in is broken.
//
// The probe must exercise the GETTERS real code relies on, not just the constructor: Hermes ships a
// URL whose constructor (and sometimes `.protocol`) succeeds while `.hostname` / `.pathname` /
// `.search` / `.searchParams` throw "not implemented", so a constructor-only probe passes yet real
// parsing still fails. We test each accessor and require the right value before trusting the built-in.
// (The app's own parsers — src/util/url.ts, onboarding/join, channels/invite, App's deep-link router
// — are string-based and never depend on this; this polyfill is defense-in-depth for library code.)
(function () {
  function urlIsUsable() {
    try {
      var t = new URL('https://user@example.com:8443/a/b?x=1&y=2#z');
      return (
        t.protocol === 'https:' &&
        t.hostname === 'example.com' &&
        t.pathname === '/a/b' &&
        t.search === '?x=1&y=2' &&
        !!t.searchParams &&
        t.searchParams.get('x') === '1'
      );
    } catch (_) {
      return false;
    }
  }
  if (!urlIsUsable()) {
    // LAZY (mirrors the crypto.subtle one-shot getter below): whatwg-url drags in a ~260KB tr46 IDNA
    // mapping table (JSON.parsed at module load) + punycode. NOTHING on the launch/connect path reads
    // global.URL — the app's own parsers (util/url.ts, onboarding/join, channels/invite, the deep-link
    // router) are all pure string ops — so require()ing it eagerly was pure per-launch startup cost for
    // defense-in-depth that most launches never exercise. Install a one-shot getter that loads whatwg-url
    // only on the FIRST read of global.URL and then collapses to the resolved constructor, so the table
    // loads solely if some library actually touches URL. Byte-identical for any consumer that does.
    var builtinURL = global.URL;
    var loadWhatwgUrl = function () {
      try {
        return require('whatwg-url').URL;
      } catch (_2) {
        return builtinURL; // whatwg-url unavailable — keep the built-in stub, exactly as the eager path did.
      }
    };
    try {
      Object.defineProperty(global, 'URL', {
        configurable: true,
        enumerable: true,
        get: function () {
          var U = loadWhatwgUrl();
          // Collapse the accessor to a plain value so later reads skip the getter entirely.
          try {
            Object.defineProperty(global, 'URL', {
              value: U,
              configurable: true,
              writable: true,
              enumerable: true,
            });
          } catch (_e) {
            /* leave the getter in place if redefinition is blocked */
          }
          return U;
        },
      });
    } catch (_e2) {
      // global.URL is non-configurable — fall back to the eager assignment (correct, just not lazy).
      try {
        global.URL = loadWhatwgUrl();
      } catch (_e3) {
        /* whatwg-url unavailable — the app's Hermes-safe string parsers handle URLs without it. */
      }
    }
  }
})();

// Polyfill globalThis.crypto.getRandomValues for Hermes (used by @noble/hashes,
// nostr-tools, and our blind-RSA blinding factor generation).
// Must be the first import so all downstream libs see it immediately.
require('react-native-get-random-values');

// Install a pure-JS global.crypto.subtle for Hermes (which ships no SubtleCrypto). The blind-RSA
// enrollment client (@cloudflare/blindrsa-ts, RFC 9474 SHA384-PSS-Deterministic — matches the
// relay's cloudflare/circl verifier) calls crypto.subtle.importKey/exportKey/digest/verify; without
// them onboarding's credential exchange throws "Cannot read property 'importKey' of undefined". We
// back exactly those four ops with @noble/hashes + BigInt (see onboarding/webcryptoShim.ts) rather
// than a native module: react-native-quick-crypto 0.7.9 leaves RSA-PSS verify unimplemented (so
// finalize() would throw) and its OpenSSL .so collides with op-sqlite's. The shim is pure JS, so it
// behaves identically here and under Jest, where it is round-trip tested against Node's WebCrypto.
//
// LAZY: the shim is a 449-line module that pulls in 3 @noble hash modules, yet it is ONLY exercised
// during credential enrollment (its sole consumer is onboarding/blindrsaReal.ts). Loading it at every
// app launch is pure startup cost for the >99% of launches that never enroll. So instead of requiring
// it eagerly, we install a one-shot GETTER on global.crypto.subtle: the shim module is require()d the
// first time anything reads crypto.subtle (Metro supports inline require), then the getter is replaced
// with the resolved value so later reads are direct. A host that already provides a real SubtleCrypto
// (e.g. Node under Jest) is left untouched — same guard the shim's installWebCryptoShim() applied.
// Must run after react-native-get-random-values (above) so global.crypto.getRandomValues exists.
(function () {
  var g = global;
  if (!g.crypto) {
    try {
      g.crypto = {};
    } catch (_e) {
      return; // frozen global with no crypto — nothing we can do; enrollment will error clearly.
    }
  }
  if (g.crypto.subtle) {
    return; // a real SubtleCrypto is already available (Node/Jest, or a future native impl).
  }
  var resolved; // memoized shim, loaded on first access.
  function loadSubtle() {
    if (resolved === undefined) {
      // Fall back to `null` on failure so we require() at most once and blind-RSA surfaces a clear
      // "importKey of null" rather than re-throwing the module-load error on every access.
      try {
        resolved = require('./onboarding/webcryptoShim').webCryptoShimSubtle;
      } catch (_e) {
        resolved = null;
      }
    }
    return resolved;
  }
  try {
    Object.defineProperty(g.crypto, 'subtle', {
      configurable: true,
      enumerable: true,
      get: function () {
        var s = loadSubtle();
        // Collapse the accessor to a plain value so subsequent reads skip the getter entirely.
        try {
          Object.defineProperty(g.crypto, 'subtle', {
            value: s,
            configurable: true,
            writable: true,
            enumerable: true,
          });
        } catch (_e) {
          /* leave the getter in place if redefinition is blocked */
        }
        return s;
      },
    });
  } catch (_e) {
    // crypto exists but is non-extensible — fall back to eager install so enrollment still works.
    try {
      g.crypto.subtle = require('./onboarding/webcryptoShim').webCryptoShimSubtle;
    } catch (_e2) {
      /* enrollment will surface a clear error */
    }
  }
})();

// RFC 3629 UTF-8 decode (all Unicode planes including surrogates).
if (typeof TextDecoder === 'undefined') {
  global.TextDecoder = class TextDecoder {
    decode(input) {
      if (input == null) return '';
      const bytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      let out = '';
      let i = 0;
      while (i < bytes.length) {
        const b0 = bytes[i++];
        if (b0 < 0x80) {
          out += String.fromCharCode(b0);
        } else if ((b0 & 0xe0) === 0xc0) {
          out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f));
        } else if ((b0 & 0xf0) === 0xe0) {
          const b1 = bytes[i++] & 0x3f;
          const b2 = bytes[i++] & 0x3f;
          out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
        } else {
          const b1 = bytes[i++] & 0x3f;
          const b2 = bytes[i++] & 0x3f;
          const b3 = bytes[i++] & 0x3f;
          const cp = ((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3;
          const u = cp - 0x10000;
          out += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
        }
      }
      return out;
    }
  };
}

// RFC 3629 UTF-8 encode (all Unicode planes).
//
// This is the hottest crypto path in the app — every event hash / sign / verify / PoW attempt
// runs a string through here — so write bytes straight into a Uint8Array instead of building a
// boxed-number JS array and copying it (the old `bytes.push(...)` → `new Uint8Array(bytes)`).
// Two passes over the string: first sizes the buffer, second fills it. Same RFC 3629 output.
if (typeof TextEncoder === 'undefined') {
  global.TextEncoder = class TextEncoder {
    encode(str) {
      // Pass 1: compute the exact UTF-8 byte length so we allocate once, no growth/copy.
      let len = 0;
      for (let i = 0; i < str.length; ) {
        let c = str.charCodeAt(i++);
        if (c >= 0xd800 && c <= 0xdbff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(i++) - 0xdc00);
        }
        len += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
      }
      // Pass 2: emit directly into the typed array.
      const out = new Uint8Array(len);
      let j = 0;
      for (let i = 0; i < str.length; ) {
        let c = str.charCodeAt(i++);
        if (c >= 0xd800 && c <= 0xdbff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(i++) - 0xdc00);
        }
        if (c < 0x80) {
          out[j++] = c;
        } else if (c < 0x800) {
          out[j++] = 0xc0 | (c >> 6);
          out[j++] = 0x80 | (c & 0x3f);
        } else if (c < 0x10000) {
          out[j++] = 0xe0 | (c >> 12);
          out[j++] = 0x80 | ((c >> 6) & 0x3f);
          out[j++] = 0x80 | (c & 0x3f);
        } else {
          out[j++] = 0xf0 | (c >> 18);
          out[j++] = 0x80 | ((c >> 12) & 0x3f);
          out[j++] = 0x80 | ((c >> 6) & 0x3f);
          out[j++] = 0x80 | (c & 0x3f);
        }
      }
      return out;
    }
  };
}
