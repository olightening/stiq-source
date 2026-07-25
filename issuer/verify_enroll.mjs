/**
 * End-to-end "fake member" verifier for the automated enrollment mailbox.
 *
 * Runs the FULL member side of the unlinkable exchange against the live relay:
 *   blind a token -> kind 9020 (NIP-44 to organizer, PoW-mined) -> mailbox blind-signs
 *   -> kind 9023 back -> unblind -> verify -> kind 9011 binding -> lands in membership.json
 *
 * Usage: node verify_enroll.mjs <INVITE-CODE>
 *   RELAY_WS (default ws://127.0.0.1:3334), STIQ_ENROLL_POW (default 12)
 *
 * NOTE: this SPENDS the invite and binds a throwaway posting npub on the production relay.
 */
import {RSABSSA} from '../client/node_modules/@cloudflare/blindrsa-ts/lib/src/index.js';
import {readFileSync} from 'fs';
import {pathToFileURL, fileURLToPath} from 'url';
import {dirname, join} from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY = process.env.RELAY_WS || 'ws://127.0.0.1:3334';
const ENROLL_POW = parseInt(process.env.STIQ_ENROLL_POW ?? '12', 10);
const INVITE = process.argv[2];
if (!INVITE) { console.error('usage: node verify_enroll.mjs <INVITE-CODE>'); process.exit(2); }

const base = join(__dirname, '../client/node_modules/nostr-tools/lib/esm');
const {finalizeEvent, getPublicKey, generateSecretKey, getEventHash} =
  await import(pathToFileURL(join(base, 'pure.js')).href);
const nip44 = (await import(pathToFileURL(join(base, 'nip44.js')).href)).v2;
const WebSocket = (await import(pathToFileURL(join(__dirname, 'node_modules/ws/index.js')).href)).default;

const organizerPub = JSON.parse(readFileSync(join(__dirname, 'organizer_nostr.json'), 'utf8')).pkHex;
const pubB64 = readFileSync(join(__dirname, 'issuer_public.b64'), 'utf8').trim();
const publicKey = await crypto.subtle.importKey(
  'spki', Buffer.from(pubB64, 'base64'), {name: 'RSA-PSS', hash: 'SHA-384'}, true, ['verify']);
const suite = RSABSSA.SHA384.PSS.Deterministic();

const b64 = u => Buffer.from(u).toString('base64');
function leadingZeroBits(hex) {
  let c = 0;
  for (const ch of hex) { const n = parseInt(ch, 16);
    if (n === 0) { c += 4; continue; }
    for (let m = 8; m > 0; m >>= 1) { if (n & m) return c; c++; } break; }
  return c;
}
function mine(unsigned, diff) {
  let nonce = 0;
  for (;;) {
    const tags = [...unsigned.tags.filter(t => t[0] !== 'nonce'), ['nonce', String(nonce), String(diff)]];
    const cand = {...unsigned, tags};
    if (leadingZeroBits(getEventHash(cand)) >= diff) return cand;
    nonce++;
  }
}

const reqSk = generateSecretKey(),   reqPub = getPublicKey(reqSk);
const replySk = generateSecretKey(), replyPub = getPublicKey(replySk);
const postSk = generateSecretKey(),  postPub = getPublicKey(postSk);

// blind: token sent in the binding is the PREPARED message (matches client enrollment.ts).
const token = suite.prepare(crypto.getRandomValues(new Uint8Array(32)));
const {blindedMsg, inv} = await suite.blind(publicKey, token);

const now = Math.floor(Date.now() / 1000);
const reqConv = nip44.utils.getConversationKey(reqSk, organizerPub);
const payload = JSON.stringify({inviteCode: INVITE, blindedToken: b64(blindedMsg), replyPubkey: replyPub});
const ev9020 = finalizeEvent(mine({
  pubkey: reqPub, kind: 9020, created_at: now,
  tags: [['p', organizerPub], ['expiration', String(now + 3600)]],
  content: nip44.encrypt(payload, reqConv),
}, ENROLL_POW), reqSk);

const ws = new WebSocket(RELAY);
let got = false;
const timeout = setTimeout(() => { console.error('FAIL: timeout waiting for 9023'); process.exit(1); }, 60000);

ws.on('open', () => {
  ws.send(JSON.stringify(['REQ', 'v-resp', {kinds: [9023], '#p': [replyPub]}]));
  ws.send(JSON.stringify(['EVENT', ev9020]));
  console.log('-> published kind 9020 (invite ' + INVITE + '); waiting for mailbox 9023...');
});
ws.on('message', async data => {
  let m; try { m = JSON.parse(data.toString()); } catch { return; }
  if (m[0] === 'OK') console.log('   relay OK', JSON.stringify(m[1]).slice(0, 14), m[2], m[3] || '');
  if (m[0] === 'NOTICE') console.log('   relay NOTICE', m[1]);
  if (m[0] === 'EVENT' && m[1] === 'v-resp' && m[2]?.kind === 9023 && !got) {
    got = true;
    try {
      const conv = nip44.utils.getConversationKey(replySk, organizerPub);
      const body = JSON.parse(nip44.decrypt(m[2].content, conv));
      if (body.error) { console.error('FAIL: mailbox returned error:', body.error); process.exit(1); }
      const blindSig = Buffer.from(body.blindSig, 'base64');
      const signature = await suite.finalize(publicKey, token, blindSig, inv);
      const valid = await suite.verify(publicKey, signature, token);
      console.log('<- 9023 received; unblinded credential valid:', valid);
      if (!valid) { console.error('FAIL: credential did not verify'); process.exit(1); }
      const ev9011 = finalizeEvent({
        kind: 9011, created_at: Math.floor(Date.now() / 1000),
        tags: [['stiq_token', b64(token)], ['stiq_sig', b64(signature)]], content: '',
      }, postSk);
      ws.send(JSON.stringify(['EVENT', ev9011]));
      console.log('-> published kind 9011 binding for posting pubkey ' + postPub);
      setTimeout(() => { clearTimeout(timeout); console.log('POSTPUB=' + postPub); ws.close(); process.exit(0); }, 4000);
    } catch (e) { console.error('FAIL:', e?.message || e); process.exit(1); }
  }
});
ws.on('error', e => { console.error('FAIL: ws error', e?.message || e); process.exit(1); });
