// test/threshold.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThreshold, THRESHOLD_PRESETS } from '../src/diff.js';

test('normalizeThreshold passes through a valid raw ratio', () => {
  assert.equal(normalizeThreshold(0.005), 0.005);
});

test('normalizeThreshold parses a percentage string', () => {
  assert.equal(normalizeThreshold('0.1%'), 0.001);
  assert.equal(normalizeThreshold('1%'), 0.01);
});

test('normalizeThreshold resolves named presets', () => {
  assert.equal(normalizeThreshold('strict'), THRESHOLD_PRESETS.strict);
  assert.equal(normalizeThreshold('default'), THRESHOLD_PRESETS.default);
  assert.equal(normalizeThreshold('loose'), THRESHOLD_PRESETS.loose);
});

test('normalizeThreshold parses a numeric string ratio', () => {
  assert.equal(normalizeThreshold('0.02'), 0.02);
});

test('normalizeThreshold rejects garbage input instead of silently returning NaN', () => {
  assert.throws(() => normalizeThreshold('banana'), /Invalid --threshold/);
  assert.throws(() => normalizeThreshold(-1), /Invalid --threshold/);
  assert.throws(() => normalizeThreshold(1.5), /Invalid --threshold/);
});