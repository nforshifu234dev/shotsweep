/**
 * Captures a page as a sequence of viewport-height screenshots.
 *
 * ShotSweep normally captures the browser's document viewport. However,
 * some applications — especially documentation sites, dashboards, and
 * client-rendered applications — may place their actual scrolling content
 * inside an inner element rather than directly on the document.
 *
 * This function therefore:
 *
 * 1. Waits briefly for client-side content to finish rendering.
 * 2. Measures the document's total scrollable height.
 * 3. Detects scrollable inner elements for diagnostic purposes.
 * 4. Prefers document-level scrolling when the document itself is taller
 *    than the configured viewport.
 * 5. Falls back to the largest detected inner scroll container when the
 *    document is not taller than the viewport.
 * 6. Divides the scrollable content into viewport-height sections.
 * 7. Scrolls to each section and captures a normal viewport screenshot.
 * 8. Returns the page to the top after capture completes.
 *
 * The function intentionally does not use `fullPage: true`. Each generated
 * image represents one viewport-sized portion of the page.
 *
 * @param {import('playwright').Page} page
 *   Playwright page instance containing the page to capture.
 *
 * @param {{ width: number, height: number }} viewport
 *   Active viewport dimensions used for the capture.
 *   The `height` determines the vertical size of each section.
 *
 * @param {string} outDirPath
 *   Directory where the generated section screenshots will be written.
 *
 * @param {typeof import('node:path')} path
 *   Node.js `path` module used to construct screenshot file paths.
 *
 * @param {typeof import('node:fs/promises')} fs
 *   Node.js promise-based filesystem module.
 *
 *   This parameter is retained for compatibility with the capture
 *   pipeline, although the current implementation does not directly
 *   perform filesystem operations through it.
 *
 * @param {(...args: unknown[]) => void} [debug=() => {}]
 *   Optional diagnostic logger. When provided, detailed information about
 *   document dimensions, detected scroll containers, section counts, and
 *   generated files is emitted through this callback.
 *
 * @returns {Promise<string[]>}
 *   Absolute or output-relative paths to all generated section
 *   screenshots, in capture order.
 *
 * @example
 * const files = await captureSections(
 *   page,
 *   { width: 1440, height: 900 },
 *   './screenshots',
 *   path,
 *   fs,
 *   console.log,
 * );
 *
 * // [
 * //   './screenshots/section-01-1440x900.png',
 * //   './screenshots/section-02-1440x900.png',
 * //   './screenshots/section-03-1440x900.png'
 * // ]
 */
export async function captureSections(
  page,
  viewport,
  outDirPath,
  path,
  fs,
  debug = () => {},
) {
  // Allow Next.js/Nextra/client-side content to finish rendering.
  await page.waitForTimeout(500);

  /**
   * Collect information about the document and any nested scrollable
   * elements.
   *
   * The diagnostic pass is intentionally performed inside the browser
   * context because values such as `scrollHeight`, `clientHeight`,
   * `overflowY`, and computed styles only exist meaningfully there.
   */
  const diagnostics = await page.evaluate(() => {
    const documentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
    );

    const viewportHeight = window.innerHeight;

    const scrollables = Array.from(document.querySelectorAll('*'))
      .map((el) => {
        const style = getComputedStyle(el);

        return {
          tag: el.tagName,
          id: el.id,
          className:
            typeof el.className === 'string' ? el.className : '',
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          overflowY: style.overflowY,
          rectHeight: el.getBoundingClientRect().height,
        };
      })
      .filter(
        (item) =>
          item.scrollHeight > item.clientHeight + 2 &&
          ['auto', 'scroll'].includes(item.overflowY),
      )
      .sort((a, b) => b.scrollHeight - a.scrollHeight);

    return {
      documentHeight,
      viewportHeight,
      scrollables: scrollables.slice(0, 20),
    };
  });

  debug(
    'Scroll diagnostics:',
    JSON.stringify(diagnostics, null, 2),
  );

  /*
   * IMPORTANT:
   *
   * Prefer the document when the document itself is taller than
   * the viewport. This prevents things like <pre>, <code>, tables,
   * sidebars, etc. from being incorrectly selected as the page's
   * main scroll container.
   */
  const useDocumentScroll =
    diagnostics.documentHeight > viewport.height + 2;

  /**
   * Playwright handle for the selected inner scroll container.
   *
   * This remains `null` when the document itself is used as the
   * scrolling surface.
   *
   * @type {import('playwright').ElementHandle<Element> | null}
   */
  let container = null;

  /**
   * Total vertical content height that will be divided into sections.
   *
   * @type {number}
   */
  let totalHeight = diagnostics.documentHeight;

  if (!useDocumentScroll) {
    container = await page.evaluateHandle(() => {
      const candidates = Array.from(document.querySelectorAll('*'));

      const scrollable = candidates
        .map((el) => {
          const style = getComputedStyle(el);

          return {
            el,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            overflowY: style.overflowY,
          };
        })
        .filter(
          (item) =>
            item.scrollHeight > item.clientHeight + 2 &&
            ['auto', 'scroll'].includes(item.overflowY),
        )
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];

      return scrollable?.el || document.scrollingElement;
    });

    /**
     * Read identifying and dimensional information about the selected
     * inner scroll container for debugging and section calculations.
     */
    const containerInfo = await container.evaluate((el) => ({
      tag: el.tagName,
      id: el.id,
      className:
        typeof el.className === 'string' ? el.className : '',
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));

    totalHeight = Math.max(
      containerInfo.scrollHeight,
      viewport.height,
    );

    debug(
      `Selected inner scroll container: ${JSON.stringify(containerInfo)}`,
    );
  } else {
    debug(
      `Using document scroll container: document, ` +
      `documentHeight=${diagnostics.documentHeight}`,
    );
  }

  /**
   * Height of one captured section.
   *
   * This comes from the configured viewport rather than the browser's
   * current `window.innerHeight`, because ShotSweep's viewport option
   * defines the dimensions of the output image.
   *
   * @type {number}
   */
  const viewportHeight = viewport.height;

  /**
   * Number of viewport-sized screenshots required to cover the complete
   * scrollable content.
   *
   * The final section may contain less content than a complete viewport,
   * but it is still captured at the configured viewport dimensions.
   *
   * @type {number}
   */
  const sectionCount = Math.max(
    1,
    Math.ceil(totalHeight / viewportHeight),
  );

  debug(
    `Section capture: totalHeight=${totalHeight}, ` +
    `viewportHeight=${viewportHeight}, ` +
    `sectionCount=${sectionCount}, ` +
    `scrollContainer=${useDocumentScroll ? 'document' : 'inner'}`,
  );

  /**
   * Paths to all successfully generated screenshots.
   *
   * @type {string[]}
   */
  const files = [];

  for (let i = 0; i < sectionCount; i++) {
    /**
     * Vertical scroll position for the current section.
     *
     * Section positions are based on the configured viewport height:
     *
     *   section 1 → 0
     *   section 2 → viewportHeight
     *   section 3 → viewportHeight * 2
     *
     * @type {number}
     */
    const scrollY = i * viewportHeight;

    if (useDocumentScroll) {
      await page.evaluate((y) => {
        window.scrollTo({
          top: y,
          behavior: 'instant',
        });
      }, scrollY);
    } else {
      await container.evaluate((el, y) => {
        el.scrollTo({
          top: y,
          behavior: 'instant',
        });
      }, scrollY);
    }

    // Give the browser a moment to finish the scroll and repaint the viewport.
    await page.waitForTimeout(150);

    /**
     * Deterministic filename for the current section.
     *
     * Example:
     * `section-01-1440x900.png`
     */
    const fileName =
      `section-${String(i + 1).padStart(2, '0')}-` +
      `${viewport.width}x${viewport.height}.png`;

    const filePath = path.join(outDirPath, fileName);

    /**
     * Capture only the currently visible viewport.
     *
     * `fullPage: false` is critical here: the purpose of this mode is
     * to create multiple viewport-sized images instead of one full-page
     * image.
     */
    await page.screenshot({
      path: filePath,
      fullPage: false,
    });

    files.push(filePath);

    debug(
      `Wrote section screenshot: ${filePath} ` +
      `(scrollY=${scrollY})`,
    );
  }

  // Return to the top so the Playwright page is left in a predictable state.
  if (useDocumentScroll) {
    await page.evaluate(() => {
      window.scrollTo({
        top: 0,
        behavior: 'instant',
      });
    });
  } else {
    await container.evaluate((el) => {
      el.scrollTo({
        top: 0,
        behavior: 'instant',
      });
    });
  }

  debug(
    `Section capture complete, returning ${files.length} file(s)`,
  );

  return files;
}