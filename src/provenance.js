import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * The current shape version of the run-record document produced by
 * {@link buildRunRecord}. Bump this if the record's shape changes in a way
 * that could break a consumer reading old records — the field lets tooling
 * (and humans) tell which shape they're looking at instead of guessing from
 * which fields happen to be present.
 *
 * @type {number}
 */
export const RUN_RECORD_VERSION = 1;

/**
 * `opts` keys whose *values* must never be written verbatim into a
 * run-record, because they can carry secrets (auth tokens, cookies,
 * session material). The record still notes that the option was set —
 * audits need to know auth was in play — it just never stores what it was.
 *
 * @type {string[]}
 */
const SECRET_OPTION_KEYS = ['bearer', 'cookie', 'header', 'session'];

/**
 * `opts` keys that are internal plumbing (callbacks, the debug logger) with
 * no meaningful audit value and no safe JSON representation. Excluded
 * entirely from the recorded configuration rather than redacted, since
 * "this was a function" isn't useful to log.
 *
 * @type {string[]}
 */
const NON_SERIALIZABLE_OPTION_KEYS = ['debug', 'onResolved', 'onProgress'];

/**
 * Reads this package's own `name`/`version` from its `package.json`,
 * resolved relative to this module so it works regardless of the caller's
 * cwd or how the package was installed.
 *
 * @returns {{ name: string, version: string }}
 */
function getToolMeta() {
  try {
    const pkg = require('../package.json');
    return { name: pkg.name, version: pkg.version };
  } catch {
    return { name: '@nfsfu234/shotsweep', version: 'unknown' };
  }
}

/**
 * Reads Playwright's installed version from its own `package.json`.
 *
 * @returns {string} The installed `playwright` package version, or `'unknown'` if it can't be resolved.
 */
function getPlaywrightVersion() {
  try {
    return require('playwright/package.json').version;
  } catch {
    return 'unknown';
  }
}

/**
 * Produces a version of `opts` safe to write to disk: functions and
 * callbacks are dropped, and values that can carry secrets (auth tokens,
 * cookies, session files) are replaced with a redaction marker rather than
 * omitted outright — an auditor reading the record can still see *that*
 * auth was configured for the run, just not what it was.
 *
 * @param {object} opts - The raw capture options for a run (as passed to {@link import('./capture.js').runCapture}).
 * @returns {object} A plain, JSON-safe, secret-redacted copy of `opts`.
 */
export function redactConfig(opts) {
  const redacted = {};

  for (const [key, value] of Object.entries(opts ?? {})) {
    if (NON_SERIALIZABLE_OPTION_KEYS.includes(key)) continue;

    if (SECRET_OPTION_KEYS.includes(key)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        redacted[key] = value.map(() => '[REDACTED]');
      } else {
        redacted[key] = '[REDACTED]';
      }
      continue;
    }

    redacted[key] = value;
  }

  return redacted;
}

/**
 * Computes the SHA-256 hash of a file's contents, for tamper-evident
 * artifact references in a run-record or diff report.
 *
 * @param {string} filePath - Path to the file to hash.
 * @returns {Promise<string>} The hex-encoded SHA-256 digest.
 */
export async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Builds a run-record: a snapshot of everything needed to understand —
 * and, as far as the environment allows, reproduce — a single capture run.
 *
 * This exists because a manifest/diff-report on its own only records the
 * *outcome* of a run ("these pages changed"), not the *conditions* it ran
 * under. Two runs of the same config can legitimately disagree if the
 * browser build, OS, or fonts differ between them — a run-record makes that
 * kind of drift auditable after the fact instead of invisible.
 *
 * @param {object} params
 * @param {object} params.opts - The resolved capture options for this run (will be redacted — see {@link redactConfig}).
 * @param {string} params.browserVersion - The launched browser's version string (`browser.version()`), captured before the browser is closed.
 * @param {object[]} params.manifest - This run's own manifest entries (not the merged historical manifest — just what this invocation produced).
 * @param {string} params.manifestPath - Path to the `manifest.json` this run wrote to.
 * @param {number} params.durationMs - Total run duration in milliseconds.
 * @param {number} params.total - Number of URL/viewport jobs run.
 * @returns {Promise<object>} The run-record, ready to be passed to {@link writeRunRecord}.
 */
export async function buildRunRecord({
  opts,
  browserVersion,
  manifest,
  manifestPath,
  durationMs,
  total,
}) {
  const tool = getToolMeta();

  const artifacts = await Promise.all(
    manifest
      .filter((entry) => !entry.error && entry.file)
      .map(async (entry) => ({
        url: entry.url,
        mode: entry.mode,
        viewport: entry.viewport,
        file: entry.file,
        sizeBytes: entry.sizeBytes,
        sha256: await sha256File(entry.file),
      })),
  );

  return {
    recordVersion: RUN_RECORD_VERSION,
    createdAt: new Date().toISOString(),
    tool,
    browser: {
      engine: 'playwright',
      playwrightVersion: getPlaywrightVersion(),
      browserName: 'chromium',
      browserVersion,
    },
    runtime: {
      node: process.version,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
    },
    resolvedConfig: redactConfig(opts),
    run: {
      durationMs,
      total,
      manifestPath: path.resolve(manifestPath),
    },
    artifacts,
  };
}

/**
 * Writes a run-record to `<outDir>/run-record.json`.
 *
 * One record per output directory, reflecting the most recent run into it
 * (mirroring how `manifest.json` is the merged, current state of that
 * directory) — it is not an append-only history of every run ever made
 * into that directory.
 *
 * @param {string} outDir - The capture run's output directory.
 * @param {object} record - The run-record, as produced by {@link buildRunRecord}.
 * @returns {Promise<string>} The path the record was written to.
 */
export async function writeRunRecord(outDir, record) {
  const recordPath = path.join(outDir, 'run-record.json');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(recordPath, JSON.stringify(record, null, 2));
  return recordPath;
}

/**
 * Looks for a `run-record.json` next to a given `manifest.json` and reads
 * it if present.
 *
 * Used by `shotsweep diff` to pull in provenance for both sides of a
 * comparison without requiring it — older manifests captured before this
 * feature existed simply have no run-record, and diffing still works, just
 * without the environment-drift check.
 *
 * @param {string} manifestPath - Path to a `manifest.json` from a previous capture run.
 * @returns {Promise<object|null>} The parsed run-record, or `null` if none exists or it couldn't be parsed.
 */
export async function loadRunRecordFor(manifestPath) {
  const recordPath = path.join(path.dirname(manifestPath), 'run-record.json');

  try {
    const raw = await fs.readFile(recordPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Fields compared between two run-records to detect environment drift that
 * could explain a visual diff having nothing to do with the pages
 * themselves — e.g. a Chromium point release changing font hinting, or a
 * different OS's system fonts being used as a fallback.
 *
 * @type {{ path: string[], label: string }[]}
 */
const DRIFT_CHECK_FIELDS = [
  { path: ['tool', 'version'], label: 'ShotSweep version' },
  { path: ['browser', 'playwrightVersion'], label: 'Playwright version' },
  { path: ['browser', 'browserVersion'], label: 'Chromium version' },
  { path: ['runtime', 'node'], label: 'Node version' },
  { path: ['runtime', 'platform'], label: 'OS platform' },
  { path: ['runtime', 'arch'], label: 'CPU architecture' },
];

/**
 * Reads a nested value out of an object by a path of keys, returning
 * `undefined` if any segment along the way is missing.
 *
 * @param {object} obj - The object to read from.
 * @param {string[]} keys - The path of keys to follow.
 * @returns {*} The value at that path, or `undefined`.
 */
function getPath(obj, keys) {
  return keys.reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * Compares two run-records' environment fingerprints and reports any
 * mismatches — this is the check that turns "38 green screenshots" into an
 * actually trustworthy verdict, by surfacing when a diff's baseline and
 * current run didn't execute under the same conditions.
 *
 * @param {object|null} oldRecord - The baseline run's run-record, or `null` if unavailable.
 * @param {object|null} newRecord - The current run's run-record, or `null` if unavailable.
 * @returns {{ comparable: boolean, drift: string[] }}
 *   `comparable` is `false` if either record is missing (nothing to compare).
 *   `drift` lists one human-readable line per field that differed between the two runs — empty if the environments matched (or if not comparable).
 */
export function compareEnvironments(oldRecord, newRecord) {
  if (!oldRecord || !newRecord) {
    return { comparable: false, drift: [] };
  }

  const drift = [];

  for (const { path: fieldPath, label } of DRIFT_CHECK_FIELDS) {
    const oldValue = getPath(oldRecord, fieldPath);
    const newValue = getPath(newRecord, fieldPath);

    if (oldValue !== undefined && newValue !== undefined && oldValue !== newValue) {
      drift.push(`${label} differs: ${oldValue} (baseline) vs ${newValue} (current)`);
    }
  }

  return { comparable: true, drift };
}
