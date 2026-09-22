/**
 * Captures a screenshot of a single element on the page, cropped tightly to
 * that element's rendered bounding box — instead of the full page or a
 * sequence of viewport-height sections.
 *
 * This is intended for cases where only one region of a page is meaningful
 * as a standalone image — most commonly a page's "Hero" section — such as
 * generating a social-share (OG) preview image that reflects a page's real,
 * rendered design rather than a full-page screenshot or a hand-built card.
 *
 * The function:
 *
 * 1. Waits briefly for client-side content to finish rendering.
 * 2. Waits for the target selector to be attached and visible.
 * 3. Scrolls the element into view (in case it isn't within the initial
 *    viewport), so any scroll-triggered animations/lazy content have a
 *    chance to settle before capture.
 * 4. Captures a screenshot scoped to just that element via Playwright's
 *    element-handle `screenshot()`, which crops to the element's own
 *    bounding box rather than the full viewport.
 *
 * @param {import('playwright').Page} page
 *   Playwright page instance containing the page to capture.
 *
 * @param {string} selector
 *   CSS selector identifying the single element to capture. Must match
 *   exactly one element; if it matches zero, only the first match is used
 *   (Playwright's default `locator` behavior) — callers that need strict
 *   single-match validation should check `locator.count()` themselves.
 *
 * @param {string} outDirPath
 *   Directory where the generated screenshot will be written.
 *
 * @param {typeof import('node:path')} path
 *   Node.js `path` module used to construct the screenshot file path.
 *
 * @param {typeof import('node:fs/promises')} fs
 *   Node.js promise-based filesystem module. Retained for interface
 *   consistency with `captureSections`, though the current implementation
 *   does not perform filesystem operations through it directly.
 *
 * @param {(...args: unknown[]) => void} [debug=() => {}]
 *   Optional diagnostic logger.
 *
 * @param {{ timeout?: number }} [options={}]
 *   `timeout` — how long (ms) to wait for the selector to become visible
 *   before failing. Defaults to 15000.
 *
 * @returns {Promise<string[]>}
 *   A single-element array containing the path to the generated screenshot,
 *   kept as an array so this function is a drop-in alternative to
 *   `captureSections` / the full-page capture path in `capture.js`.
 *
 * @throws {Error} If the selector never becomes visible within the timeout.
 *
 * @example
 * const files = await captureElement(
 *   page,
 *   '[data-og-hero]',
 *   './screenshots',
 *   path,
 *   fs,
 *   console.log,
 * );
 * // ['./screenshots/element-1200x630.png']
 */
export async function captureElement(
  page,
  selector,
  outDirPath,
  path,
  fs,
  debug = () => {},
  options = {},
) {
  const timeout = options.timeout ?? 15000;

  // Allow Next.js/client-rendered content to finish its first paint before
  // we start looking for the element.
  await page.waitForTimeout(500);

  const locator = page.locator(selector).first();

  debug(`Waiting for element capture selector to be visible: "${selector}"`);

  await locator.waitFor({ state: 'visible', timeout });

  // Scroll it into view defensively — some layouts only finish sizing
  // correctly once the element has been scrolled to, and this also gives
  // any scroll-triggered entrance animation a moment to settle.
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  const box = await locator.boundingBox();
  if (!box || box.width === 0 || box.height === 0) {
    throw new Error(
      `Element capture selector "${selector}" matched an element with no ` +
      `visible size (width=${box?.width ?? 0}, height=${box?.height ?? 0}). ` +
      `Nothing was captured.`,
    );
  }

  debug(
    `Element bounding box for "${selector}": ` +
    `${Math.round(box.width)}x${Math.round(box.height)}`,
  );

  const fileName =
    `element-${Math.round(box.width)}x${Math.round(box.height)}.png`;
  const filePath = path.join(outDirPath, fileName);

  await locator.screenshot({ path: filePath });

  debug(`Wrote element screenshot: ${filePath}`);

  return [filePath];
}
