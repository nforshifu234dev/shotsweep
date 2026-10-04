import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeaders, parseCookies, isSameSite, buildContextOptions } from '../src/auth.js';

test('parseHeaders parses Key: Value and rejects malformed flags', () => {
  assert.deepEqual(parseHeaders(['X-Api-Key: abc', 'Accept:  text/html ']), { 'X-Api-Key': 'abc', Accept: 'text/html' });
  assert.throws(() => parseHeaders(['no-colon-here']), /Key: Value/);
  assert.throws(() => parseHeaders([': value']), /Key: Value/);
});

test('parseCookies supports Secure, HttpOnly and SameSite, and rejects bad input', () => {
  const [c] = parseCookies(['s=abc; Domain=example.com; Secure; HttpOnly; SameSite=lax']);
  assert.equal(c.secure, true);
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'Lax');
  assert.throws(() => parseCookies(['=nokey; Domain=a.com']), /name=value/);
  assert.throws(() => parseCookies(['a=b; Domain=a.com; SameSite=weird']), /SameSite/);
});

test('isSameSite allows the site and its subdomains but not third parties or other ports', () => {
  const target = 'https://example.com/page';
  assert.equal(isSameSite(target, 'https://example.com/api'), true);
  assert.equal(isSameSite(target, 'https://www.example.com/x'), true);
  assert.equal(isSameSite(target, 'https://cdn.example.net/x'), false);
  assert.equal(isSameSite('http://localhost:3000/', 'http://localhost:4000/'), false);
  assert.equal(isSameSite('http://localhost:3000/', 'http://127.0.0.1:3000/'), false);
});

test('bearer and headers are scoped, not set context-wide, unless headersAllOrigins is set', async () => {
  const scoped = await buildContextOptions({ bearer: 't0k3n', header: ['X-A: 1'] });
  assert.equal(scoped.contextOptions.extraHTTPHeaders, undefined);
  assert.equal(scoped.scopedHeaders.Authorization, 'Bearer t0k3n');
  assert.equal(scoped.scopedHeaders['X-A'], '1');

  const everywhere = await buildContextOptions({ bearer: 't0k3n', headersAllOrigins: true });
  assert.equal(everywhere.contextOptions.extraHTTPHeaders.Authorization, 'Bearer t0k3n');
  assert.deepEqual(everywhere.scopedHeaders, {});
});

test('a missing --session file fails with a clear message', async () => {
  await assert.rejects(() => buildContextOptions({ session: '/nope/missing.json' }), /File not found for --session/);
});