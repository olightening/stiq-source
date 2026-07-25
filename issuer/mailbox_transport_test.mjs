// Unit test for the mailbox transport-selection branch (isOnionRelayUrl): which relay URLs route
// through Tor's SOCKS proxy vs connect directly. Previously inline in connect() with 0% coverage
// (TOR_HARDENING_AUDIT.md F2/org-1/X6) — extracted to a pure exported function specifically so this
// branch can be exercised without a real WebSocket/SOCKS connection.
// Run: node mailbox_transport_test.mjs
import {isOnionRelayUrl} from './mailbox.mjs';

let failures = 0;
function check(label, cond) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label);
  if (!cond) failures += 1;
}

// ── .onion URLs route over Tor (isOnion === true) ────────────────────────────
check('bare v3 onion ws:// routes over Tor',
  isOnionRelayUrl('ws://stiqexamplerelayonionaddressfortestsonly2345672345672345.onion') === true);
check('onion with explicit port routes over Tor',
  isOnionRelayUrl('ws://stiqexamplerelayonionaddressfortestsonly2345672345672345.onion:80') === true);
check('onion with a path routes over Tor',
  isOnionRelayUrl('ws://stiqexamplerelayonionaddressfortestsonly2345672345672345.onion/relay') === true);
check('wss:// onion routes over Tor',
  isOnionRelayUrl('wss://stiqexamplerelayonionaddressfortestsonly2345672345672345.onion') === true);
check('uppercase .ONION (case-insensitive) routes over Tor',
  isOnionRelayUrl('ws://STIQEXAMPLERELAYONIONADDRESSFORTESTSONLY2345672345672345.ONION') === true);

// ── direct/non-onion URLs bypass SOCKS (isOnion === false) ───────────────────
check('loopback ws:// does NOT route over Tor',
  isOnionRelayUrl('ws://127.0.0.1:3334') === false);
check('an SSH-tunneled loopback host does NOT route over Tor',
  isOnionRelayUrl('ws://localhost:13334') === false);
check('a plain domain does NOT route over Tor',
  isOnionRelayUrl('wss://relay.example.com') === false);
check('a hostname merely containing "onion" as a substring (not the TLD) does NOT route over Tor',
  isOnionRelayUrl('ws://onionfarm.example.com') === false);

// ── malformed / absent input never throws and is treated as non-onion ────────
check('undefined relay URL does not throw and is non-onion', isOnionRelayUrl(undefined) === false);
check('empty string is non-onion', isOnionRelayUrl('') === false);

console.log(failures === 0 ? '\nall mailbox transport tests passed' : `\n${failures} mailbox transport test(s) FAILED`);
if (failures > 0) process.exit(1);
