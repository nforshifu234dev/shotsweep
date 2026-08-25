// src/describe.js

/**
 * Builds a plain-text, AI-ready summary of a capture run's manifest,
 * suitable for pasting into a model for visual review. Groups screenshots by
 * page, lists viewports and capture mode counts per page, lists any failed
 * captures, and appends a fixed set of review instructions for an AI reader.
 *
 * @param {object[]} manifest - The manifest entries produced by a capture run.
 * @param {string} manifest[].url - The URL the entry was captured from.
 * @param {string} [manifest[].viewport] - The `WxH` viewport string for the entry.
 * @param {string} [manifest[].mode] - The capture mode for the entry (`'full'` or `'sections'`).
 * @param {string} [manifest[].error] - Present if this entry failed to capture.
 * @param {object} options - Run-level context used in the summary header.
 * @param {string} options.out - The output directory the run was written to.
 * @param {string} [options.mode] - The capture mode for the run as a whole (defaults to `'mixed'` if omitted).
 * @returns {string} A multi-line, human/AI-readable text summary of the run.
 */
export function buildAiDescription(manifest, { out, mode }) {
  const successful = manifest.filter((m) => !m.error);
  const failed = manifest.filter((m) => m.error);

  const byUrl = {};

  for (const entry of successful) {
    byUrl[entry.url] ??= [];
    byUrl[entry.url].push(entry);
  }

  const pages = Object.entries(byUrl);

  const lines = [
    'Screenshot batch summary',
    '========================',
    '',
    `Screenshots: ${successful.length}`,
    `Pages: ${pages.length}`,
    `Mode: ${mode ?? 'mixed'}`,
    `Output: ${out}`,
  ];

  if (failed.length) {
    lines.push(`Failed: ${failed.length}`);
  }

  lines.push('', 'Pages captured:', '');

  for (const [url, entries] of pages) {
    const viewports = [...new Set(entries.map((e) => e.viewport))];

    const sectionCount = entries.filter(
      (e) => e.mode === 'sections',
    ).length;

    const fullCount = entries.filter(
      (e) => e.mode === 'full',
    ).length;

    const details = [];

    if (sectionCount) {
      details.push(
        `${sectionCount} section screenshot${sectionCount === 1 ? '' : 's'}`
      );
    }

    if (fullCount) {
      details.push(
        `${fullCount} full-page screenshot${fullCount === 1 ? '' : 's'}`
      );
    }

    lines.push(`- ${url}`);
    lines.push(`  Screenshots: ${entries.length}`);
    lines.push(`  Viewports: ${viewports.join(', ')}`);

    if (details.length) {
      lines.push(`  Capture: ${details.join(', ')}`);
    }

    lines.push('');
  }

  if (failed.length) {
    lines.push('Failed captures:', '');

    for (const entry of failed) {
      lines.push(
        `- ${entry.url} (${entry.viewport}) — ${entry.error}`
      );
    }

    lines.push('');
  }

  lines.push(
    'AI review instructions:',
    'Attach the screenshot files listed in manifest.json and review them for:',
    '- visual hierarchy and layout',
    '- responsive behavior across viewports',
    '- spacing, typography, and consistency',
    '- accessibility concerns',
    '- obvious visual regressions or rendering issues',
    '',
    'Compare related screenshots where multiple viewports or capture modes are available.'
  );

  return lines.join('\n');
}