/**
 * One-shot: sign + publish the organizer roster + limits to the relay (used after wiring the
 * live relay over an SSH tunnel). RELAY_WS must point at the tunneled relay, e.g.
 *   RELAY_WS=ws://127.0.0.1:13334 node publish-config.mjs
 */
import {readFileSync, existsSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';
import {organizerIdentity, signRoster, signLimits, publish} from './organizer-nostr.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_WS = process.env.RELAY_WS;
if (!RELAY_WS) {
  console.error('set RELAY_WS=ws://127.0.0.1:<port>');
  process.exit(1);
}

const id = organizerIdentity();
console.log('organizer npub:', id.npub);
console.log('organizer hex :', id.pkHex);

const mods = existsSync(join(__dirname, 'moderators.json'))
  ? JSON.parse(readFileSync(join(__dirname, 'moderators.json'), 'utf8'))
  : [];
const limits = existsSync(join(__dirname, 'limits.json'))
  ? JSON.parse(readFileSync(join(__dirname, 'limits.json'), 'utf8'))
  : {posts: {daily: 20, weekly: 100, monthly: 300}, comments: {daily: 100}, dm_global_per_min: 60, exempt_moderators: true};

const roster = signRoster(mods);
const limitsEvent = signLimits(limits);

for (const [label, ev] of [['roster', roster], ['limits', limitsEvent]]) {
  const r = await publish(ev, RELAY_WS);
  console.log(`${label}: ok=${r.ok} id=${ev.id.slice(0, 12)}… ${r.message}`);
}
process.exit(0);
