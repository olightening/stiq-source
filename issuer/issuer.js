#!/usr/bin/env node
/**
 * Stiq issuer tool — blind-signs a member's enrollment request.
 *
 * Usage:
 *   node issuer.js <request-code>
 *
 * The request code is printed by the member's app on the onboarding screen
 * (the "Show this to your organizer" step). It looks like:
 *   stiq:cred-req:1;<base64-blinded-token>
 *
 * This script prints a response code the member pastes back:
 *   stiq:cred-resp:1;<base64-blind-signature>
 *
 * The private key (issuer_private.pem) must be in the same directory.
 * It never leaves this machine — the member only sees the blinded output.
 *
 * Requires Node.js 18+ (built-in WebCrypto) and @cloudflare/blindrsa-ts.
 *
 *   cd issuer && npm install @cloudflare/blindrsa-ts
 */

import {readFileSync} from 'fs';
import {createRequire} from 'module';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Try loading from the client's node_modules so the organizer doesn't need
// a separate npm install if running from the repo root.
let RSABSSA;
try {
  ({RSABSSA} = await import(join(__dirname, '../client/node_modules/@cloudflare/blindrsa-ts/lib/src/index.js')));
} catch {
  ({RSABSSA} = await import('@cloudflare/blindrsa-ts'));
}

const REQ_PREFIX  = 'stiq:cred-req:1;';
const RESP_PREFIX = 'stiq:cred-resp:1;';

const requestCode = process.argv[2];
if (!requestCode) {
  console.error('Usage: node issuer.js <request-code>');
  process.exit(1);
}
if (!requestCode.startsWith(REQ_PREFIX)) {
  console.error('Error: not a stiq enrollment request code.');
  process.exit(1);
}

// Load the issuer private key (PKCS#8 PEM → CryptoKey).
const pemPath = join(__dirname, 'issuer_private.pem');
let pemText;
try {
  pemText = readFileSync(pemPath, 'utf8');
} catch {
  console.error(`Error: cannot read ${pemPath}`);
  console.error('Generate it with: node -e "const {generateKeyPairSync}=require(\'crypto\'); ..."');
  process.exit(1);
}

const pemBody = pemText
  .replace(/-----BEGIN PRIVATE KEY-----/, '')
  .replace(/-----END PRIVATE KEY-----/, '')
  .replace(/\s+/g, '');
const keyDer = Buffer.from(pemBody, 'base64');

const privateKey = await crypto.subtle.importKey(
  'pkcs8',
  keyDer,
  {name: 'RSA-PSS', hash: 'SHA-384'},
  true,   // extractable=true required by blindrsa-ts (exports JWK for raw math)
  ['sign'],
);

// Decode the blinded token from the request code.
const blindedB64 = requestCode.slice(REQ_PREFIX.length).trim();
const blindedMsg  = Buffer.from(blindedB64, 'base64');

// Blind-sign.
const suite    = RSABSSA.SHA384.PSS.Deterministic();
const blindSig = await suite.blindSign(privateKey, blindedMsg);

const responseCode = RESP_PREFIX + Buffer.from(blindSig).toString('base64');
console.log(responseCode);
