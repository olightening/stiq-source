import {RSABSSA} from '../client/node_modules/@cloudflare/blindrsa-ts/lib/src/index.js';
import {readFileSync, existsSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname} from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// This round-trip exercises the sample issuer keypair. When it isn't present
// (e.g. a fresh checkout or CI without the deployed key), skip rather than
// hard-fail — the deployed organizer always has the key, so it runs there.
if (!existsSync(`${__dirname}/issuer_private.pem`) || !existsSync(`${__dirname}/issuer_public.b64`)) {
  console.log('SKIP roundtrip_test: issuer keypair not present in this environment');
  process.exit(0);
}

const suite = RSABSSA.SHA384.PSS.Deterministic();

// ── Client: blind ──────────────────────────────────────────────────────────
const pubB64 = readFileSync(`${__dirname}/issuer_public.b64`, 'utf8').trim();
const publicKey = await crypto.subtle.importKey(
  'spki', Buffer.from(pubB64, 'base64'),
  {name: 'RSA-PSS', hash: 'SHA-384'}, true, ['verify'],
);

const token = crypto.getRandomValues(new Uint8Array(32));
const preparedMsg = suite.prepare(token);
const {blindedMsg, inv} = await suite.blind(publicKey, preparedMsg);
console.log('blinded length:', blindedMsg.length);

// ── Issuer: blind-sign ─────────────────────────────────────────────────────
const pem = readFileSync(`${__dirname}/issuer_private.pem`, 'utf8');
const pemBody = pem
  .replace(/-----BEGIN PRIVATE KEY-----/, '')
  .replace(/-----END PRIVATE KEY-----/, '')
  .replace(/\s+/g, '');
const privateKey = await crypto.subtle.importKey(
  'pkcs8', Buffer.from(pemBody, 'base64'),
  {name: 'RSA-PSS', hash: 'SHA-384'}, true, ['sign'],
);

const blindSig = await suite.blindSign(privateKey, blindedMsg);
console.log('blind signature length:', blindSig.length);

// ── Client: finalize ───────────────────────────────────────────────────────
const signature = await suite.finalize(publicKey, preparedMsg, blindSig, inv);
console.log('unblinded signature length:', signature.length);

// ── Verify ─────────────────────────────────────────────────────────────────
const valid = await suite.verify(publicKey, signature, preparedMsg);
console.log('signature valid:', valid);
if (!valid) process.exit(1);
