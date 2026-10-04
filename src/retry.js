// src/retry.js

/**
 * Runs an async function, retrying it up to `retries` additional times if it
 * throws. The attempt index (starting at 0) is passed to `fn` on each try.
 * If every attempt fails, the last error encountered is re-thrown.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn - The async function to run/retry.
 * @param {number} [retries=0] - Number of additional attempts to make after the first failure.
 * @param {object} [options]
 * @param {number} [options.delayMs=0] - Base pause before each retry; grows linearly
 *   (`delayMs`, then `2 * delayMs`, …) so a struggling server isn't hammered. Defaults to 0 (no pause).
 * @param {(err: Error, nextAttempt: number) => void} [options.onRetry] - Called just before each retry.
 * @returns {Promise<T>} The result of the first successful attempt.
 * @throws {*} The error from the final attempt, if all attempts fail.
 */
export async function withRetries(fn, retries = 0, { delayMs = 0, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        onRetry?.(err, attempt + 1);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
        }
      }
    }
  }
  throw lastErr;
}