import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';

/**
 * Short, stable hash used to keep slugs unique when the readable part of a
 * slug can't be (query strings, non-ASCII paths, very long paths).
 *
 * @param {string} value - The string to hash.
 * @returns {string} The first 8 hex characters of its SHA-256 digest.
 */
function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** Longest readable slug kept before it is truncated (Windows MAX_PATH is 260 total). */
const MAX_SLUG_LENGTH = 80;

/**
 * Turns a page's URL into a filesystem-safe folder name derived from its path.
 *
 * The root path (`/`) becomes `'home'`; any other path has its leading slash
 * stripped, unsafe characters replaced with `-`, and remaining slashes
 * replaced with `__` to keep it as a single path segment.
 *
 * Two URLs that would otherwise land in the same folder get a short hash
 * suffix so one can't silently overwrite the other: URLs with a query string
 * (`/search?q=a` vs `/search?q=b`), paths containing non-ASCII characters
 * (which all collapse to `-`), and paths longer than {@link MAX_SLUG_LENGTH}
 * (which would otherwise risk exceeding Windows' path-length limit).
 *
 * @param {string} url - The page URL to slugify.
 * @returns {string} A filesystem-safe slug for the URL's path.
 */
export function slugForUrl(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, '') || '/home';
  let slug = p
    .replace(/^\//, '')
    .replace(/[^a-z0-9\-_/]+/gi, '-')
    .replace(/\//g, '__') || 'home';

  let decodedPath = u.pathname;
  try {
    decodedPath = decodeURIComponent(u.pathname);
  } catch {
    // keep the raw pathname if it isn't valid percent-encoding
  }

  const needsHash =
    Boolean(u.search) ||
    // eslint-disable-next-line no-control-regex
    /[^\x00-\x7F]/.test(decodedPath) ||
    slug.length > MAX_SLUG_LENGTH;

  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH);
  }
  if (needsHash) {
    slug = `${slug}__${shortHash(u.pathname + u.search)}`;
  }
  return slug;
}

/**
 * Cleans up and validates a URL as typed or pasted by a person, so a small
 * slip doesn't turn into an opaque `Invalid URL` crash several steps later.
 *
 * - Trims whitespace, surrounding quotes and `<...>` wrappers.
 * - Unwraps a pasted Markdown link: `[text](https://example.com)`.
 * - Adds a scheme when one is missing: `http://` for localhost / loopback /
 *   `*.localhost` / `*.local`, otherwise `https://`.
 * - Rejects anything that still isn't a valid `http:`, `https:` or `file:` URL.
 *
 * @param {string} raw - The URL as given by the user.
 * @returns {string} A valid, absolute URL string.
 * @throws {Error} If the value can't be turned into a valid http(s)/file URL.
 */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string') {
    throw new Error(`Invalid URL ${JSON.stringify(raw)} — expected a string like https://example.com/path.`);
  }

  let value = raw.trim();

  const markdownLink = /^\[[^\]]*\]\(([^)\s]+)\)$/.exec(value);
  if (markdownLink) value = markdownLink[1];

  value = value.replace(/^<(.*)>$/, '$1').replace(/^(["'])(.*)\1$/, '$2').trim();

  if (!value) {
    throw new Error('Empty URL — expected something like https://example.com/path.');
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const host = value.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const isLocal =
      host === 'localhost' ||
      host === '::1' ||
      /^127\./.test(host) ||
      /\.(localhost|local)$/i.test(host);
    value = `${isLocal ? 'http' : 'https'}://${value}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL "${raw}" — expected something like https://example.com/path.`);
  }

  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL scheme in "${raw}" — only http, https and file URLs can be captured.`);
  }

  return value;
}

/**
 * Normalizes every URL in a list with {@link normalizeUrl}, removes
 * duplicates (keeping first-seen order), and reports *all* invalid entries at
 * once instead of failing on the first.
 *
 * @param {string[]} urls - Raw URLs from any input source.
 * @param {string} [source='input'] - Where the list came from, used in the error message.
 * @returns {string[]} The cleaned, de-duplicated URLs.
 * @throws {Error} If any entry is invalid.
 */
export function normalizeUrlList(urls, source = 'input') {
  const cleaned = [];
  const problems = [];

  for (const raw of urls) {
    try {
      cleaned.push(normalizeUrl(raw));
    } catch (err) {
      problems.push(err.message);
    }
  }

  if (problems.length) {
    const shown = problems.slice(0, 5).map((p) => `  - ${p}`).join('\n');
    const more = problems.length > 5 ? `\n  …and ${problems.length - 5} more` : '';
    throw new Error(`${problems.length} invalid URL${problems.length === 1 ? '' : 's'} in ${source}:\n${shown}${more}`);
  }

  // De-duplicate by canonical form (so `https://x.com` and `https://x.com/`
  // count as one page), but keep the URL exactly as it was written.
  const seen = new Set();
  return cleaned.filter((url) => {
    const canonical = new URL(url).href;
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

/**
 * Reads a file that contains either a JSON array or newline-delimited plain
 * text, and returns it as an array of trimmed, non-empty strings.
 *
 * @param {string} filePath - Path to the file to read.
 * @returns {Promise<string[]>} The parsed list of entries (URLs or paths).
 */
async function readLinesOrJson(filePath) {
  // Strip a UTF-8 BOM — Windows editors (and PowerShell's `>`) often add one,
  // which breaks both JSON.parse and the leading-`[` check below.
  const raw = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Could not parse ${filePath} as a JSON array: ${err.message}`);
    }
    if (!data.every((item) => typeof item === 'string')) {
      throw new Error(`${filePath} must be a JSON array of strings.`);
    }
    return data;
  }
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    // blank lines and `# comments` are allowed in newline-delimited files
    .filter((l) => l && !l.startsWith('#'));
}

/** Network timeout for fetching a sitemap (and each nested sitemap). */
const SITEMAP_TIMEOUT_MS = 30000;

/** Maximum nesting of sitemap-index files followed before giving up. */
const MAX_SITEMAP_DEPTH = 5;

/**
 * Fetches and parses a `sitemap.xml` URL into a flat list of page URLs.
 *
 * Recursively handles sitemap index files (a sitemap listing other
 * sitemaps) by fetching and flattening each nested sitemap. Guards against
 * sitemap indexes that reference themselves (directly or in a cycle) and
 * against pathological nesting depth. Gzip-compressed sitemaps (`.xml.gz`)
 * are decompressed transparently.
 *
 * When `replaceOrigin` is provided, it is applied before fetching nested
 * sitemaps as well as to final page URLs. This allows a production sitemap
 * to be used against localhost or staging without contacting the production
 * host.
 *
 * @param {string} sitemapUrl - URL of the sitemap (or sitemap index) to fetch.
 * @param {string} [replaceOrigin] - Origin to use instead of the URL's original origin.
 * @param {Set<string>} [visited] - Sitemap URLs already fetched in this resolution (cycle guard).
 * @param {number} [depth=0] - Current sitemap-index nesting depth.
 * @returns {Promise<string[]>} All page URLs found in the sitemap recursively.
 * @throws {Error} If a sitemap URL cannot be fetched successfully.
 */
async function fromSitemap(sitemapUrl, replaceOrigin, visited = new Set(), depth = 0) {
  // Rewrite BEFORE fetching. This is important for recursive sitemap indexes.
  const fetchUrl = applyOriginRewrite([normalizeUrl(sitemapUrl)], replaceOrigin)[0];

  if (visited.has(fetchUrl)) return [];
  visited.add(fetchUrl);

  if (depth > MAX_SITEMAP_DEPTH) {
    throw new Error(`Sitemap index nesting is deeper than ${MAX_SITEMAP_DEPTH} levels at ${fetchUrl} — refusing to follow it further.`);
  }

  let res;
  try {
    res = await fetch(fetchUrl, { signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS) });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `timed out after ${SITEMAP_TIMEOUT_MS / 1000}s` : err.message;
    throw new Error(`Failed to fetch sitemap ${fetchUrl}: ${reason}`);
  }

  if (!res.ok) {
    throw new Error(
      `Failed to fetch sitemap ${fetchUrl}: ${res.status} ${res.statusText}`
    );
  }

  let xml;
  if (/\.gz(\?|$)/i.test(fetchUrl)) {
    const buffer = Buffer.from(await res.arrayBuffer());
    // Some servers already decompress via Content-Encoding; only gunzip real gzip data.
    xml = (buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer) : buffer).toString('utf8');
  } else {
    xml = await res.text();
  }

  const parser = new XMLParser();
  const parsed = parser.parse(xml);

  // Handle sitemap index (a sitemap of sitemaps)
  if (parsed.sitemapindex?.sitemap) {
    const entries = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];

    const nested = await Promise.all(
      entries
        .filter((entry) => entry?.loc)
        .map((entry) => {
          // Resolve relative child sitemap URLs against the sitemap we actually fetched.
          const childUrl = new URL(String(entry.loc).trim(), fetchUrl).toString();
          return fromSitemap(childUrl, replaceOrigin, visited, depth + 1);
        })
    );

    return nested.flat();
  }

  const urlset = parsed.urlset?.url;
  if (!urlset) return [];

  const entries = Array.isArray(urlset) ? urlset : [urlset];

  return entries
    .map((entry) => {
      if (!entry?.loc) return null;

      // Resolve relative page URLs against the sitemap we actually fetched.
      const pageUrl = new URL(String(entry.loc).trim(), fetchUrl).toString();

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
 * @throws {Error} If `column` is given but doesn't exist in the CSV header.
 */
async function fromCsv(filePath, column) {
  const raw = await fs.readFile(filePath, 'utf8');
  // `bom: true` strips the UTF-8 byte-order mark Excel adds when saving CSVs,
  // which would otherwise corrupt the first header name.
  const records = parseCsv(raw, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  if (records.length === 0) return [];

  const headers = Object.keys(records[0]);
  if (column && !headers.includes(column)) {
    throw new Error(`--csv-column "${column}" not found in ${filePath}. Columns available: ${headers.join(', ')}.`);
  }

  const col = column || headers.find((k) => /url|link|page/i.test(k)) || headers[0];
  return records.map((r) => r[col]).filter(Boolean);
}

/**
 * Resolves whichever input flags were passed into a flat array of target
 * URLs, checking `--url`, `--urls`, `--csv`, `--sitemap`, and
 * `--base`/`--paths` (in that order), then applying `--replace-origin` if set.
 *
 * Every resolved URL is cleaned with {@link normalizeUrl} (missing scheme
 * added, pasted Markdown links unwrapped) and de-duplicated, and all invalid
 * entries are reported together — so a bad URL fails here, up front, with a
 * message that names it, rather than crashing mid-run.
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
 * @throws {Error} If none of the recognized input flags were provided, or any URL is invalid.
 */
export async function resolveTargets(opts) {
  let urls;
  let source;
  if (opts.url) {
    urls = [opts.url];
    source = '--url';
  } else if (opts.urls) {
    urls = await readLinesOrJson(opts.urls);
    source = opts.urls;
  } else if (opts.csv) {
    urls = await fromCsv(opts.csv, opts.csvColumn);
    source = opts.csv;
  } else if (opts.sitemap) {
    urls = await fromSitemap(opts.sitemap, opts.replaceOrigin);
    source = opts.sitemap;
  } else if (opts.base && opts.paths) {
    const base = normalizeUrl(opts.base);
    const relativePaths = await readLinesOrJson(opts.paths);
    urls = relativePaths.map((p) => {
      try {
        return new URL(p, base).toString();
      } catch {
        throw new Error(`Invalid path "${p}" in ${opts.paths} (base ${base}).`);
      }
    });
    source = opts.paths;
  } else {
    throw new Error(
      'No input provided. Use one of: --url, --urls <file>, --csv <file>, --sitemap <url>, or --base <url> --paths <file>.'
    );
  }
  return normalizeUrlList(applyOriginRewrite(normalizeUrlList(urls, source), opts.replaceOrigin), source);
}

/**
 * Builds the output directory path for a given URL, nesting screenshots
 * under the base output directory by host (including the port, when there
 * is one — so `localhost:3000` and `localhost:4000` don't share a folder)
 * and then by a slug of the URL's path (see {@link slugForUrl}).
 *
 * @param {string} baseOut - The base output directory for the run.
 * @param {string} url - The URL being captured.
 * @returns {string} The directory path screenshots for this URL should be written to.
 */
export function outDirFor(baseOut, url) {
  const u = new URL(url);
  const hostDir = u.port ? `${u.hostname}_${u.port}` : u.hostname || 'local-file';
  return path.join(baseOut, hostDir, slugForUrl(url));
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
  const replacement = new URL(normalizeUrl(replaceOrigin));
  return urls.map((url) => {
    const parsed = new URL(url);
    parsed.protocol = replacement.protocol;
    parsed.host = replacement.host;
    return parsed.toString();
  });
}