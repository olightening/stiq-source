/**
 * F-Droid index-v1 parsing + version selection (T9 updater core).
 *
 * This is the PURE, native-free, Tor-free half of the updater: it turns the already-verified
 * `index-v1.json` (its JAR signature checked natively in {@link ../update/updater} via the pinned
 * repo cert BEFORE this ever runs) into a normalized shape, and picks the single best update
 * candidate under a hard monotonicity rule. Keeping it pure makes the version/monotonicity policy —
 * the security-load-bearing "never offer a downgrade" decision — fully unit-testable off-device.
 *
 * F-Droid `index-v1.json` shape (the parts we read):
 *   {
 *     "repo": { "name": "…", … },
 *     "apps": [ { "packageName": "…", "localized": { "en-US": { "whatsNew": "…" } } }, … ],
 *     "packages": {
 *       "<applicationId>": [
 *         { "versionName": "1.1", "versionCode": 2, "apkName": "…_2.apk",
 *           "hash": "<hex>", "hashType": "sha256", "size": 12345, … }, …
 *       ]
 *     }
 *   }
 * `packages` is a map keyed by applicationId; each value is the array of published builds. The
 * per-release changelog ("what changed") lives under `apps[i].localized[locale].whatsNew` in a
 * full fdroidserver build; the minimal no-fdroidserver publish path (see relay/deploy/fdroid-publish.sh)
 * may instead inline a `whatsNew` string directly on the package entry. We tolerate BOTH.
 */

/** A single published build of an app, normalized from one `packages[appId][n]` entry. */
export interface FdroidPackageEntry {
  versionName: string;
  /** Monotonic integer version; the ONLY field the update decision is made on. */
  versionCode: number;
  /** File name of the APK under the repo dir (fetched as `<baseUrl>/<apkName>`). */
  apkName: string;
  /** Content hash of the APK, lower-hex. */
  hash: string;
  /** Hash algorithm; MUST be `sha256` for the native streamed-download verify to check it. */
  hashType: string;
  size?: number;
  /** Release changelog note, when the repo carries one. */
  whatsNew?: string;
}

/** Normalized index: the repo's display name (optional) + the per-app build lists. */
export interface FdroidIndex {
  repoName?: string;
  packages: Record<string, FdroidPackageEntry[]>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Coerce one raw `packages[appId][n]` object into a validated entry, or null to drop it. */
function parseEntry(raw: unknown): FdroidPackageEntry | null {
  const o = asRecord(raw);
  if (!o) return null;
  // versionCode is the load-bearing field — it must be a finite number, or the entry is unusable
  // for the monotonicity decision and is dropped rather than defaulted (a defaulted 0 could look
  // like a valid downgrade target).
  const versionCode = typeof o.versionCode === 'number' && Number.isFinite(o.versionCode) ? o.versionCode : null;
  const apkName = typeof o.apkName === 'string' ? o.apkName : '';
  const hash = typeof o.hash === 'string' ? o.hash : '';
  const hashType = typeof o.hashType === 'string' ? o.hashType : '';
  if (versionCode === null || !apkName || !hash || !hashType) return null;
  const entry: FdroidPackageEntry = {
    versionName: typeof o.versionName === 'string' ? o.versionName : String(versionCode),
    versionCode,
    apkName,
    hash: hash.toLowerCase(),
    hashType: hashType.toLowerCase(),
  };
  if (typeof o.size === 'number' && Number.isFinite(o.size)) entry.size = o.size;
  // An inlined per-entry changelog (the minimal no-fdroidserver publish path).
  if (typeof o.whatsNew === 'string' && o.whatsNew) entry.whatsNew = o.whatsNew;
  return entry;
}

/**
 * Best-effort: pull each app's localized `whatsNew` string out of the `apps` array and attach it to
 * that app's HIGHEST-versionCode entry (F-Droid's changelog is written for the current/suggested
 * release). Never throws — a repo without `apps`, or an app without a localized note, simply leaves
 * `whatsNew` unset. Prefers en-US, then en, then any locale.
 */
function mergeLocalizedWhatsNew(appsRaw: unknown, packages: Record<string, FdroidPackageEntry[]>): void {
  if (!Array.isArray(appsRaw)) return;
  for (const appRaw of appsRaw) {
    const app = asRecord(appRaw);
    if (!app) continue;
    const appId = typeof app.packageName === 'string' ? app.packageName : '';
    const entries = appId ? packages[appId] : undefined;
    if (!entries || entries.length === 0) continue;
    const localized = asRecord(app.localized);
    if (!localized) continue;
    const locale = localized['en-US'] ?? localized.en ?? Object.values(localized)[0];
    const note = asRecord(locale)?.whatsNew;
    if (typeof note !== 'string' || !note) continue;
    // Attach to the max-versionCode entry only (do not clobber an entry that already inlined one).
    let top = entries[0]!;
    for (const e of entries) if (e.versionCode > top.versionCode) top = e;
    if (!top.whatsNew) top.whatsNew = note;
  }
}

/**
 * Parse a verified `index-v1.json` string into an {@link FdroidIndex}. Uses plain `JSON.parse`
 * (no `new URL()` / no Hermes traps). Throws only when the top-level JSON is not an object; a
 * missing/!object `packages` yields an empty map rather than throwing, so a malformed-but-parseable
 * index degrades to "no updates available" instead of a crash.
 */
export function parseFdroidIndexJson(json: string): FdroidIndex {
  const raw: unknown = JSON.parse(json);
  const obj = asRecord(raw);
  if (!obj) throw new Error('f-droid index is not a JSON object');

  const packages: Record<string, FdroidPackageEntry[]> = {};
  const packagesRaw = asRecord(obj.packages);
  if (packagesRaw) {
    for (const [appId, arr] of Object.entries(packagesRaw)) {
      if (!Array.isArray(arr)) continue;
      const entries: FdroidPackageEntry[] = [];
      for (const e of arr) {
        const parsed = parseEntry(e);
        if (parsed) entries.push(parsed);
      }
      if (entries.length > 0) packages[appId] = entries;
    }
  }
  mergeLocalizedWhatsNew(obj.apps, packages);

  const index: FdroidIndex = {packages};
  const repoName = asRecord(obj.repo)?.name;
  if (typeof repoName === 'string' && repoName) index.repoName = repoName;
  return index;
}

/**
 * Pick the single update candidate for `applicationId`: the entry with the HIGHEST versionCode that
 * is STRICTLY GREATER than `installedVersionCode`. Returns null when the app is absent from the repo
 * or when its highest published versionCode is <= installed (the monotonicity guard — never a
 * downgrade or reinstall). Pure and total: no native, no Tor, no throw.
 */
export function pickUpdate(
  index: FdroidIndex,
  applicationId: string,
  installedVersionCode: number,
): FdroidPackageEntry | null {
  const entries = index.packages[applicationId];
  if (!entries || entries.length === 0) return null;
  let best: FdroidPackageEntry | null = null;
  for (const e of entries) {
    if (e.versionCode <= installedVersionCode) continue; // MONOTONICITY: drop equal/older
    if (!best || e.versionCode > best.versionCode) best = e;
  }
  return best;
}
