// src/browser.js
import { chromium } from 'playwright';

/**
 * Launches headless Chromium, turning Playwright's "Executable doesn't
 * exist" failure — which is what you get when the browser download was
 * skipped or failed during `npm install` — into an actionable message
 * instead of a multi-line Playwright banner.
 *
 * @returns {Promise<import('playwright').Browser>} The launched browser.
 * @throws {Error} With install instructions if Chromium is missing; otherwise the original launch error.
 */
export async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (err) {
    if (/Executable doesn't exist|playwright install/i.test(err?.message ?? '')) {
      throw new Error(
        "Chromium isn't installed for Playwright. Run:  npx playwright install chromium",
        { cause: err },
      );
    }
    throw err;
  }
}