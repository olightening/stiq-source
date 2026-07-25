/**
 * Encrypted community-archive export (T16-S5).
 *
 * The organizer box holds the ENTIRE trust root of a community: the issuer RSA private key (mints
 * enrollment credentials), the organizer Nostr secret key (moderation root), the shared community key
 * (blind-post attribution), the token-domain-separation purpose keys, every config sidecar, the invite
 * / draw double-spend state, and — co-located with the relay — the relay config plus the relay's
 * badger spent/bound state. A single archive that concentrates all of this is a catastrophic asset if
 * it leaks, so this module NEVER emits plaintext: the archive is ALWAYS an authenticated-encrypted
 * (AES-256-GCM) container, and readArchive fails closed on a wrong passphrase or a single flipped byte.
 *
 * Container layout (self-describing, all lengths big-endian):
 *
 *   ARCHIVE_MAGIC(9) || salt(16) || iv(12) || authTag(16) || ciphertext
 *
 *   ciphertext = AES-256-GCM( gzip( framed-entries ), key, iv )
 *   framed-entries = concat of, per entry: uint32 labelLen | label(utf8) | uint32 dataLen | data
 *
 * Key derivation (documented KDF): key = scrypt(passphrase, salt, 32) with N=2^15, r=8, p=1. scrypt is
 * memory-hard, so an offline brute-force of the passphrase against a leaked archive is expensive; the
 * 16-byte random salt makes every export unique (no precomputation across archives) and the GCM auth
 * tag binds the whole ciphertext (tamper ⇒ decrypt throws). Node builtins only — no external deps, so
 * this runs on the offline, framework-free issuer box.
 */
import {readFileSync, existsSync, statSync, readdirSync} from 'fs';
import {join, relative, sep, dirname} from 'path';
import {scryptSync, randomBytes, createCipheriv, createDecipheriv} from 'crypto';
import {gzipSync, gunzipSync} from 'zlib';

export const ARCHIVE_MAGIC = 'STIQARCH1';
const MAGIC = Buffer.from(ARCHIVE_MAGIC, 'utf8'); // 9 bytes
const SALT_LEN = 16;
const IV_LEN = 12;   // 96-bit nonce — the GCM standard
const TAG_LEN = 16;  // 128-bit auth tag
const KEY_LEN = 32;  // AES-256
// scrypt cost parameters. N=2^15 is interactive-strength; Node's default maxmem (32 MiB) is just under
// what N=2^15,r=8 needs (~34 MiB = 128*N*r), so raise maxmem explicitly.
const SCRYPT = {N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024};

function deriveKey(passphrase, salt) {
  return scryptSync(Buffer.from(String(passphrase), 'utf8'), salt, KEY_LEN, SCRYPT);
}

function frame(entries) {
  const chunks = [];
  for (const {label, bytes} of entries) {
    const labelBuf = Buffer.from(String(label), 'utf8');
    const lh = Buffer.alloc(4); lh.writeUInt32BE(labelBuf.length, 0);
    const dh = Buffer.alloc(4); dh.writeUInt32BE(bytes.length, 0);
    chunks.push(lh, labelBuf, dh, bytes);
  }
  return Buffer.concat(chunks);
}

function unframe(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('archive: truncated (label length)');
    const labelLen = buf.readUInt32BE(off); off += 4;
    if (off + labelLen > buf.length) throw new Error('archive: truncated (label)');
    const label = buf.slice(off, off + labelLen).toString('utf8'); off += labelLen;
    if (off + 4 > buf.length) throw new Error('archive: truncated (data length)');
    const dataLen = buf.readUInt32BE(off); off += 4;
    if (off + dataLen > buf.length) throw new Error('archive: truncated (data)');
    out.push({label, bytes: buf.slice(off, off + dataLen)}); off += dataLen;
  }
  return out;
}

/**
 * Enumerate the organizer-held artifacts resident on the box. Returns [{label, path}] for every path
 * that currently exists as a readable file; absent paths are skipped gracefully (a community that never
 * enabled token domain separation, or a non-co-located relay, simply contributes fewer entries).
 *
 * @param {string} dir            the issuer/ directory (organizer_nostr.json, issuer_private.pem, …)
 * @param {string} relayConfigPath path to the relay config.json (RELAY_CONFIG_PATH)
 * @param {string} [relayDataDir]  path to the relay badger DataDir (recursively included when readable)
 */
export function collectArtifactPaths(dir, relayConfigPath, relayDataDir) {
  const out = [];
  const addFile = (label, path) => {
    try { if (path && existsSync(path) && statSync(path).isFile()) out.push({label, path}); } catch { /* skip */ }
  };

  // Organizer-held key material + identity.
  addFile('issuer_private.pem', join(dir, 'issuer_private.pem'));
  addFile('issuer_public.b64', join(dir, 'issuer_public.b64'));
  addFile('community_key.b64', join(dir, 'community_key.b64'));
  addFile('organizer_nostr.json', join(dir, 'organizer_nostr.json'));

  // Token-domain-separation purpose keys (present only when STIQ_TOKEN_DOMAIN_SEP was enabled).
  for (const n of ['post_token_key_private.pem', 'post_token_key_public.b64',
                   'read_token_key_private.pem', 'read_token_key_public.b64']) addFile(n, join(dir, n));

  // Config sidecars + security state.
  for (const n of ['limits.json', 'tag_policy.json', 'guide.json', 'labels.json', 'post_rules.json',
                   'picture_rules.json', 'reasons.json', 'permissions.json', 'mod_limits.json', 'gov.json',
                   'community.json', 'ranking.json', 'token_policy.json', 'mailbox_policy.json', 'storage.json',
                   'bridges.json', 'moderators.json', 'invites.json', 'draws.json']) addFile(n, join(dir, n));

  // Relay config (read locally from disk — never over a network endpoint; the relay stays untouched).
  if (relayConfigPath) {
    addFile('relay/config.json', relayConfigPath);
    // membership.json (the relay's spent/bound double-spend state) commonly sits next to the config.
    addFile('relay/membership.json', join(dirname(relayConfigPath), 'membership.json'));
  }

  // Relay badger DataDir — recursive file listing (best-effort; a live copy is usually consistent since
  // badger point-writes fsync). membership.json inside the DataDir is captured by the walk too.
  if (relayDataDir && existsSync(relayDataDir)) {
    try {
      const walk = d => {
        for (const name of readdirSync(d)) {
          const full = join(d, name);
          let st; try { st = statSync(full); } catch { continue; }
          if (st.isDirectory()) walk(full);
          else if (st.isFile()) out.push({label: 'relay/data/' + relative(relayDataDir, full).split(sep).join('/'), path: full});
        }
      };
      walk(relayDataDir);
    } catch { /* DataDir unreadable — skip */ }
  }

  return out;
}

/**
 * Build the encrypted archive from entries. Each entry is either {label, path} (bytes read from disk)
 * or {label, bytes} (in-memory). Returns the full container Buffer. Throws if no passphrase is given —
 * an unencrypted archive of these secrets must never be producible.
 */
export async function buildArchive(entries, passphrase) {
  if (!passphrase || String(passphrase).length < 1) throw new Error('archive: passphrase required (refusing to build an unencrypted archive)');
  const resolved = [];
  for (const e of entries || []) {
    if (e.bytes != null) { resolved.push({label: e.label, bytes: Buffer.isBuffer(e.bytes) ? e.bytes : Buffer.from(e.bytes)}); continue; }
    if (e.path && existsSync(e.path)) resolved.push({label: e.label, bytes: readFileSync(e.path)});
  }
  const plain = gzipSync(frame(resolved));
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, ct]);
}

/**
 * Decrypt + unframe an archive built by buildArchive. Returns [{label, bytes}]. Throws on a bad magic,
 * a truncated container, a wrong passphrase, or any tampering (GCM auth-tag failure) — always fail closed.
 */
export async function readArchive(buf, passphrase) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const header = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (buf.length < header) throw new Error('archive: too short to be a stiqarch container');
  if (!buf.slice(0, MAGIC.length).equals(MAGIC)) throw new Error('archive: bad magic (not a stiqarch file)');
  let off = MAGIC.length;
  const salt = buf.slice(off, off += SALT_LEN);
  const iv = buf.slice(off, off += IV_LEN);
  const tag = buf.slice(off, off += TAG_LEN);
  const ct = buf.slice(off);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plain;
  try { plain = Buffer.concat([decipher.update(ct), decipher.final()]); }
  catch { throw new Error('archive: decryption failed (wrong passphrase or tampered archive)'); }
  return unframe(gunzipSync(plain));
}
