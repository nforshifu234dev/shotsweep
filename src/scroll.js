// src/scroll.js

/**
 * Gets a page's images into a final state before it is screenshotted, with
 * every step bounded so one bad image can't hang the run:
 *
 * 1. Re-request images that were *aborted or failed* earlier (for example
 *    cancelled by `window.stop()` after a `load` timeout). An aborted image
 *    never retries on its own and renders as its alt text.
 * 2. Wait for everything still loading, up to `imageWaitMs`.
 * 3. Count what is still unfinished, so the caller can warn about it.
 * 4. Cancel requests that are *still* in flight. This matters: Playwright's
 *    screenshot waits on pending page resources, so a stalled image would
 *    otherwise make the screenshot itself time out and fail the whole capture
 *    instead of just leaving that one image blank.
 *
 * @param {import('playwright').Page} page - The page whose images should settle.
 * @param {object} [options]
 * @param {number} [options.imageWaitMs=10000] - Maximum time to wait for loading images.
 * @returns {Promise<{ total: number, stillLoading: number, broken: number }>}
 *   Image counts taken *before* stalled requests were cancelled. `stillLoading`
 *   and `broken` are the images that will appear blank or as alt text.
 */
export async function settleImages(page, { imageWaitMs = 10000 } = {}) {
  const stats = await page.evaluate(async ({ imageWaitMs }) => {
    const hasSource = (img) => Boolean(img.currentSrc || img.getAttribute('src'));
    const isBroken = (img) => img.complete && img.naturalWidth === 0 && hasSource(img);

    for (const img of document.images) {
      if (isBroken(img)) {
        // Assigning src re-runs the browser's image-loading algorithm even
        // when the value is unchanged.
        const src = img.getAttribute('src');
        if (src) img.src = src;
      }
    }

    const pending = Array.from(document.images).filter((img) => !img.complete);
    const settled = Promise.all(
      pending.map(
        (img) =>
          new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          }),
      ),
    );
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, imageWaitMs))]);

    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }

    const all = Array.from(document.images);
    const result = {
      total: all.length,
      stillLoading: all.filter((img) => !img.complete).length,
      broken: all.filter(isBroken).length,
    };

    // Give up on whatever is still in flight so the screenshot can proceed.
    if (result.stillLoading > 0) window.stop();

    return result;
  }, { imageWaitMs });

  return stats;
}

/**
 * Scrolls a page from top to bottom and back, so content that only appears
 * once it enters the viewport actually gets a chance to.
 *
 * Why this exists: a full-page screenshot is taken from a page that has
 * never been scrolled. Modern sites reveal sections with an
 * IntersectionObserver (fade/slide-in animations, AOS, GSAP ScrollTrigger…)
 * and lazy-load images with `loading="lazy"`. Anything below the first
 * screen is still in its hidden, pre-reveal state at capture time, which
 * produces screenshots with large blank areas.
 *
 * The scroll walks one viewport at a time (so every region intersects the
 * viewport), re-reading the page height each step because lazy content can
 * make the page grow while scrolling. It is bounded by both a time budget
 * and a height budget so infinite-scroll feeds can't make it run forever.
 * Afterwards it returns to the top, waits for pending images and web fonts
 * (each with its own cap), and gives reveal transitions a moment to finish.
 *
 * Failures are swallowed: a page that throws or navigates mid-scroll should
 * still be captured as-is rather than fail the job.
 *
 * @param {import('playwright').Page} page - The page to warm up.
 * @param {object} [options]
 * @param {number} [options.delayMs=120] - Pause between scroll steps.
 * @param {number} [options.maxMs=20000] - Total time budget for the scroll pass.
 * @param {number} [options.maxHeight=60000] - Stop scrolling past this many pixels (infinite-scroll guard).
 * @param {number} [options.settleMs=500] - Final pause for reveal transitions after returning to the top.
 * @param {number} [options.imageWaitMs=10000] - How long to wait for images that are still loading (or were cancelled and got re-requested) before giving up on them.
 * @param {(...args: unknown[]) => void} [options.debug] - Optional debug logger.
 * @returns {Promise<{ scrolledTo: number, pageHeight: number, truncated: boolean, images: { total: number, stillLoading: number, broken: number } } | null>}
 *   Scroll and image statistics, or `null` if the warm-up couldn't run.
 */
export async function autoScroll(page, options = {}) {
  const {
    delayMs = 120,
    maxMs = 20000,
    maxHeight = 60000,
    settleMs = 500,
    imageWaitMs = 10000,
    debug = () => {},
  } = options;

  let stats = null;

  try {
    stats = await page.evaluate(
      async ({ delayMs, maxMs, maxHeight }) => {
        const started = Date.now();
        const scroller = document.scrollingElement || document.documentElement;
        const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
        let truncated = false;
        let stableTicks = 0;
        let stuckTicks = 0;
        let lastHeight = scroller.scrollHeight;

        while (true) {
          const before = scroller.scrollTop;
          scroller.scrollTo({ top: before + step, behavior: 'instant' });
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          // Scrolling can be locked (body overflow hidden, open modal). Don't
          // burn the whole time budget waiting for a scroll that never moves.
          stuckTicks = scroller.scrollTop === before ? stuckTicks + 1 : 0;
          if (stuckTicks >= 5) break;

          const height = scroller.scrollHeight;
          const atBottom = scroller.scrollTop + window.innerHeight >= height - 2;

          if (atBottom) {
            // Lazy content may extend the page once we reach the bottom;
            // only stop after the height has been stable for a few ticks.
            stableTicks = height === lastHeight ? stableTicks + 1 : 0;
            if (stableTicks >= 2) break;
          } else {
            stableTicks = 0;
          }
          lastHeight = height;

          if (scroller.scrollTop >= maxHeight || Date.now() - started > maxMs) {
            truncated = true;
            break;
          }
        }

        const scrolledTo = scroller.scrollTop;
        const pageHeight = scroller.scrollHeight;
        scroller.scrollTo({ top: 0, behavior: 'instant' });
        return { scrolledTo, pageHeight, truncated };
      },
      { delayMs, maxMs, maxHeight },
    );

    stats.images = await settleImages(page, { imageWaitMs });

    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(settleMs);

    debug(
      `Scroll warm-up: scrolled to ${stats.scrolledTo}px of ${stats.pageHeight}px` +
        (stats.truncated ? ' (stopped early: time/height budget reached)' : '') +
        `; images: ${stats.images.total} total, ${stats.images.stillLoading} still loading, ${stats.images.broken} broken`,
    );
  } catch (err) {
    debug(`Scroll warm-up skipped: ${err.message}`);
    return null;
  }

  return stats;
}