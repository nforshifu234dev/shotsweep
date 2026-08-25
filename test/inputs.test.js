// test/inputs.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugForUrl, applyOriginRewrite } from '../src/inputs.js';

test('slugForUrl turns a path into a folder-safe slug', () => {
  assert.equal(slugForUrl('https://example.com/docs/v3/getting-started'), 'docs__v3__getting-started');
  assert.equal(slugForUrl('https://example.com/'), 'home');
});

test('applyOriginRewrite swaps protocol and host, keeps path', () => {
  const urls = ['https://example.com/docs/getting-started'];
  const rewritten = applyOriginRewrite(urls, 'http://localhost:3000');
  assert.equal(rewritten[0], 'http://localhost:3000/docs/getting-started');
});

test('applyOriginRewrite is a no-op with no replaceOrigin', () => {
  const urls = ['https://example.com/'];
  assert.deepEqual(applyOriginRewrite(urls, undefined), urls);
});