// src/debug.js
/**
 * Creates a debug logger that only writes output when debugging is enabled.
 *
 * @param {boolean} enabled - Whether debug output should be displayed.
 * @returns {(...args: unknown[]) => void} Debug logging function.
 */
export function createDebugLogger(enabled = false) {
  return (...args) => {
    if (!enabled) return;

    console.error('[debug]', ...args);
  };
}