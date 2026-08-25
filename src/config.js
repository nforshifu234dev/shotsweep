// src/config.js
import fs from 'node:fs/promises';
import path from 'node:path';

const CONFIG_FILENAMES = ['shotsweep.config.json', '.shotsweeprc.json'];

/**
 * Loads the first ShotSweep config file found in `cwd` (checked in the order
 * `shotsweep.config.json`, then `.shotsweeprc.json`), parsed as JSON.
 *
 * @param {string} [cwd] - Directory to look for a config file in. Defaults to `process.cwd()`.
 * @returns {Promise<object>} The parsed config object, or `{}` if no config file was found or it failed to parse.
 */
export async function loadConfig(cwd = process.cwd()) {
  for (const name of CONFIG_FILENAMES) {
    try {
      const raw = await fs.readFile(path.join(cwd, name), 'utf8');
      return JSON.parse(raw);
    } catch {
      continue;
    }
  }
  return {};
}

// CLI flags the user actually typed should win; config fills in anything
// they didn't specify on the command line.
/**
 * Merges a loaded config object with parsed Commander CLI options for a
 * given command.
 *
 * Precedence, from lowest to highest:
 * 1. Top-level (flat) config keys — shared across every command, since
 *    `shotsweep.config.json` is one file used by both `capture` and `diff`.
 * 2. If `namespace` is given, keys under `config[namespace]` override the
 *    flat keys for this command only. This lets a single config file give
 *    `diff` its own overrides alongside `capture`'s settings, e.g.:
 *    ```json
 *    {
 *      "out": "./screenshots",
 *      "viewport": ["1440x900"],
 *      "diff": { "out": "./diff", "threshold": 0.002 }
 *    }
 *    ```
 *    Here `capture` uses `out: "./screenshots"`, while `diff` uses
 *    `out: "./diff"` and `threshold: 0.002` instead.
 * 3. CLI flags the user actually typed always win over both of the above.
 *
 * @param {object} config - Config object loaded via {@link loadConfig}.
 * @param {object} cliOpts - Parsed Commander options for the current command.
 * @param {import('commander').Command} command - The Commander command instance,
 *   used to determine whether each option's value came from the CLI or a default.
 * @param {string} [namespace] - Optional config sub-object name (e.g. `'diff'`)
 *   whose keys override the flat config for this command only.
 * @returns {object} The merged options object.
 */
export function mergeOptions(config, cliOpts, command, namespace) {
  const merged = { ...config };

  const override = namespace ? config?.[namespace] : undefined;
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    Object.assign(merged, override);
  }

  // Don't let the namespace sub-object itself leak into the merged options
  // (e.g. a stray `merged.diff` object showing up when running `diff`).
  if (namespace) {
    delete merged[namespace];
  }

  for (const [key, value] of Object.entries(cliOpts)) {
    const passedOnCli = command.getOptionValueSource(key) === 'cli';
    if (passedOnCli || !(key in merged)) {
      merged[key] = value;
    }
  }
  return merged;
}