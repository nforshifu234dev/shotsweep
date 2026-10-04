import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, normalizeUrlList, slugForUrl, outDirFor } from '../src/inputs.js';

test('normalizeUrl adds https:// to a bare domain', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com');
});

test('normalizeUrl uses http:// for localhost and loopback', () => {
  assert.equal(normalizeUrl('localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(normalizeUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080');
});

test('normalizeUrl unwraps a pasted Markdown link, quotes and angle brackets', () => {
  assert.equal(normalizeUrl('[www.x.com](https://www.x.com)'), 'https://www.x.com');
  assert.equal(normalizeUrl('"https://a.com/x"'), 'https://a.com/x');
  assert.equal(normalizeUrl('<https://a.com>'), 'https://a.com');
});

test('normalizeUrl rejects junk and non-web schemes', () => {
  assert.throws(() => normalizeUrl(''), /Empty URL/);
  assert.throws(() => normalizeUrl('http://'), /Invalid URL/);
  assert.throws(() => normalizeUrl('javascript:alert(1)'), /Invalid URL|Unsupported/);
  assert.throws(() => normalizeUrl('ftp://example.com/file'), /Unsupported URL scheme/);
});

test('normalizeUrlList dedupes equivalent URLs and reports every bad entry at once', () => {
  assert.deepEqual(normalizeUrlList(['https://x.com', 'https://x.com/', 'x.com/a']), ['https://x.com', 'https://x.com/a']);
  assert.throws(() => normalizeUrlList(['ok.com', 'http://', 'a b'], 'urls.txt'), /2 invalid URLs in urls\.txt/);
});

test('slugForUrl keeps query-string and non-ASCII URLs from colliding', () => {
  assert.notEqual(slugForUrl('https://x.com/s?q=a'), slugForUrl('https://x.com/s?q=b'));
  assert.notEqual(slugForUrl('https://x.com/日本語'), slugForUrl('https://x.com/中文字'));
  assert.equal(slugForUrl('https://x.com/docs/v3/getting-started'), 'docs__v3__getting-started');
  assert.ok(slugForUrl('https://x.com/' + 'b'.repeat(300)).length <= 92);
});

test('outDirFor separates different ports on the same host', () => {
  assert.notEqual(outDirFor('out', 'http://localhost:3000/a'), outDirFor('out', 'http://localhost:4000/a'));
});