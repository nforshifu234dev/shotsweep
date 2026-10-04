import fs from 'node:fs/promises';

/**
 * Drives an actual login form in a real browser page once, then saves the
 * resulting storage state (cookies + localStorage) to disk so it can be
 * reused later via `capture --session`.
 *
 * Credentials are taken from `opts.email` / `opts.password` if provided,
 * falling back to the `SHOTSWEEP_EMAIL` / `SHOTSWEEP_PASSWORD` environment
 * variables.
 *
 * @param {import('playwright').Browser} browser - A launched Playwright browser instance.
 * @param {object} opts - Login options.
 * @param {string} opts.loginUrl - URL of the page containing the login form.
 * @param {string} opts.emailSelector - CSS selector for the email/username field.
 * @param {string} opts.passwordSelector - CSS selector for the password field.
 * @param {string} opts.submitSelector - CSS selector for the submit button.
 * @param {string} [opts.email] - Email/username to fill in (falls back to `SHOTSWEEP_EMAIL`).
 * @param {string} [opts.password] - Password to fill in (falls back to `SHOTSWEEP_PASSWORD`).
 * @param {string} opts.sessionOut - File path to write the saved storage state to.
 * @returns {Promise<string>} The path the session was saved to (i.e. `opts.sessionOut`).
 * @throws {Error} If required selectors/URL are missing, or no credentials can be resolved.
 */
export async function recordLoginSession(browser, opts) {
  const {
    loginUrl,
    emailSelector,
    passwordSelector,
    submitSelector,
    email,
    password,
    sessionOut,
  } = opts;

  if (!loginUrl || !emailSelector || !passwordSelector || !submitSelector) {
    throw new Error(
      '--login-url, --email-selector, --password-selector, and --submit-selector are all required for login.'
    );
  }
  const resolvedEmail = email || process.env.SHOTSWEEP_EMAIL;
  const resolvedPassword = password || process.env.SHOTSWEEP_PASSWORD;
  if (!resolvedEmail || !resolvedPassword) {
    throw new Error(
      'No credentials found. Pass --email/--password or set SHOTSWEEP_EMAIL / SHOTSWEEP_PASSWORD.'
    );
  }

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // `networkidle` as the *only* wait can hang forever on pages with
    // long-polling/websocket traffic, so wait for `load` and treat idle as best-effort.
    await page.goto(loginUrl, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.fill(emailSelector, resolvedEmail);
    await page.fill(passwordSelector, resolvedPassword);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.click(submitSelector),
    ]);

    await context.storageState({ path: sessionOut });
  } finally {
    await context.close();
  }

  // The session file contains live cookies/tokens — keep it private to this
  // user. (No-op on Windows, where POSIX permissions don't apply.)
  await fs.chmod(sessionOut, 0o600).catch(() => {});

  return sessionOut;
}

/**
 * Parses repeatable `--header "Key: Value"` flags into a plain object.
 *
 * @param {string[]} [headerFlags] - Raw `--header` flag values.
 * @returns {Record<string, string>} Header names (as typed) mapped to values.
 * @throws {Error} If a flag isn't of the form `Key: Value` — a typo here used
 *   to be skipped silently, leaving the capture running without the header.
 */
export function parseHeaders(headerFlags) {
  const headers = {};
  for (const flag of headerFlags ?? []) {
    const idx = String(flag).indexOf(':');
    const key = idx === -1 ? '' : flag.slice(0, idx).trim();
    if (!key) {
      throw new Error(`--header "${flag}" must look like "Key: Value" (e.g. "X-Api-Key: abc123").`);
    }
    headers[key] = flag.slice(idx + 1).trim();
  }
  return headers;
}

/**
 * Applies whichever generic auth mechanism was configured (saved session,
 * bearer token, and/or arbitrary headers) into a set of options suitable for
 * `browser.newContext()`, and separately parses any configured cookies.
 *
 * Bearer tokens and custom headers are returned as `scopedHeaders` rather
 * than set as context-wide `extraHTTPHeaders`: the latter is attached to
 * *every* request the page makes, including to third-party hosts (fonts,
 * analytics, CDNs), which would leak the token. Use
 * {@link installScopedHeaders} to attach them only to the site being
 * captured. Pass `opts.headersAllOrigins` to restore send-everywhere
 * behaviour.
 *
 * @param {object} opts - Capture options.
 * @param {string} [opts.session] - Path to a saved Playwright `storageState` file.
 * @param {string} [opts.bearer] - Token to send as `Authorization: Bearer <token>`.
 * @param {string[]} [opts.header] - Repeatable `"Key: Value"` header strings.
 * @param {string[]} [opts.cookie] - Repeatable `"name=value; Domain=..."` cookie strings.
 * @param {string} [opts.userAgent] - User-Agent string to present instead of Chromium's headless default.
 * @param {boolean} [opts.ignoreHttpsErrors] - Accept invalid/self-signed TLS certificates.
 * @param {boolean} [opts.headersAllOrigins] - Send bearer/headers to every origin instead of only the captured site.
 * @returns {Promise<{ contextOptions: object, cookies: object[], scopedHeaders: Record<string, string> }>}
 *   Options for `browser.newContext()`, cookies for `context.addCookies()`, and
 *   headers to attach via {@link installScopedHeaders} (empty when
 *   `headersAllOrigins` already folded them into `contextOptions`).
 * @throws {Error} If `--session` points at a missing file, or a header/cookie is malformed.
 */
export async function buildContextOptions(opts) {
  const contextOptions = {};
  const extraHeaders = {};

  if (opts.session) {
    await ensureFileExists(opts.session, '--session');
    contextOptions.storageState = opts.session;
  }

  if (opts.userAgent) contextOptions.userAgent = opts.userAgent;
  if (opts.ignoreHttpsErrors) contextOptions.ignoreHTTPSErrors = true;

  if (opts.bearer) {
    extraHeaders.Authorization = `Bearer ${opts.bearer}`;
  }

  Object.assign(extraHeaders, parseHeaders(opts.header));

  let scopedHeaders = {};
  if (Object.keys(extraHeaders).length) {
    if (opts.headersAllOrigins) {
      contextOptions.extraHTTPHeaders = extraHeaders;
    } else {
      scopedHeaders = extraHeaders;
    }
  }

  return { contextOptions, cookies: parseCookies(opts.cookie), scopedHeaders };
}

/**
 * Decides whether a request URL belongs to the same site as the page being
 * captured, for the purpose of deciding whether credentials may be sent to it.
 *
 * Deliberately conservative: the port must match exactly, and the hostnames
 * must be equal or one must be a subdomain of the other (so `example.com`
 * and `www.example.com` — including after a redirect between them — share
 * credentials, but `127.0.0.1` and `localhost`, or two unrelated domains, do not).
 *
 * @param {string} targetUrl - The URL being captured.
 * @param {string} requestUrl - A request made by the page.
 * @returns {boolean} `true` if credentials may be attached to `requestUrl`.
 */
export function isSameSite(targetUrl, requestUrl) {
  let target;
  let request;
  try {
    target = new URL(targetUrl);
    request = new URL(requestUrl);
  } catch {
    return false;
  }
  if (target.port !== request.port) return false;
  const a = target.hostname;
  const b = request.hostname;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Attaches bearer/custom headers to requests that go to the captured site
 * only, leaving third-party requests (fonts, analytics, CDNs) untouched.
 *
 * @param {import('playwright').BrowserContext} context - The context to intercept requests on.
 * @param {string} targetUrl - The URL being captured; defines which requests count as "same site".
 * @param {Record<string, string>} headers - Headers to attach (from {@link buildContextOptions}).
 * @returns {Promise<void>}
 */
export async function installScopedHeaders(context, targetUrl, headers) {
  const entries = Object.entries(headers);
  if (!entries.length) return;

  // Playwright hands back request headers lower-cased; match that so a
  // user-supplied `Authorization` replaces rather than duplicates.
  const lowered = Object.fromEntries(entries.map(([k, v]) => [k.toLowerCase(), v]));

  await context.route('**/*', (route) => {
    const request = route.request();
    if (!isSameSite(targetUrl, request.url())) return route.continue();
    return route.continue({ headers: { ...request.headers(), ...lowered } });
  });
}

/**
 * Parses repeatable `--cookie` flag values into Playwright cookie objects.
 *
 * Each flag must be of the form `"name=value; Domain=example.com"`. Optional
 * attributes: `Path=` (defaults to `/`), `Secure`, `HttpOnly`, and
 * `SameSite=Strict|Lax|None`.
 *
 * @param {string[]} [cookieFlags] - Raw `--cookie` flag values.
 * @returns {object[]} Playwright-compatible cookie objects.
 * @throws {Error} If a cookie flag has no `name=value` pair or is missing its required `Domain=` attribute.
 */
export function parseCookies(cookieFlags) {
  if (!cookieFlags || !cookieFlags.length) return [];
  const cookies = [];
  for (const flag of cookieFlags) {
    const parts = String(flag).split(';').map((p) => p.trim()).filter(Boolean);
    const [nameValue = '', ...attrs] = parts;
    const eq = nameValue.indexOf('=');
    if (eq < 1) {
      throw new Error(`--cookie "${flag}" must start with name=value (e.g. "session=abc; Domain=example.com").`);
    }
    const name = nameValue.slice(0, eq);
    const value = nameValue.slice(eq + 1);
    const cookie = { name, value, path: '/' };
    for (const attr of attrs) {
      const attrEq = attr.indexOf('=');
      const k = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
      const v = attrEq === -1 ? '' : attr.slice(attrEq + 1).trim();
      if (k === 'domain') cookie.domain = v;
      else if (k === 'path') cookie.path = v;
      else if (k === 'secure') cookie.secure = true;
      else if (k === 'httponly') cookie.httpOnly = true;
      else if (k === 'samesite') {
        const normalized = { strict: 'Strict', lax: 'Lax', none: 'None' }[v.toLowerCase()];
        if (!normalized) throw new Error(`--cookie "${flag}": SameSite must be Strict, Lax or None.`);
        cookie.sameSite = normalized;
      }
    }
    if (!cookie.domain) {
      throw new Error(`--cookie "${flag}" needs a Domain=... attribute (e.g. "name=value; Domain=example.com")`);
    }
    cookies.push(cookie);
  }
  return cookies;
}

/**
 * Asserts that a file exists on disk, throwing a friendly, flag-specific
 * error message if it doesn't.
 *
 * @param {string} filePath - Path to the file to check.
 * @param {string} flagName - Name of the CLI flag the path came from, used in the error message.
 * @returns {Promise<void>}
 * @throws {Error} If the file cannot be accessed.
 */
export async function ensureFileExists(filePath, flagName) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`File not found for ${flagName}: ${filePath}`);
  }
}