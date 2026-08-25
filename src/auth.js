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
  const page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: 'networkidle' });
  await page.fill(emailSelector, resolvedEmail);
  await page.fill(passwordSelector, resolvedPassword);
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.click(submitSelector),
  ]);

  await context.storageState({ path: sessionOut });
  await context.close();
  return sessionOut;
}

/**
 * Applies whichever generic auth mechanism was configured (saved session,
 * bearer token, and/or arbitrary headers) into a set of options suitable for
 * `browser.newContext()`, and separately parses any configured cookies.
 *
 * @param {object} opts - Capture options.
 * @param {string} [opts.session] - Path to a saved Playwright `storageState` file.
 * @param {string} [opts.bearer] - Token to send as `Authorization: Bearer <token>`.
 * @param {string[]} [opts.header] - Repeatable `"Key: Value"` header strings.
 * @param {string[]} [opts.cookie] - Repeatable `"name=value; Domain=..."` cookie strings.
 * @returns {Promise<{ contextOptions: object, cookies: object[] }>} Options to
 *   pass to `browser.newContext()`, and a list of cookies to inject via
 *   `context.addCookies()`.
 */
export async function buildContextOptions(opts) {
  const contextOptions = {};
  const extraHeaders = {};

  if (opts.session) {
    contextOptions.storageState = opts.session;
  }

  if (opts.bearer) {
    extraHeaders.Authorization = `Bearer ${opts.bearer}`;
  }

  if (opts.header && opts.header.length) {
    for (const h of opts.header) {
      const idx = h.indexOf(':');
      if (idx === -1) continue;
      const key = h.slice(0, idx).trim();
      const value = h.slice(idx + 1).trim();
      extraHeaders[key] = value;
    }
  }

  if (Object.keys(extraHeaders).length) {
    contextOptions.extraHTTPHeaders = extraHeaders;
  }

  return { contextOptions, cookies: parseCookies(opts.cookie) };
}

/**
 * Parses repeatable `--cookie` flag values into Playwright cookie objects.
 *
 * Each flag must be of the form `"name=value; Domain=example.com"` (an
 * optional `Path=` attribute is also recognised; it defaults to `/`).
 *
 * @param {string[]} [cookieFlags] - Raw `--cookie` flag values.
 * @returns {object[]} Playwright-compatible cookie objects (`{ name, value, domain, path }`).
 * @throws {Error} If a cookie flag is missing its required `Domain=` attribute.
 */
export function parseCookies(cookieFlags) {
  if (!cookieFlags || !cookieFlags.length) return [];
  const cookies = [];
  for (const flag of cookieFlags) {
    const parts = flag.split(';').map((p) => p.trim());
    const [nameValue, ...attrs] = parts;
    const eq = nameValue.indexOf('=');
    if (eq === -1) continue;
    const name = nameValue.slice(0, eq);
    const value = nameValue.slice(eq + 1);
    const cookie = { name, value, path: '/' };
    for (const attr of attrs) {
      const [k, v] = attr.split('=').map((s) => s.trim());
      if (/domain/i.test(k)) cookie.domain = v;
      if (/path/i.test(k)) cookie.path = v;
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