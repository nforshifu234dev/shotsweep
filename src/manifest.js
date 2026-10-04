// src/manifest.js
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Converts a filesystem path to forward-slash form for storing in a
 * manifest. Forward slashes work on every OS (including Windows), and make a
 * manifest written on one machine readable on another — `diff` in Linux CI
 * can't split `screenshots\example.com\home\full.png` on `/`.
 *
 * @param {string} filePath - A path built with `path.join`.
 * @returns {string} The same path using `/` separators.
 */
export function toPosix(filePath) {
  return String(filePath).split(path.sep).join('/');
}

/**
 * Identity of "the same capture job" across runs: URL + mode + viewport (+
 * selector for element captures, so two different elements on one page
 * don't replace each other).
 *
 * @param {object} entry - A manifest entry.
 * @returns {string} A composite key.
 */
export function jobKey(entry) {
  return [entry.url, entry.mode, entry.viewport, entry.selector ?? ''].join('::');
}

/**
 * Merges this run's manifest entries into the existing manifest so it
 * reflects the *current* state of the output directory instead of growing
 * forever with stale results:
 *
 * - A job that succeeded now replaces every earlier entry for that job
 *   (earlier successes — e.g. last run's section slices — and earlier errors).
 * - A job that failed now replaces earlier *errors* for that job, but leaves
 *   an earlier success in place: the old screenshot is still on disk, and
 *   erasing it from the manifest would make `diff` and `--resume` forget it.
 * - Everything else is kept untouched.
 *
 * @param {object[]} existing - Entries already in `manifest.json`.
 * @param {object[]} fresh - Entries produced by the run that just finished.
 * @returns {object[]} The merged manifest.
 */
export function mergeManifests(existing, fresh) {
  const succeeded = new Set(fresh.filter((e) => !e.error).map(jobKey));
  const failed = new Set(fresh.filter((e) => e.error).map(jobKey));

  const kept = existing.filter((entry) => {
    const key = jobKey(entry);
    if (succeeded.has(key)) return false;
    if (failed.has(key) && entry.error) return false;
    return true;
  });

  return [...kept, ...fresh];
}

/**
 * Reads an existing `manifest.json`, returning `[]` if there isn't one.
 *
 * A manifest that exists but can't be parsed is moved aside to
 * `manifest.json.corrupt-<timestamp>` rather than silently overwritten, so
 * its history isn't destroyed by the run that discovers the corruption.
 *
 * @param {string} manifestPath - Path to `manifest.json`.
 * @param {(...args: unknown[]) => void} [debug] - Optional debug logger.
 * @returns {Promise<object[]>} The existing entries (or `[]`).
 */
export async function readExistingManifest(manifestPath, debug = () => {}) {
  let raw;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  try {
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!Array.isArray(data)) throw new Error('not a JSON array');
    return data;
  } catch (err) {
    const backup = `${manifestPath}.corrupt-${Date.now()}`;
    await fs.rename(manifestPath, backup).catch(() => {});
    debug(`Existing manifest was unreadable (${err.message}); moved to ${backup} and starting fresh.`);
    return [];
  }
}

/**
 * Writes a manifest without ever leaving a half-written file behind: the
 * JSON goes to a temporary file in the same folder first and is then
 * renamed over the real one (an atomic replace), so a crash or Ctrl+C
 * mid-write can't corrupt the existing manifest.
 *
 * @param {string} manifestPath - Destination `manifest.json` path.
 * @param {object[]} entries - The manifest entries to write.
 * @returns {Promise<void>}
 */
export async function writeManifestAtomic(manifestPath, entries) {
  const json = JSON.stringify(entries, null, 2);
  const tmpPath = `${manifestPath}.tmp-${process.pid}`;
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(tmpPath, json);
  try {
    await fs.rename(tmpPath, manifestPath);
  } catch {
    // Some Windows setups refuse to replace a file another process (an
    // indexer, an open editor) has open; fall back to a plain write.
    await fs.writeFile(manifestPath, json);
    await fs.rm(tmpPath, { force: true });
  }
}