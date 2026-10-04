import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { resolveTargets, outDirFor } from './inputs.js';
import { buildContextOptions, installScopedHeaders } from './auth.js';
import { launchBrowser } from './browser.js';
import { toArray } from './config.js';
import { captureSections } from './sections.js';
import { captureElement } from './element.js';
import { autoScroll, settleImages } from './scroll.js';
import { mergeManifests, readExistingManifest, toPosix, writeManifestAtomic } from './manifest.js';
import { buildRunRecord, redactUrlCredentials, writeRunRecord } from './provenance.js';
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
export function parseViewport(v) {
  if (VIEWPORT_PRESETS[v]) {
    return VIEWPORT_PRESETS[v];
  }
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(String(v).trim());
  const [width, height] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
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
  // `limit` can be undefined/NaN when runCapture is called as a library; fall
  // back to 1 rather than starting zero workers (which silently runs nothing).
  const workers = Math.max(1, Math.floor(Number(limit)) || 1);
  await Promise.all(Array.from({ length: workers }, next));
  return results;
}

/**
 * Removes ANSI colour escape sequences. Playwright wraps parts of its error
 * messages in them, which is how `\u001b[2m` ended up inside manifest.json.
 *
 * @param {string} text - Text possibly containing ANSI escapes.
 * @returns {string} The text without escapes.
 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

/** Chromium's practical limit for a single full-page screenshot, in CSS pixels. */
const TALL_PAGE_WARNING_PX = 16384;

/**
 * Reads the pixel height out of a PNG file's header (IHDR chunk) without
 * decoding the image.
 *
 * @param {string} filePath - Path to a PNG file.
 * @returns {Promise<number|null>} The image height, or `null` if it can't be read.
 */
async function readPngHeight(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(24);
    await handle.read(buffer, 0, 24, 0);
    return buffer.readUInt32BE(20);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Navigates a page, with retries, and — unless `opts.strictLoad` is set —
 * tolerates the wait condition timing out when the page itself is usable.
 *
 * Many real sites never fire `load` (or never reach `networkidle`) within a
 * reasonable time because a tracker, chat widget, or video keeps a request
 * open, even though the page is fully rendered. Failing the whole capture in
 * that case helps nobody. If the wait times out but navigation did commit and
 * the document is at least `interactive`, the capture proceeds and a warning
 * is recorded. A page that never responded at all (still blank) is still an error.
 *
 * @param {import('playwright').Page} page - The page to navigate.
 * @param {string} url - The URL to open.
 * @param {object} opts - Capture options (`waitUntil`, `timeout`, `retries`, `strictLoad`).
 * @param {string[]} warnings - Array that warning messages are appended to.
 * @param {(...args: unknown[]) => void} debug - Debug logger.
 * @returns {Promise<void>}
 * @throws {Error} If navigation fails, or times out on a page that never rendered (or `strictLoad` is set).
 */
async function navigate(page, url, opts, warnings, debug) {
  const waitUntil = opts.waitUntil ?? 'load';
  const timeout = opts.timeout ?? 30000;
  const retries = opts.retries ?? 0;

  try {
    await withRetries(
      () => page.goto(url, { waitUntil, timeout }),
      retries,
      {
        delayMs: 1000,
        onRetry: (err, attempt) =>
          debug(`Retry ${attempt}/${retries} for ${url}: ${stripAnsi(err.message).split('\n')[0]}`),
      },
    );
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(err?.message ?? '');
    if (!timedOut || opts.strictLoad || waitUntil === 'domcontentloaded') throw err;

    const committed = !/^(about:|chrome-error:)/.test(page.url());
    const readyState = committed ? await page.evaluate(() => document.readyState).catch(() => null) : null;

    if (readyState === 'interactive' || readyState === 'complete') {
      warnings.push(
        `"${waitUntil}" didn't fire within ${timeout}ms (document was ${readyState}); captured anyway. ` +
          'Pass --strict-load to fail instead, or --wait-until domcontentloaded to skip the wait (images are still awaited after scrolling, see --image-wait).',
      );
      debug(`Navigation to ${url} timed out waiting for "${waitUntil}", but the document is ${readyState} — continuing.`);
      // Cancel whatever is still in flight (the stalled request that kept
      // `load` from firing). Otherwise the screenshot call can hang on it too.
      await page.evaluate(() => window.stop()).catch(() => {});
      return;
    }
    throw err;
  }
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
 * @param {string} [opts.mode='full'] - Capture mode: `'full'` for a single full-page screenshot, `'sections'` for viewport-height slices, or `'element'` for a single element cropped to its own bounding box (requires `opts.selector`).
 * @param {string} [opts.selector] - CSS selector identifying the element to capture. Required when `opts.mode === 'element'`; ignored otherwise.
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
 * @param {boolean} [opts.scroll=true] - Scroll the page top-to-bottom before capturing (full and sections modes) so scroll-reveal animations and lazy-loaded images have appeared. Pass `false` to capture the page exactly as first rendered.
 * @param {number} [opts.imageWait=10000] - Milliseconds to wait, after scrolling, for images that are still loading or were cancelled and re-requested. Images that still haven't loaded are reported as a warning.
 * @param {boolean} [opts.strictLoad=false] - Fail a job when `waitUntil` times out, instead of capturing the page anyway (with a warning) if its document is already usable.
 * @param {string} [opts.userAgent] - User-Agent to present instead of Chromium's headless default (some hosts block `HeadlessChrome`).
 * @param {boolean} [opts.ignoreHttpsErrors=false] - Accept invalid or self-signed TLS certificates (staging servers).
 * @param {boolean} [opts.headersAllOrigins=false] - Send `bearer`/`header` values to every origin the page contacts. By default they go only to the captured site (and its subdomains), never to third parties.
 * @param {boolean} [opts.freezeAnimations=false] - Fast-forward finite CSS animations and cancel infinite ones when taking screenshots, for steadier captures and diffs.
 * @param {boolean} [opts.zip] - Whether to bundle the output directory into a `.zip` when done.
 * @param {boolean} [opts.record=true] - Whether to write a `run-record.json` provenance snapshot (tool/browser/OS versions, redacted config, content-hashed artifacts) to `opts.out`. Pass `false` to skip it for throwaway/local runs.
 * @param {boolean} [opts.dryRun] - If true, resolve (and slice) targets and return them without capturing anything.
 * @param {(...args: unknown[]) => void} [opts.debug] - Optional debug logger function.
 * @param {(targets: string[]) => void} [opts.onResolved] - Callback fired once target URLs are resolved and `--limit`/`--offset` applied.
 * @param {(progress: { completed: number, total: number, url: string, viewport: string, ok: boolean }) => void} [opts.onProgress] - Callback fired after each URL/viewport job completes. `total` reflects the job count after any `--resume` skipping.
 * @returns {Promise<{ dryRun?: boolean, targets?: string[], manifest: object[], manifestPath: string|null, zipPath: string|null, recordPath?: string|null, durationMs?: number, total?: number }>}
 *   On a dry run: the resolved (and sliced) `targets` and an empty manifest. Otherwise: the
 *   merged manifest entries (previous run's entries plus this run's), the path `manifest.json` was written to, the zip
 *   path (if `opts.zip` was set), the path `run-record.json` was written to (`null` if `opts.record` was `false`), the total run duration in ms, and the total
 *   number of URL/viewport jobs actually run (after `--resume` skipping).
 * @throws {Error} If no URLs could be resolved from the given input.
 */
export async function runCapture(opts) {
  // Work on a copy so defaults applied here don't leak into the caller's object.
  opts = { ...opts, out: opts.out ?? './screenshots' };

  const debug =
    typeof opts.debug === 'function'
      ? opts.debug
      : () => {};

  const mode = opts.mode ?? 'full';
  const validModes = ['full', 'sections', 'element'];
  if (!validModes.includes(mode)) {
    throw new Error(
      `Invalid --mode "${opts.mode}". Expected one of: ${validModes.join(', ')}.`,
    );
  }

  if (mode === 'element' && !opts.selector) {
    throw new Error(
      '--mode element requires --selector <css> identifying the element to capture.',
    );
  }

  // Validate cheap, local things first so a typo fails in milliseconds
  // instead of after a sitemap download or a browser launch.
  const viewports = (toArray(opts.viewport).length ? toArray(opts.viewport) : ['desktop']).map(parseViewport);

  if (opts.limit !== undefined && opts.limit !== null && !(Number.isInteger(opts.limit) && opts.limit > 0)) {
    throw new Error(`Invalid --limit "${opts.limit}". Expected a positive integer.`);
  }
  const offset = opts.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid --offset "${opts.offset}". Expected 0 or a positive integer.`);
  }

  const targets = await resolveTargets(opts);

  debug('Resolved targets:', targets);
  debug(`Resolved ${targets.length} target(s).`);

  if (!targets.length) {
    throw new Error(
      'No URLs resolved from the given input — nothing to capture.'
    );
  }

  // apply --limit / --offset before anything else touches targets
  const scopedTargets = opts.limit
    ? targets.slice(offset, offset + opts.limit)
    : targets.slice(offset);

  if (!scopedTargets.length) {
    throw new Error(
      `--offset ${offset} skips all ${targets.length} resolved URL(s) — nothing to capture.`
    );
  }

  if (scopedTargets.length !== targets.length) {
    debug(`--limit/--offset applied: ${scopedTargets.length} of ${targets.length} target(s) selected.`);
  }

  opts.onResolved?.(scopedTargets);

  if (opts.dryRun) {
    return {
      dryRun: true,
      targets: scopedTargets,
      manifest: [],
      manifestPath: null,
      zipPath: null,
      recordPath: null,
    };
  }

  const concurrency = Math.max(1, Math.floor(Number(opts.concurrency)) || 1);
  const cpuCount = os.cpus().length;
  if (concurrency > cpuCount) {
    console.log(chalk.yellow(
      `⚠ --concurrency ${concurrency} exceeds your ${cpuCount} CPU core(s). ` +
      `Each page runs a full Chromium instance — consider ${cpuCount} or lower.`
    ));
  }

  // Read any existing manifest ONCE, up front, before the run starts. Used
  // both for --resume filtering and as the merge base at the end.
  const manifestPath = path.join(opts.out, 'manifest.json');
  const existing = await readExistingManifest(manifestPath, debug);

  // build the set of already-completed url+viewport pairs
  const completedSet = new Set();
  if (opts.resume) {
    if (mode === 'full') {
      for (const entry of existing) {
        // Only 'full' mode entries are trustworthy for resume — a sections job
        // may have crashed partway through writing its slices, and a single
        // successful entry can't currently prove all sections were written.
        // Also require the screenshot to still exist: a manifest entry for a
        // file the user has since deleted is not "already captured".
        if (!entry.error && entry.mode === 'full' && entry.file) {
          const stillThere = await fs.access(entry.file).then(() => true, () => false);
          if (stillThere) completedSet.add(`${entry.url}::${entry.viewport}`);
        }
      }
      debug(`--resume: ${completedSet.size} already-completed URL/viewport pair(s) found in existing manifest.`);
    } else {
      console.log(chalk.yellow(
        `⚠ --resume with --mode ${mode}: completeness can't be verified yet, ` +
        `so ${mode} jobs are always re-captured on resume (only full-page jobs are skipped).`
      ));
    }
  }

  const { contextOptions, cookies, scopedHeaders } = await buildContextOptions(opts);

  let jobs = scopedTargets.flatMap((url) => viewports.map((viewport) => ({ url, viewport })));

  // filter out already-completed jobs when --resume is set
  if (opts.resume && completedSet.size) {
    const beforeCount = jobs.length;
    jobs = jobs.filter(({ url, viewport }) => !completedSet.has(`${url}::${viewport.width}x${viewport.height}`));
    if (jobs.length !== beforeCount) {
      debug(`--resume: skipping ${beforeCount - jobs.length} already-completed job(s), ${jobs.length} remaining.`);
    }
  }

  const total = jobs.length;
  let completed = 0;
  const startedAt = Date.now();

  const browser = await launchBrowser();
  const browserVersion = browser.version();
  const animations = opts.freezeAnimations ? 'disabled' : 'allow';

  let jobResults;
  try {
    jobResults = await runWithConcurrency(jobs, concurrency, async ({ url, viewport }) => {
      const viewportLabel = `${viewport.width}x${viewport.height}`;
      const safeUrl = redactUrlCredentials(url);
      const warnings = [];
      let context;
      let outcome;

      // Everything that can fail for a single page — including creating its
      // folder and browser context — lives inside this try, so one bad job
      // is recorded as an error entry instead of aborting the whole batch.
      try {
        const outDirPath = outDirFor(opts.out, url);
        await fs.mkdir(outDirPath, { recursive: true });

        context = await browser.newContext({
          ...contextOptions, viewport, colorScheme: opts.dark ? 'dark' : 'light',
        });
        if (cookies.length) await context.addCookies(cookies);
        await installScopedHeaders(context, url, scopedHeaders);
        const page = await context.newPage();

        await navigate(page, url, opts, warnings, debug);

        if (opts.wait !== undefined && opts.wait !== null && String(opts.wait).trim() !== '') {
          const asMs = Number(opts.wait);
          if (!Number.isNaN(asMs)) {
            await page.waitForTimeout(asMs);
          } else {
            const waitTimeout = opts.timeout ?? 30000;
            await page.waitForSelector(String(opts.wait), { timeout: waitTimeout }).catch(() => {
              // A selector that never appears is worth knowing about — it's
              // usually a typo — but the page itself may still be fine to capture.
              warnings.push(`--wait selector "${opts.wait}" didn't appear within ${waitTimeout}ms; captured anyway.`);
            });
          }
        }

        // Trigger scroll-reveal animations and lazy-loaded images so content
        // below the first screen isn't captured in its hidden state.
        // The scroll warm-up also settles images; when it doesn't run (--no-scroll,
        // or element mode) still give images a bounded chance to finish, and
        // cancel stalled ones so the screenshot call can't hang on them.
        let imageStats = null;
        if (opts.scroll !== false && mode !== 'element') {
          imageStats = (await autoScroll(page, { debug: opts.debug, imageWaitMs: opts.imageWait }))?.images ?? null;
        } else {
          imageStats = await settleImages(page, { imageWaitMs: opts.imageWait }).catch(() => null);
        }

        const unfinished = (imageStats?.broken ?? 0) + (imageStats?.stillLoading ?? 0);
        if (unfinished > 0) {
          warnings.push(
            `${unfinished} of ${imageStats.total} image(s) didn't finish loading and will appear blank or as alt text. ` +
            'Try --image-wait 30000, or check whether the host is slow or blocking headless browsers (--user-agent).',
          );
        }

        let files = [];
        if (mode === 'element') {
          files = await captureElement(
            page,
            opts.selector,
            outDirPath,
            path,
            fs,
            opts.debug,
            { timeout: opts.timeout, animations },
          );
        } else if (mode === 'sections') {
          files = await captureSections(page, viewport, outDirPath, path, fs, opts.debug, { animations, timeout: opts.timeout });
        } else {
          const fileName = `full-${viewport.width}x${viewport.height}.png`;
          const filePath = path.join(outDirPath, fileName);
          await page.screenshot({ path: filePath, fullPage: true, animations, timeout: opts.timeout });
          files = [filePath];

          const height = await readPngHeight(filePath);
          if (height && height >= TALL_PAGE_WARNING_PX) {
            warnings.push(
              `The full-page screenshot is ${height}px tall; Chromium can clip captures this large. ` +
              'Check the bottom of the image, or use --mode sections.',
            );
          }
        }

        if (!files.length) {
          throw new Error(
            `No screenshots were produced for ${safeUrl} (${viewportLabel}).`
          );
        }

        outcome = await Promise.all(files.map(async (filePath) => {
          const stat = await fs.stat(filePath);
          return {
            url: safeUrl, mode, viewport: viewportLabel,
            ...(mode === 'element' ? { selector: opts.selector } : {}),
            file: toPosix(filePath), sizeBytes: stat.size, timestamp: new Date().toISOString(),
            ...(warnings.length ? { warnings } : {}),
          };
        }));
      } catch (err) {
        const message = stripAnsi(err?.message ?? String(err));
        opts.debug?.(`Capture failed: ${safeUrl} (${viewportLabel})`, message);

        outcome = [{
          url: safeUrl, mode, viewport: viewportLabel,
          ...(mode === 'element' ? { selector: opts.selector } : {}),
          error: message, timestamp: new Date().toISOString(),
          ...(warnings.length ? { warnings } : {}),
        }];
      } finally {
        await context?.close().catch(() => {});
      }

      completed++;
      opts.onProgress?.({
        completed, total, url: safeUrl,
        viewport: viewportLabel,
        ok: !outcome.some((r) => r.error),
      });

      return outcome;
    });
  } finally {
    // Always release Chromium — an exception above used to leave it running.
    await browser.close().catch(() => {});
  }

  const manifest = jobResults.flat();
  const durationMs = Date.now() - startedAt;

  await writeManifestAtomic(manifestPath, mergeManifests(existing, manifest));

  // Provenance record: a snapshot of the tool/browser/OS versions, the
  // resolved (secret-redacted) config, and content-hashed artifacts for
  // *this* run specifically — not the merged historical manifest above.
  // Opt-out via --no-record for local/throwaway runs that don't need it.
  let recordPath = null;
  if (opts.record !== false) {
    const record = await buildRunRecord({
      opts,
      browserVersion,
      manifest,
      manifestPath,
      durationMs,
      total,
    });
    recordPath = await writeRunRecord(opts.out, record);
  }

  let zipPath = null;
  if (opts.zip) zipPath = await zipOutput(opts.out);

  return { manifest, manifestPath, zipPath, durationMs, total, recordPath };
}