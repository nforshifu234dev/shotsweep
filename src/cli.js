import { readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { chromium } from 'playwright';
import { runCapture } from './capture.js';
import { recordLoginSession } from './auth.js';
import { loadConfig, mergeOptions } from './config.js';
import { buildAiDescription } from './describe.js';
import { runDiff, normalizeThreshold, THRESHOLD_PRESETS } from './diff.js';
import { createDebugLogger } from './debug.js';
import { zipOutput } from './zip.js';

/**
 * Reads `name`/`description`/`version` from the package's own `package.json`
 * (resolved relative to this file, so it works regardless of the caller's
 * cwd or how the CLI was installed) so they don't have to be hand-typed and
 * kept in sync separately. Falls back to hardcoded defaults if the file
 * can't be found or parsed, so a packaging/bundling quirk can't crash the CLI.
 *
 * @returns {{ name: string, description: string, version: string }}
 */
function loadPackageMeta() {
  const fallback = {
    name: 'shotsweep',
    description:
      'Screenshot a URL, an array, a CSV, or a whole sitemap — full page or sectioned.',
    version: '0.0.0',
  };

  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(dir, '../package.json'), 'utf8'));

    return {
      // The CLI's invoked name should match its `bin` entry (e.g. "shotsweep"),
      // not the npm package name (e.g. "@nfsfu234/shotsweep").
      name: pkg.bin ? Object.keys(pkg.bin)[0] : fallback.name,
      description: pkg.description || fallback.description,
      version: pkg.version || fallback.version,
    };
  } catch {
    return fallback;
  }
}

const pkgMeta = loadPackageMeta();

/**
 * Commander option callback used for repeatable CLI flags (e.g. `--viewport`,
 * `--header`, `--cookie`). Appends the newly parsed value onto the array of
 * previously collected values.
 *
 * @param {string} value - The raw value passed for this occurrence of the flag.
 * @param {string[]} previous - The values collected from earlier occurrences of the flag.
 * @returns {string[]} A new array containing `previous` with `value` appended.
 */
function collect(value, previous) {
  return previous.concat([value]);
}

/**
 * Builds the human-readable status line describing how the list of target
 * URLs was resolved (sitemap, CSV, file, paths, or a generic fallback), used
 * to update the spinner once URL resolution completes.
 *
 * @param {object} options - The merged capture options for the current run.
 * @param {string} [options.sitemap] - Sitemap URL, if URLs were resolved from a sitemap.
 * @param {string} [options.csv] - CSV file path, if URLs were resolved from a CSV.
 * @param {string} [options.urls] - URLs file path, if URLs were resolved from a file.
 * @param {string} [options.paths] - Paths file path, if URLs were resolved from relative paths.
 * @param {number} count - The number of URLs that were resolved.
 * @returns {string} A colorized, human-readable summary message (e.g. "Resolved 12 URLs from sitemap").
 */
function getResolutionMessage(options, count) {
  const noun = count === 1 ? 'URL' : 'URLs';

  if (options.sitemap) {
    return `Resolved ${chalk.green(count)} ${noun} from ${chalk.cyan('sitemap')}`;
  }

  if (options.csv) {
    return `Resolved ${chalk.green(count)} ${noun} from ${chalk.cyan('CSV')}`;
  }

  if (options.urls) {
    return `Resolved ${chalk.green(count)} ${noun} from ${chalk.cyan('file')}`;
  }

  if (options.paths) {
    return `Resolved ${chalk.green(count)} ${noun} from ${chalk.cyan('paths')}`;
  }

  return `Resolved ${chalk.green(count)} ${noun}`;
}

/**
 * Formats a duration in milliseconds into a short, human-readable string,
 * choosing the most appropriate unit (milliseconds, seconds, or minutes and
 * seconds) depending on magnitude.
 *
 * @param {number} ms - The duration to format, in milliseconds.
 * @returns {string} The formatted duration, e.g. "850ms", "3.2s", "2m", or "2m 5s".
 */
function formatDuration(ms) {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = ms / 1000;

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);

  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Builds a human-readable visual regression summary from a diff result.
 *
 * The summary is intentionally plain text so it can be:
 * - printed directly to the terminal,
 * - written to a `.txt` file for CI artifacts,
 * - consumed easily by humans or AI tooling.
 *
 * @param {object} summary - Visual regression counts returned by `runDiff`.
 * @param {number} summary.regressions - Number of failing visual regressions.
 * @param {number} summary.changed - Number of pages with pixel-level changes.
 * @param {number} summary.sizeChanged - Number of pages whose dimensions changed.
 * @param {number} summary.unchanged - Number of pages with no visual changes.
 * @param {number} summary.added - Number of newly added pages.
 * @param {number} summary.removed - Number of removed pages.
 * @returns {string} A formatted, human-readable visual regression summary.
 */
function buildDiffSummary(summary) {
  const regressionLabel =
    `${summary.regressions} regression${summary.regressions === 1 ? '' : 's'}`;

  return [
    'Visual regression summary',
    '=========================',
    '',
    regressionLabel,
    '',
    `  Changed   : ${summary.changed}`,
    `  Resized   : ${summary.sizeChanged}`,
    `  Unchanged : ${summary.unchanged}`,
    `  Added     : ${summary.added}`,
    `  Removed   : ${summary.removed}`,
  ].join('\n');
}

/**
 * Builds and runs the ShotSweep CLI program.
 *
 * Registers three subcommands:
 * - `capture`: resolves a set of target URLs (from a single URL, a file, a
 *   CSV, a sitemap, or a base URL + relative paths) and screenshots each one,
 *   optionally across multiple viewports, with support for auth (bearer
 *   token, headers, cookies, or a saved login session), retries, concurrency,
 *   zipping the output, and printing an AI-ready description of the run.
 * - `login`: drives a login form in a real browser once and saves the
 *   resulting storage state to disk so it can be reused via `capture --session`.
 * - `diff`: compares the manifests from two previous `capture` runs and
 *   reports/produces images for pages that changed, were added, or were
 *   removed. Like `capture`, it reads `shotsweep.config.json` /
 *   `.shotsweeprc.json` and merges it with any CLI flags passed to `diff`.
 *
 * @param {string[]} argv - The process argument vector to parse (typically `process.argv`).
 * @returns {void}
 */
export function run(argv) {
  const program = new Command();

  program
    .name(pkgMeta.name)
    .description(pkgMeta.description)
    .version(pkgMeta.version);

  program
    .command('capture')
    .description('Take screenshots of one or more pages')
    .option('--url <url>', 'single URL to capture')
    .option('--urls <file>', 'JSON array or newline-delimited file of URLs')
    .option('--csv <file>', 'CSV file containing a column of URLs')
    .option(
      '--csv-column <name>',
      'column name in the CSV holding the URL (auto-detected if omitted)',
    )
    .option('--sitemap <url>', 'sitemap.xml URL to fetch and parse')
    .option(
      '--base <url>',
      'base URL to prepend to --paths (for localhost / staging runs)',
    )
    .option(
      '--paths <file>',
      'JSON array or newline-delimited file of relative paths, used with --base',
    )
    .option('--mode <mode>', 'full or sections', 'full')
    .option(
      '--viewport <WxH>',
      'repeatable, e.g. --viewport 1440x900',
      collect,
      [],
    )
    .option('--wait <ms|selector>', 'wait a fixed ms or for a CSS selector before capturing')
    .option(
      '--wait-until <domcontentloaded|load|networkidle>',
      'when to consider a page "loaded" before capturing',
      (value) => {
        const valid = ['domcontentloaded', 'load', 'networkidle'];
        if (!valid.includes(value)) {
          throw new Error(`Invalid --wait-until "${value}". Expected one of: ${valid.join(', ')}.`);
        }
        return value;
      },
      'load',
    )
    .option(
      '--replace-origin <url>',
      "rewrite every resolved URL's origin to this",
    )
    .option('--limit <n>', 'only capture the first N resolved URLs', (v) => parseInt(v, 10))
    .option('--offset <n>', 'skip the first N resolved URLs before capturing', (v) => parseInt(v, 10), 0)
    .option('--dark', 'emulate prefers-color-scheme: dark', false)
    .option('--out <dir>', 'output directory', './screenshots')
    .option('--session <file>', 'reuse a saved storageState session')
    .option('--bearer <token>', 'sets Authorization: Bearer <token> on every request')
    .option(
      '--header <"Key: Value">',
      'repeatable, arbitrary request header',
      collect,
      [],
    )
    .option(
      '--cookie <"name=value; Domain=...">',
      'repeatable cookie to inject',
      collect,
      [],
    )
    .option(
      '--concurrency <n>',
      'pages captured in parallel',
      /**
       * Commander parser for `--concurrency`. Validates that the value is a
       * positive integer.
       *
       * @param {string} value - The raw flag value.
       * @returns {number} The parsed, validated concurrency count.
       * @throws {Error} If `value` is not a positive integer.
       */
      (value) => {
        const parsed = Number.parseInt(value, 10);

        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`Invalid --concurrency value "${value}". Expected a positive integer.`);
        }

        return parsed;
      },
      1,
    )
    .option(
      '--timeout <ms>',
      'timeout for each page load',
      /**
       * Commander parser for `--timeout`. Validates that the value is a
       * positive integer number of milliseconds.
       *
       * @param {string} value - The raw flag value.
       * @returns {number} The parsed, validated timeout in milliseconds.
       * @throws {Error} If `value` is not a positive integer.
       */
      (value) => {
        const parsed = Number.parseInt(value, 10);

        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`Invalid --timeout value "${value}". Expected a positive integer.`);
        }

        return parsed;
      },
      30000,
    )
    .option(
      '--retries <n>',
      'retry a failed page load this many times',
      /**
       * Commander parser for `--retries`. Validates that the value is zero or
       * a positive integer.
       *
       * @param {string} value - The raw flag value.
       * @returns {number} The parsed, validated retry count.
       * @throws {Error} If `value` is not zero or a positive integer.
       */
      (value) => {
        const parsed = Number.parseInt(value, 10);

        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`Invalid --retries value "${value}". Expected 0 or a positive integer.`);
        }

        return parsed;
      },
      0,
    )
    .option('--resume', 'skip URL/viewport pairs already captured successfully in --out (based on its existing manifest.json)', false)
    .option('--verbose', 'print one line per completed job as it finishes, instead of only the live spinner', false)
    .option(
      '--zip',
      'also bundle the output directory into a .zip after capture',
      false,
    )
    .option(
      '--dry-run',
      'resolve and print target URLs without capturing anything',
      false,
    )
    .option(
      '--json',
      'print the final result as one JSON line instead of colored output',
      false,
    )
    .option(
      '--debug',
      'show detailed diagnostic output while running',
      false,
    )
    .option('--quiet', 'suppress the live progress line', false)
    .option(
      '--describe',
      'print an AI-ready summary of the captured screenshots',
      false,
    )
    /**
     * Action handler for `shotsweep capture`.
     *
     * Loads and merges config/CLI options, then either performs a dry run
     * (resolving and printing target URLs without capturing) or runs a full
     * capture, printing progress via a spinner (unless `--quiet`/`--json`)
     * and a final summary of successes, failures, timing, manifest location,
     * and optional zip/description output. Sets a non-zero exit code on any
     * capture failures or a thrown error.
     *
     * @param {object} opts - Parsed Commander options for the `capture` command.
     * @param {import('commander').Command} command - The Commander command instance.
     * @returns {Promise<void>}
     */
    .action(async (opts, command) => {
      const config = await loadConfig();
      const merged = mergeOptions(config, opts, command);
      const debug = createDebugLogger(merged.debug);

      if (merged.dryRun) {
        const { targets } = await runCapture({
          ...merged,
          debug,
        });

        if (merged.json) {
          console.log(JSON.stringify({ dryRun: true, targets }));
        } else {
          console.log(
            chalk.cyan(
              `Would capture ${targets.length} URL${
                targets.length === 1 ? '' : 's'
              }:`,
            ),
          );

          targets.forEach((url) => {
            console.log(chalk.dim(`  ${url}`));
          });
        }

        return;
      }

      const spinner = merged.quiet || merged.json ? null : ora('Resolving URLs...').start();
      try {
        const result = await runCapture({
          ...merged,
          debug,

          onResolved: (targets) => {
            if (!spinner) return;

            spinner.succeed(getResolutionMessage(merged, targets.length));
            spinner.start('Capturing screenshots...');
          },

          onProgress: spinner
            ? ({ completed, total, url, ok }) => {
                const status = ok
                  ? chalk.green('✓')
                  : chalk.red('✗');

                spinner.text =
                  `${status} ${chalk.dim(url)} ` +
                  `${chalk.cyan(`${completed}/${total}`)}`;
              }
            : undefined,
        });

        const { manifest, manifestPath, zipPath, durationMs, total } = result;
        const successful = manifest.filter((entry) => !entry.error).length;
        const failed = manifest.filter((entry) => entry.error).length;
        const seconds = (durationMs / 1000).toFixed(1);
        const avgMs = total ? Math.round(durationMs / total) : 0;
        const avgSeconds = total ? (durationMs / total / 1000).toFixed(1) : '0.0';

        const duration = formatDuration(durationMs);
        const average = total
          ? formatDuration(durationMs / total)
          : '0ms';

        if (merged.json) {
          console.log(JSON.stringify({
            ok: successful,
            failed,
            total,
            durationMs,
            avgMs,
            manifestPath,
            zipPath,
          }));
        } else {
          spinner?.succeed(
            `Captured ${chalk.green(successful)} screenshot${successful === 1 ? '' : 's'}` +
              (failed ? `, ${chalk.red(failed + ' failed')}` : '') +
              ` → ${chalk.cyan(merged.out)}`
          );
          console.log(chalk.dim(`Done in ${duration} (avg ${average}/page)`));
          console.log(chalk.dim(`Manifest: ${manifestPath}`));
          if (zipPath) console.log(chalk.dim(`Zip: ${zipPath}`));
          if (merged.describe) {
            console.log('\n' + chalk.dim('--- AI description ---'));
            console.log(buildAiDescription(manifest, merged));
          }
        }
        if (failed) process.exitCode = 1;
      } catch (err) {
        if (merged.json) {
          console.log(JSON.stringify({ error: err.message }));
        } else {
          spinner?.fail(chalk.red(err.message));
          if (merged.debug) console.error(err.stack);
        }
        process.exitCode = 1;
      }
    });

  program
    .command('login')
    .description('Drive a login form once and save the session for reuse with `capture --session`')
    .requiredOption('--login-url <url>', 'page containing the login form')
    .requiredOption('--email-selector <css>', 'CSS selector for the email/username field')
    .requiredOption('--password-selector <css>', 'CSS selector for the password field')
    .requiredOption('--submit-selector <css>', 'CSS selector for the submit button')
    .option('--email <value>', 'email/username (or set SHOTSWEEP_EMAIL)')
    .option('--password <value>', 'password (or set SHOTSWEEP_PASSWORD)')
    .option('--session-out <file>', 'where to save the session', './auth.json')
    /**
     * Action handler for `shotsweep login`.
     *
     * Launches a headless Chromium browser, drives the specified login form
     * (filling in email/password and submitting), and saves the resulting
     * storage state (cookies, local storage, etc.) to disk so it can later be
     * passed to `capture --session`. Always closes the browser afterward and
     * sets a non-zero exit code on failure.
     *
     * @param {object} opts - Parsed Commander options for the `login` command.
     * @param {string} opts.loginUrl - URL of the page containing the login form.
     * @param {string} opts.emailSelector - CSS selector for the email/username field.
     * @param {string} opts.passwordSelector - CSS selector for the password field.
     * @param {string} opts.submitSelector - CSS selector for the submit button.
     * @param {string} [opts.email] - Email/username to fill in.
     * @param {string} [opts.password] - Password to fill in.
     * @param {string} opts.sessionOut - File path to write the saved session to.
     * @returns {Promise<void>}
     */
    .action(async (opts) => {
      const spinner = ora('Logging in...').start();
      const browser = await chromium.launch();
      try {
        const savedTo = await recordLoginSession(browser, {
          loginUrl: opts.loginUrl,
          emailSelector: opts.emailSelector,
          passwordSelector: opts.passwordSelector,
          submitSelector: opts.submitSelector,
          email: opts.email,
          password: opts.password,
          sessionOut: opts.sessionOut,
        });
        spinner.succeed(`Session saved to ${chalk.cyan(savedTo)}`);
      } catch (err) {
        spinner.fail(chalk.red(err.message));
        process.exitCode = 1;
      } finally {
        await browser.close();
      }
    });

  program
    .command('diff')
    .description('Compare two capture runs (by manifest.json) and highlight visual changes')
    .argument('<old-manifest>', "path to the earlier run's manifest.json")
    .argument('<new-manifest>', "path to the newer run's manifest.json")
    .option('--out <dir>', 'where to write diff images and the report', './diff')
    .option(
      '--threshold <ratio|percent|preset>',
      'how different a page can be before it counts as "changed" — e.g. 0.001 (a 0-1 fraction), "0.1%" (a percentage), or a preset: strict/default/loose',
      normalizeThreshold,
      THRESHOLD_PRESETS.default,
    )
    .option('--zip', 'also bundle the diff output into a .zip when done', false)
    .option('--json', 'print the summary as JSON instead of colored output', false)
    .option(
      '--summary',
      'print a human-readable visual regression summary',
      false,
    )
    .option(
      '--text <file>',
      'write the human-readable visual regression summary to a text file',
    )
    .addHelpText(
      'after',
      `
Understanding --threshold:
  --threshold controls how different a page can be before it counts as
  "changed" — as a fraction of its total pixels. Write it however's clearest:

    0.001        raw ratio: a number between 0 and 1 (0.001 = 1 in 1,000 pixels)
    "0.1%"       the same thing, written as a percentage
    strict       preset — 0.01%, flags almost any difference (anti-aliasing included)
    default      preset — 0.1%, a reasonable starting point (this is also the default)
    loose        preset — 1%, tolerates minor rendering noise across machines/CI

Examples:
  $ shotsweep diff old/manifest.json new/manifest.json --threshold loose
  $ shotsweep diff old/manifest.json new/manifest.json --threshold "0.05%"
`,
    )
    /**
     * Action handler for `shotsweep diff`.
     *
     * Loads any `shotsweep.config.json` / `.shotsweeprc.json` and merges it
     * with the CLI flags for this command. Top-level config keys apply here
     * too (shared with `capture`), but a `"diff": { ... }` sub-object in the
     * same config file overrides them for this command specifically — and an
     * explicitly-passed CLI flag always wins over both. See
     * {@link mergeOptions} for the precedence details. Then compares the
     * manifests from two previous capture runs, matching
     * screenshots by URL and viewport and pixel-diffing each pair, writing a
     * report (and optionally a zip archive) to the output directory. Prints
     * either a colored summary or a JSON line, and sets a non-zero exit code
     * if any pages changed, were removed, or were resized, or if an error occurred.
     *
     * @param {string} oldManifest - Path to the earlier run's `manifest.json`.
     * @param {string} newManifest - Path to the newer run's `manifest.json`.
     * @param {object} opts - Parsed Commander options for the `diff` command.
     * @param {string} opts.out - Directory to write diff images and the report to.
     * @param {number|string} opts.threshold - Fraction of differing pixels before a page counts as
     *   changed — accepted as a raw 0-1 fraction, a percentage string, or a named preset; normalized
     *   via {@link normalizeThreshold} before use (config-sourced values skip Commander's own parser,
     *   so this normalization has to happen here regardless of where the value came from).
     * @param {boolean} opts.zip - Whether to bundle the diff output into a `.zip`.
     * @param {boolean} opts.json - Whether to print the summary as JSON instead of colored output.
     * @param {import('commander').Command} command - The Commander command instance.
     * @returns {Promise<void>}
     */
    .action(async (oldManifest, newManifest, opts, command) => {
      const config = await loadConfig();
      const merged = mergeOptions(config, opts, command, 'diff');

      const spinner = merged.json ? null : ora('Comparing runs...').start();
      try {
        // Config-sourced threshold values (a percent string, a preset name, a
        // plain number typed in JSON) never pass through Commander's own
        // `--threshold` parser, so normalize here regardless of source.
        merged.threshold = normalizeThreshold(merged.threshold);

        const { summary, reportPath } = await runDiff({
          oldManifest, newManifest, out: merged.out, threshold: merged.threshold,
        });

        const summaryText = buildDiffSummary(summary);

        if (merged.text) {
          await fs.mkdir(path.dirname(merged.text), { recursive: true });
          await fs.writeFile(merged.text, `${summaryText}\n`, 'utf8');
        }

        let zipPath = null;
        if (merged.zip) zipPath = await zipOutput(merged.out);

        if (merged.json) {
          console.log(JSON.stringify({ summary, reportPath, zipPath }));
        } else if (merged.summary) {
          spinner?.stop();

          console.log(`\n${summaryText}`);

          console.log(chalk.dim(`\nReport: ${reportPath}`));
        } else {
          spinner.succeed(
            `${chalk.yellow(summary.changed + ' changed')}, ` +
            `${chalk.dim(summary.unchanged + ' unchanged')}, ` +
            `${chalk.green(summary.added + ' added')}, ` +
            `${chalk.red(summary.removed + ' removed')}` +
            (summary.sizeChanged ? `, ${chalk.magenta(summary.sizeChanged + ' resized')}` : '')
          );
          console.log(chalk.dim(`Report: ${reportPath}`));
          if (zipPath) console.log(chalk.dim(`Zip: ${zipPath}`));
        }

        if (summary.regressions > 0) {
          process.exitCode = 1;
        }

      } catch (err) {
        if (merged.json) console.log(JSON.stringify({ error: err.message }));
        else spinner.fail(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  program.parse(argv);
}