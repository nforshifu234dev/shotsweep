import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';

/**
 * Turns a page's URL into a filesystem-safe folder name derived from its path.
 *
 * The root path (`/`) becomes `'home'`; any other path has its leading slash
 * stripped, unsafe characters replaced with `-`, and remaining slashes
 * replaced with `__` to keep it as a single path segment.
 *
 * @param {string} url - The page URL to slugify.
 * @returns {string} A filesystem-safe slug for the URL's path.
 */
export function slugForUrl(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, '') || '/home';
  return p
    .replace(/^\//, '')
    .replace(/[^a-z0-9\-_/]+/gi, '-')
    .replace(/\//g, '__') || 'home';
}

/**
 * Reads a file that contains either a JSON array or newline-delimited plain
 * text, and returns it as an array of trimmed, non-empty strings.
 *
 * @param {string} filePath - Path to the file to read.
 * @returns {Promise<string[]>} The parsed list of entries (URLs or paths).
 */
async function readLinesOrJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  return trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Fetches and parses a `sitemap.xml` URL into a flat list of page URLs.
 *
 * Recursively handles sitemap index files (a sitemap listing other
 * sitemaps) by fetching and flattening each nested sitemap.
 *
 * When `replaceOrigin` is provided, it is applied before fetching nested
 * sitemaps as well as to final page URLs. This allows a production sitemap
 * to be used against localhost or staging without contacting the production
 * host.
 *
 * @param {string} sitemapUrl - URL of the sitemap (or sitemap index) to fetch.
 * @param {string} [replaceOrigin] - Origin to use instead of the URL's original origin.
 * @returns {Promise<string[]>} All page URLs found in the sitemap recursively.
 * @throws {Error} If the sitemap URL cannot be fetched successfully.
 */
async function fromSitemap(sitemapUrl, replaceOrigin) {
  // Rewrite BEFORE fetching. This is important for recursive sitemap indexes.
  const fetchUrl = applyOriginRewrite([sitemapUrl], replaceOrigin)[0];

  const res = await fetch(fetchUrl);

  if (!res.ok) {
    throw new Error(
      `Failed to fetch sitemap ${fetchUrl}: ${res.status} ${res.statusText}`
    );
  }

  const xml = await res.text();
  const parser = new XMLParser();
  const parsed = parser.parse(xml);

  // Handle sitemap index (a sitemap of sitemaps)
  if (parsed.sitemapindex?.sitemap) {
    const entries = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];

    const nested = await Promise.all(
      entries.map((entry) => {
        // Resolve relative child sitemap URLs against the sitemap we actually fetched.
        const childUrl = new URL(entry.loc, fetchUrl).toString();
        return fromSitemap(childUrl, replaceOrigin);
      })
    );

    return nested.flat();
  }

  const urlset = parsed.urlset?.url;
  if (!urlset) return [];

  const entries = Array.isArray(urlset) ? urlset : [urlset];

  return entries
    .map((entry) => {
      if (!entry.loc) return null;

      // Resolve relative page URLs against the sitemap we actually fetched.
      const pageUrl = new URL(entry.loc, fetchUrl).toString();

      // Rewrite the final page URL as well.
      return applyOriginRewrite([pageUrl], replaceOrigin)[0];
    })
    .filter(Boolean);
}

/**
 * Reads a CSV file and extracts its URL column as a flat list of URLs.
 *
 * If `column` isn't given, the column is auto-detected by preferring a
 * header matching `/url|link|page/i`, falling back to the first column.
 *
 * @param {string} filePath - Path to the CSV file.
 * @param {string} [column] - Name of the column containing URLs. Auto-detected if omitted.
 * @returns {Promise<string[]>} The list of URLs found in that column.
 */
async function fromCsv(filePath, column) {
  const raw = await fs.readFile(filePath, 'utf8');
  const records = parseCsv(raw, { columns: true, skip_empty_lines: true, trim: true });
  if (records.length === 0) return [];
  const col = column || Object.keys(records[0]).find((k) => /url|link|page/i.test(k)) || Object.keys(records[0])[0];
  return records.map((r) => r[col]).filter(Boolean);
}

/**
 * Resolves whichever input flags were passed into a flat array of target
 * URLs, checking `--url`, `--urls`, `--csv`, `--sitemap`, and
 * `--base`/`--paths` (in that order), then applying `--replace-origin` if set.
 *
 * @param {object} opts - Capture options.
 * @param {string} [opts.url] - A single URL to capture.
 * @param {string} [opts.urls] - Path to a JSON array or newline-delimited file of URLs.
 * @param {string} [opts.csv] - Path to a CSV file containing a column of URLs.
 * @param {string} [opts.csvColumn] - Name of the URL column in `opts.csv` (auto-detected if omitted).
 * @param {string} [opts.sitemap] - A sitemap.xml URL to fetch and parse.
 * @param {string} [opts.base] - Base URL to prepend to `opts.paths` entries.
 * @param {string} [opts.paths] - Path to a JSON array or newline-delimited file of relative paths, used with `opts.base`.
 * @param {string} [opts.replaceOrigin] - If set, rewrite every resolved URL's origin to this.
 * @returns {Promise<string[]>} The resolved list of target URLs.
 * @throws {Error} If none of the recognized input flags were provided.
 */
export async function resolveTargets(opts) {
  let urls;
  if (opts.url) {
    urls = [opts.url];
  } else if (opts.urls) {
    urls = await readLinesOrJson(opts.urls);
  } else if (opts.csv) {
    urls = await fromCsv(opts.csv, opts.csvColumn);
  } else if (opts.sitemap) {
    urls = await fromSitemap(opts.sitemap, opts.replaceOrigin);
  } else if (opts.base && opts.paths) {
    const relativePaths = await readLinesOrJson(opts.paths);
    urls = relativePaths.map((p) => new URL(p, opts.base).toString());
  } else {
    throw new Error(
      'No input provided. Use one of: --url, --urls <file>, --csv <file>, --sitemap <url>, or --base <url> --paths <file>.'
    );
  }
  return applyOriginRewrite(urls, opts.replaceOrigin);
}

/**
 * Builds the output directory path for a given URL, nesting screenshots
 * under the base output directory by hostname and then by a slug of the
 * URL's path (see {@link slugForUrl}).
 *
 * @param {string} baseOut - The base output directory for the run.
 * @param {string} url - The URL being captured.
 * @returns {string} The directory path screenshots for this URL should be written to.
 */
export function outDirFor(baseOut, url) {
  return path.join(baseOut, new URL(url).hostname, slugForUrl(url));
}

/**
 * Rewrites the origin (protocol + host) of every URL in a list to match a
 * replacement URL, leaving the path, query, and hash of each URL untouched.
 * Used to reuse a production sitemap against localhost or staging.
 *
 * @param {string[]} urls - URLs whose origin should be rewritten.
 * @param {string} [replaceOrigin] - The URL to take the new protocol/host from. If omitted, `urls` is returned unchanged.
 * @returns {string[]} The URLs with their origin replaced (or the original array if `replaceOrigin` wasn't given).
 */
export function applyOriginRewrite(urls, replaceOrigin) {
  if (!replaceOrigin) return urls;
  const replacement = new URL(replaceOrigin);
  return urls.map((url) => {
    const parsed = new URL(url);
    parsed.protocol = replacement.protocol;
    parsed.host = replacement.host;
    return parsed.toString();
  });
}