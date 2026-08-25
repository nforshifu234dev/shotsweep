import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

/**
 * Named `--threshold` presets, expressed as the fraction of differing pixels
 * a page can have before `shotsweep diff` marks it `'changed'`. These exist
 * so someone using `diff` doesn't have to reason about a raw 0–1 ratio to get
 * a sensible starting point.
 *
 * @type {Record<string, number>}
 */
export const THRESHOLD_PRESETS = {
  /** 0.01% of pixels — flags nearly any visual difference, including anti-aliasing noise. Good for pixel-perfect design systems or icon/logo pages. */
  strict: 0.0001,
  /** 0.1% of pixels — the CLI's default. A reasonable starting point for most sites. */
  default: 0.001,
  /** 1% of pixels — tolerates minor rendering noise (font hinting, anti-aliasing) that can differ slightly between machines/CI runners. */
  loose: 0.01,
};

/**
 * Normalizes a `--threshold` value — however it was written — into the plain
 * 0–1 fraction {@link runDiff} expects. Accepts:
 * - A raw fraction between 0 and 1, e.g. `0.001` (already what `runDiff` wants).
 * - A percentage string, e.g. `"0.1%"` (parsed to `0.001`) — often more
 *   intuitive than a bare ratio, since "0.1% of pixels differ" reads directly.
 * - A named preset — `'strict'`, `'default'`, or `'loose'` (see {@link THRESHOLD_PRESETS})
 *   for when you just want a sensible value without doing the math.
 *
 * Used both as the Commander parser for `--threshold` and to normalize a
 * threshold value that came from a config file instead of the CLI (config
 * values skip Commander's parser, so they need the same normalization
 * applied explicitly).
 *
 * @param {number|string} value - The raw threshold value from the CLI flag or a config file.
 * @returns {number} The threshold as a fraction between 0 and 1.
 * @throws {Error} If `value` doesn't match any of the accepted forms, or is outside 0–1.
 */
export function normalizeThreshold(value) {
  if (typeof value === 'number' && !Number.isNaN(value) && value >= 0 && value <= 1) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (trimmed in THRESHOLD_PRESETS) {
      return THRESHOLD_PRESETS[trimmed];
    }

    const percentMatch = /^(\d+(\.\d+)?)\s*%$/.exec(trimmed);
    if (percentMatch) {
      const asFraction = Number(percentMatch[1]) / 100;
      if (asFraction >= 0 && asFraction <= 1) {
        return asFraction;
      }
    }

    const asNumber = Number(trimmed);
    if (!Number.isNaN(asNumber) && asNumber >= 0 && asNumber <= 1) {
      return asNumber;
    }
  }

  throw new Error(
    `Invalid --threshold "${value}". Use a fraction between 0 and 1 (e.g. 0.001 = 0.1% of pixels), ` +
      `a percentage like "0.1%", or one of: ${Object.keys(THRESHOLD_PRESETS).join(', ')}.`
  );
}

/**
 * Builds the identity key used to match a manifest entry from one run to its
 * counterpart in another run, based on URL, viewport, and screenshot file name.
 *
 * @param {object} entry - A manifest entry.
 * @param {string} entry.url - The URL the entry was captured from.
 * @param {string} entry.viewport - The `WxH` viewport string for the entry.
 * @param {string} [entry.file] - Path to the screenshot file.
 * @returns {string} A composite key identifying this URL/viewport/file combination.
 */
function keyFor(entry) {
  return `${entry.url}::${entry.viewport}::${path.basename(entry.file || '')}`;
}

/**
 * Reads and parses a `manifest.json` file from a previous capture run.
 *
 * @param {string} manifestPath - Path to the manifest JSON file.
 * @returns {Promise<object[]>} The parsed manifest entries, or `[]` if the file didn't contain an array.
 */
async function readManifest(manifestPath) {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [];
}

/**
 * Reads a PNG file from disk and decodes it into a pixel buffer.
 *
 * @param {string} filePath - Path to the PNG file.
 * @returns {Promise<import('pngjs').PNG>} The decoded PNG image.
 */
async function loadPng(filePath) {
  const buffer = await fs.readFile(filePath);
  return PNG.sync.read(buffer);
}

/**
 * Compares two capture runs by their manifests and reports which pages
 * changed, were added, were removed, were resized, or stayed the same.
 *
 * Entries are matched by URL, viewport, and screenshot file name (see
 * {@link keyFor}). Matched pairs of the same dimensions are pixel-diffed with
 * `pixelmatch`; if the fraction of differing pixels exceeds `threshold`, the
 * page is marked `'changed'` and `old.png`/`new.png`/`diff.png` are written
 * to a per-pair folder under `out`. A JSON report is always written to
 * `<out>/diff-report.json`.
 *
 * @param {object} params
 * @param {string} params.oldManifest - Path to the earlier run's `manifest.json`.
 * @param {string} params.newManifest - Path to the newer run's `manifest.json`.
 * @param {string} params.out - Directory to write diff images and the report to.
 * @param {number} [params.threshold=0.001] - Fraction of differing pixels (0–1) above which a page counts as `'changed'`.
 * @returns {Promise<{ summary: { changed: number, unchanged: number, added: number, removed: number, sizeChanged: number, regressions: number }, results: object[], reportPath: string }>}
 *   A summary of change counts by status, the full per-page result list, and the path the JSON report was written to.
 */
export async function runDiff({ oldManifest, newManifest, out, threshold }) {
  const oldEntries = (await readManifest(oldManifest)).filter((e) => !e.error && e.file);
  const newEntries = (await readManifest(newManifest)).filter((e) => !e.error && e.file);

  const oldByKey = new Map(oldEntries.map((e) => [keyFor(e), e]));
  const newByKey = new Map(newEntries.map((e) => [keyFor(e), e]));
  const allKeys = new Set([...oldByKey.keys(), ...newByKey.keys()]);

  const results = [];
  await fs.mkdir(out, { recursive: true });

  for (const key of allKeys) {
    const oldEntry = oldByKey.get(key);
    const newEntry = newByKey.get(key);

    if (oldEntry && !newEntry) {
      results.push({ key, url: oldEntry.url, viewport: oldEntry.viewport, status: 'removed' });
      continue;
    }
    if (!oldEntry && newEntry) {
      results.push({ key, url: newEntry.url, viewport: newEntry.viewport, status: 'added' });
      continue;
    }

    const [oldPng, newPng] = await Promise.all([loadPng(oldEntry.file), loadPng(newEntry.file)]);

    if (oldPng.width !== newPng.width || oldPng.height !== newPng.height) {
      results.push({
        key, url: newEntry.url, viewport: newEntry.viewport, status: 'size-changed',
        oldDimensions: `${oldPng.width}x${oldPng.height}`,
        newDimensions: `${newPng.width}x${newPng.height}`,
      });
      continue;
    }

    const { width, height } = newPng;
    const diffPng = new PNG({ width, height });
    const diffPixels = pixelmatch(oldPng.data, newPng.data, diffPng.data, width, height, {
      threshold: 0.1,
    });
    const totalPixels = width * height;
    const diffRatio = diffPixels / totalPixels;
    const changed = diffRatio > (threshold ?? 0.001);

    let diffImage = null;
    let oldImage = null;
    let newImage = null;

    if (changed) {
      const safeName = key.replace(/[^a-z0-9]+/gi, '_').slice(0, 120);
      const pairDir = path.join(out, safeName);
      await fs.mkdir(pairDir, { recursive: true });

      oldImage = path.join(pairDir, 'old.png');
      newImage = path.join(pairDir, 'new.png');
      diffImage = path.join(pairDir, 'diff.png');

      await Promise.all([
        fs.copyFile(oldEntry.file, oldImage),
        fs.copyFile(newEntry.file, newImage),
        fs.writeFile(diffImage, PNG.sync.write(diffPng)),
      ]);
    }

    results.push({
      key, url: newEntry.url, viewport: newEntry.viewport,
      status: changed ? 'changed' : 'unchanged',
      diffPixels, totalPixels, diffRatio,
      oldImage, newImage, diffImage,
    });
  }

  const summary = {
    changed: results.filter((r) => r.status === 'changed').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    added: results.filter((r) => r.status === 'added').length,
    removed: results.filter((r) => r.status === 'removed').length,
    sizeChanged: results.filter((r) => r.status === 'size-changed').length,
  };

  summary.regressions = summary.changed + summary.sizeChanged;

  const reportPath = path.join(out, 'diff-report.json');
  await fs.writeFile(reportPath, JSON.stringify({ summary, results }, null, 2));

  return { summary, results, reportPath };
}