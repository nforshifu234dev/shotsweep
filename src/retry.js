// src/retry.js

/**
 * Runs an async function, retrying it up to `retries` additional times if it
 * throws. The attempt index (starting at 0) is passed to `fn` on each try.
 * If every attempt fails, the last error encountered is re-thrown.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} fn - The async function to run/retry.
 * @param {number} [retries=0] - Number of additional attempts to make after the first failure.
 * @returns {Promise<T>} The result of the first successful attempt.
 * @throws {*} The error from the final attempt, if all attempts fail.
 */
export async function withRetries(fn, retries = 0) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}