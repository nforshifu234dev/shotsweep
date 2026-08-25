import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { chromium } from 'playwright';
import { resolveTargets, outDirFor } from './inputs.js';
import { buildContextOptions } from './auth.js';
import { captureSections } from './sections.js';
import { zipOutput } from './zip.js';
import { withRetries } from './retry.js';

/**
 * Named viewport size presets selectable via `--viewport <preset>`.
 * @type {Record<string, { width: number, height: number }>}
 */
const VIEWPORT_PRESETS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

/**
 * Parses a `--viewport` value into a `{ width, height }` size.
 *
 * Accepts either a named preset (`'desktop'`, `'tablet'`, `'mobile'`) or a
 * raw `"WxH"` string (e.g. `"1440x900"`).
 *
 * @param {string} v - The raw `--viewport` value.
 * @returns {{ width: number, height: number }} The resolved viewport dimensions.
 * @throws {Error} If `v` is not a known preset and not a valid `"WxH"` string.
 */
function parseViewport(v) {
  if (VIEWPORT_PRESETS[v]) {
    return VIEWPORT_PRESETS[v];
  }
  const [width, height] = v.split('x').map(Number);
  if (!width || !height) {
    throw new Error(
      `Invalid --viewport "${v}", expected e.g. "1440x900" or one of: ${Object.keys(VIEWPORT_PRESETS).join(', ')}.`
    );
  }
  return { width, height };
}

/**
 * Runs an async `worker` over a list of `items` with at most `limit` running
 * concurrently, preserving the original item order in the returned results.
 *
 * @template T, R
 * @param {T[]} items - The items to process.
 * @param {number} limit - Maximum number of items processed concurrently (values below 1 are treated as 1).
 * @param {(item: T) => Promise<R>} worker - Async function invoked once per item.
 * @returns {Promise<R[]>} Results in the same order as `items`.
 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function next() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, next));
  return results;
}

/**
 * Resolves target URLs and, unless this is a dry run, captures a screenshot
 * of each URL at every requested viewport, writing files to `opts.out`,
 * merging results into `manifest.json`, and optionally zipping the output.
 *
 * For each URL/viewport pair, a fresh browser context is created (applying
 * any configured auth, cookies, and dark-mode emulation), the page is
 * navigated to with retry support, an optional wait (fixed delay or
 * selector) is applied, and then either a single full-page screenshot or a
 * set of viewport-height section screenshots is captured. Per-URL/viewport
 * work runs with up to `opts.concurrency` jobs in parallel; a warning is
 * logged if `opts.concurrency` exceeds the machine's CPU core count.
 *
 * @param {object} opts - Capture options (as resolved/merged from CLI flags and config).
 * @param {string} [opts.url] - A single URL to capture.
 * @param {string} [opts.urls] - Path to a file of URLs.
 * @param {string} [opts.csv] - Path to a CSV file of URLs.
 * @param {string} [opts.csvColumn] - URL column name within `opts.csv`.
 * @param {string} [opts.sitemap] - A sitemap URL to resolve targets from.
 * @param {string} [opts.base] - Base URL used with `opts.paths`.
 * @param {string} [opts.paths] - Path to a file of relative paths, used with `opts.base`.
 * @param {string} [opts.replaceOrigin] - Rewrite every resolved URL's origin to this.
 * @param {number} [opts.limit] - Only capture the first N resolved URLs (applied after --replace-origin, before viewport expansion).
 * @param {number} [opts.offset=0] - Skip the first N resolved URLs before applying `opts.limit`.
 * @param {boolean} [opts.resume] - Skip URL/viewport jobs that already have a successful (non-error) entry in `opts.out`'s existing `manifest.json`. Note: for `mode: 'sections'`, completeness is checked per URL/viewport, not per individual section file — see the note on `captureSections` for the known limitation this implies for interrupted section runs.
 * @param {string} [opts.mode='full'] - Capture mode: `'full'` for a single full-page screenshot, or `'sections'` for viewport-height slices.
 * @param {string[]} [opts.viewport] - Repeatable viewport specs/presets; defaults to `['desktop']` if empty.
 * @param {string} [opts.wait] - A fixed delay in ms, or a CSS selector, to wait for before capturing.
 * @param {string} [opts.waitUntil='load'] - Playwright's `waitUntil` condition for `page.goto` — `'domcontentloaded'`, `'load'`, or `'networkidle'`.
 * @param {boolean} [opts.dark] - Whether to emulate `prefers-color-scheme: dark`.
 * @param {string} opts.out - Output directory for screenshots and the manifest.
 * @param {string} [opts.session] - Path to a saved Playwright storage state file.
 * @param {string} [opts.bearer] - Bearer token to send with every request.
 * @param {string[]} [opts.header] - Repeatable custom request headers.
 * @param {string[]} [opts.cookie] - Repeatable cookies to inject.
 * @param {number} [opts.concurrency=1] - Number of pages to capture in parallel.
 * @param {number} [opts.timeout] - Per-page navigation timeout in ms.
 * @param {number} [opts.retries=0] - Number of times to retry a failed page load.
 * @param {boolean} [opts.zip] - Whether to bundle the output directory into a `.zip` when done.
 * @param {boolean} [opts.dryRun] - If true, resolve (and slice) targets and return them without capturing anything.
 * @param {(...args: unknown[]) => void} [opts.debug] - Optional debug logger function.
 * @param {(targets: string[]) => void} [opts.onResolved] - Callback fired once target URLs are resolved and `--limit`/`--offset` applied.
 * @param {(progress: { completed: number, total: number, url: string, viewport: string, ok: boolean }) => void} [opts.onProgress] - Callback fired after each URL/viewport job completes. `total` reflects the job count after any `--resume` skipping.
 * @returns {Promise<{ dryRun?: boolean, targets?: string[], manifest: object[], manifestPath: string|null, zipPath: string|null, durationMs?: number, total?: number }>}
 *   On a dry run: the resolved (and sliced) `targets` and an empty manifest. Otherwise: the
 *   merged manifest entries (previous run's entries plus this run's), the path `manifest.json` was written to, the zip
 *   path (if `opts.zip` was set), the total run duration in ms, and the total
 *   number of URL/viewport jobs actually run (after `--resume` skipping).
 * @throws {Error} If no URLs could be resolved from the given input.
 */
export async function runCapture(opts) {
  const debug =
    typeof opts.debug === 'function'
      ? opts.debug
      : () => {};

  const targets = await resolveTargets(opts);

  debug('Resolved targets:', targets);
  debug(`Resolved ${targets.length} target(s).`);

  if (!targets.length) {
    throw new Error(
      'No URLs resolved from the given input — nothing to capture.'
    );
  }

  // NEW — apply --limit / --offset before anything else touches targets
  const offset = opts.offset ?? 0;
  const scopedTargets = opts.limit
    ? targets.slice(offset, offset + opts.limit)
    : targets.slice(offset);

  if (scopedTargets.length !== targets.length) {
    debug(`--limit/--offset applied: ${scopedTargets.length} of ${targets.length} target(s) selected.`);
  }

  opts.onResolved?.(scopedTargets); // was: opts.onResolved?.(targets)

  if (opts.dryRun) {
    return {
      dryRun: true,
      targets: scopedTargets, // was: targets
      manifest: [],
      manifestPath: null,
      zipPath: null,
    };
  }

  const cpuCount = os.cpus().length;
  if (opts.concurrency > cpuCount) {
    console.log(chalk.yellow(
      `⚠ --concurrency ${opts.concurrency} exceeds your ${cpuCount} CPU core(s). ` +
      `Each page runs a full Chromium instance — consider ${cpuCount} or lower.`
    ));
  }

  const viewports = (opts.viewport?.length ? opts.viewport : ['desktop']).map(parseViewport);

  // NEW — read any existing manifest ONCE, up front, before the run starts.
  // Used both for --resume filtering and as the merge base at the end
  // (previously this read happened only at the end).
  const manifestPath = path.join(opts.out, 'manifest.json');
  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {}

  // build the set of already-completed url+viewport pairs
  const completedSet = new Set();
  if (opts.resume) {
    for (const entry of existing) {
      // Only 'full' mode entries are trustworthy for resume — a sections job
      // may have crashed partway through writing its slices, and a single
      // successful entry can't currently prove all sections were written.
      // See runCapture's JSDoc for the tracked limitation.
      if (!entry.error && entry.mode === 'full') {
        completedSet.add(`${entry.url}::${entry.viewport}`);
      }
    }
    debug(`--resume: ${completedSet.size} already-completed URL/viewport pair(s) found in existing manifest.`);

    if (opts.mode === 'sections') {
      console.log(chalk.yellow(
        '⚠ --resume with --mode sections: completeness can\'t be verified per-section yet, ' +
        'so sections jobs are always re-captured on resume (only full-page jobs are skipped).'
      ));
    }
  }

  const { contextOptions, cookies } = await buildContextOptions(opts);
  const browser = await chromium.launch();

  let jobs = scopedTargets.flatMap((url) => viewports.map((viewport) => ({ url, viewport }))); // was: targets.flatMap(...)

  // filter out already-completed jobs when --resume is set
  if (opts.resume) {
    const beforeCount = jobs.length;
    jobs = jobs.filter(({ url, viewport }) => !completedSet.has(`${url}::${viewport.width}x${viewport.height}`));
    if (jobs.length !== beforeCount) {
      debug(`--resume: skipping ${beforeCount - jobs.length} already-completed job(s), ${jobs.length} remaining.`);
    }
  }

  const total = jobs.length;
  let completed = 0;
  const startedAt = Date.now();

  const jobResults = await runWithConcurrency(jobs, opts.concurrency, async ({ url, viewport }) => {
    const outDirPath = outDirFor(opts.out, url);
    await fs.mkdir(outDirPath, { recursive: true });

    const context = await browser.newContext({
      ...contextOptions, viewport, colorScheme: opts.dark ? 'dark' : 'light',
    });
    if (cookies.length) await context.addCookies(cookies);
    const page = await context.newPage();

    let outcome;
    try {
      await withRetries(
        () => page.goto(url, { waitUntil: opts.waitUntil ?? 'load', timeout: opts.timeout }),
        opts.retries ?? 0,
      );

      if (opts.wait) {
        const asMs = Number(opts.wait);
        if (!Number.isNaN(asMs)) await page.waitForTimeout(asMs);
        else await page.waitForSelector(opts.wait, { timeout: 15000 }).catch(() => {});
      }

      let files = [];
      if (opts.mode === 'sections') {
        files = await captureSections(page, viewport, outDirPath, path, fs, opts.debug);
      } else {
        const fileName = `full-${viewport.width}x${viewport.height}.png`;
        const filePath = path.join(outDirPath, fileName);
        await page.screenshot({ path: filePath, fullPage: true });
        files = [filePath];
      }

      if (!files.length) {
        throw new Error(
          `No screenshots were produced for ${url} (${viewport.width}x${viewport.height}).`
        );
      }

      outcome = await Promise.all(files.map(async (filePath) => {
        const stat = await fs.stat(filePath);
        return {
          url, mode: opts.mode, viewport: `${viewport.width}x${viewport.height}`,
          file: filePath, sizeBytes: stat.size, timestamp: new Date().toISOString(),
        };
      }));
    } catch (err) {
      opts.debug?.(
        `Capture failed: ${url} (${viewport.width}x${viewport.height})`,
        err.message,
      );

      outcome = [{
        url, mode: opts.mode, viewport: `${viewport.width}x${viewport.height}`,
        error: err.message, timestamp: new Date().toISOString(),
      }];
    } finally {
      await context.close();
    }

    completed++;
    opts.onProgress?.({
      completed, total, url,
      viewport: `${viewport.width}x${viewport.height}`,
      ok: !outcome.some((r) => r.error),
    });

    return outcome;
  });

  await browser.close();
  const manifest = jobResults.flat();
  const durationMs = Date.now() - startedAt;

  await fs.mkdir(opts.out, { recursive: true });
  // NOTE: no second manifestPath declaration or second existing-read here —
  // both now reuse the ones read at the top of the function
  await fs.writeFile(manifestPath, JSON.stringify([...existing, ...manifest], null, 2));

  let zipPath = null;
  if (opts.zip) zipPath = await zipOutput(opts.out);

  return { manifest, manifestPath, zipPath, durationMs, total };
}