// test/auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies } from '../src/auth.js';

test('parseCookies requires a Domain attribute', () => {
  assert.throws(() => parseCookies(['session=abc']));
});

test('parseCookies parses name, value, and domain', () => {
  const [cookie] = parseCookies(['session=abc; Domain=example.com']);
  assert.equal(cookie.name, 'session');
  assert.equal(cookie.value, 'abc');
  assert.equal(cookie.domain, 'example.com');
});