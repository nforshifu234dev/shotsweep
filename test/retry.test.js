// test/retry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetries } from '../src/retry.js';

test('withRetries succeeds immediately when the function succeeds on attempt 0', async () => {
  let calls = 0;
  const result = await withRetries(async () => {
    calls++;
    return 'ok';
  }, 2);
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetries retries a failing function and succeeds once it stops failing', async () => {
  let calls = 0;
  const result = await withRetries(async (attempt) => {
    calls++;
    if (attempt < 2) throw new Error('transient failure');
    return 'ok';
  }, 3);
  assert.equal(result, 'ok');
  assert.equal(calls, 3); // failed attempt 0, failed attempt 1, succeeded attempt 2
});

test('withRetries throws the last error once retries are exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetries(async () => {
      calls++;
      throw new Error('always fails');
    }, 2),
    /always fails/
  );
  assert.equal(calls, 3); // attempt 0, 1, 2 — retries=2 means 3 total tries
});

test('withRetries with retries=0 tries exactly once (current default behavior unchanged)', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetries(async () => {
      calls++;
      throw new Error('fail');
    }, 0)
  );
  assert.equal(calls, 1);
});