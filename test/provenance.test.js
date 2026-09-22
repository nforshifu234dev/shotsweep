import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  redactConfig,
  sha256File,
  compareEnvironments,
  loadRunRecordFor,
} from '../src/provenance.js';

test('redactConfig masks secret-bearing options but keeps everything else', () => {
  const opts = {
    url: 'https://example.com',
    mode: 'full',
    bearer: 'super-secret-token',
    cookie: ['session=abc123', 'theme=dark'],
    header: ['Authorization: Bearer xyz'],
    session: '/home/user/.shotsweep/session.json',
    concurrency: 2,
    debug: () => {},
    onProgress: () => {},
    onResolved: () => {},
  };

  const redacted = redactConfig(opts);

  assert.equal(redacted.url, 'https://example.com');
  assert.equal(redacted.mode, 'full');
  assert.equal(redacted.concurrency, 2);

  // Secrets never appear verbatim.
  assert.equal(redacted.bearer, '[REDACTED]');
  assert.deepEqual(redacted.cookie, ['[REDACTED]', '[REDACTED]']);
  assert.deepEqual(redacted.header, ['[REDACTED]']);
  assert.equal(redacted.session, '[REDACTED]');

  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes('super-secret-token'));
  assert.ok(!serialized.includes('session=abc123'));
  assert.ok(!serialized.includes('Bearer xyz'));

  // Non-serializable plumbing is dropped, not just emptied.
  assert.equal('debug' in redacted, false);
  assert.equal('onProgress' in redacted, false);
  assert.equal('onResolved' in redacted, false);
});

test('redactConfig omits secret keys entirely when they were never set', () => {
  const redacted = redactConfig({ url: 'https://example.com', mode: 'full' });
  assert.equal('bearer' in redacted, false);
  assert.equal('cookie' in redacted, false);
});

test('sha256File produces a stable, correct digest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shotsweep-hash-'));
  const filePath = path.join(dir, 'sample.txt');
  await fs.writeFile(filePath, 'shotsweep provenance test fixture');

  const hash1 = await sha256File(filePath);
  const hash2 = await sha256File(filePath);

  assert.equal(hash1, hash2, 'hashing the same unchanged file twice must be identical');
  assert.match(hash1, /^[a-f0-9]{64}$/, 'expected a hex-encoded SHA-256 digest');

  await fs.writeFile(filePath, 'a different fixture body');
  const hash3 = await sha256File(filePath);
  assert.notEqual(hash1, hash3, 'changing file contents must change the hash');
});

test('compareEnvironments reports no drift for identical records', () => {
  const record = {
    tool: { version: '1.2.0' },
    browser: { playwrightVersion: '1.48.0', browserVersion: '129.0.0.0' },
    runtime: { node: 'v22.5.0', platform: 'linux', arch: 'x64' },
  };

  const result = compareEnvironments(record, record);
  assert.equal(result.comparable, true);
  assert.deepEqual(result.drift, []);
});

test('compareEnvironments flags each differing field with a readable message', () => {
  const oldRecord = {
    tool: { version: '1.2.0' },
    browser: { playwrightVersion: '1.47.0', browserVersion: '128.0.0.0' },
    runtime: { node: 'v22.5.0', platform: 'linux', arch: 'x64' },
  };
  const newRecord = {
    tool: { version: '1.2.0' },
    browser: { playwrightVersion: '1.48.0', browserVersion: '129.0.0.0' },
    runtime: { node: 'v22.5.0', platform: 'linux', arch: 'x64' },
  };

  const result = compareEnvironments(oldRecord, newRecord);
  assert.equal(result.comparable, true);
  assert.equal(result.drift.length, 2, 'expected exactly the 2 fields that actually differ');
  assert.ok(result.drift.some((line) => line.includes('Playwright version')));
  assert.ok(result.drift.some((line) => line.includes('Chromium version')));
  assert.ok(!result.drift.some((line) => line.includes('Node version')), 'identical fields must not be reported as drift');
});

test('compareEnvironments is not comparable when either record is missing', () => {
  const record = {
    tool: { version: '1.2.0' },
    browser: { playwrightVersion: '1.48.0', browserVersion: '129.0.0.0' },
    runtime: { node: 'v22.5.0', platform: 'linux', arch: 'x64' },
  };

  assert.deepEqual(compareEnvironments(null, record), { comparable: false, drift: [] });
  assert.deepEqual(compareEnvironments(record, null), { comparable: false, drift: [] });
  assert.deepEqual(compareEnvironments(null, null), { comparable: false, drift: [] });
});

test('loadRunRecordFor returns null when no run-record.json sits next to the manifest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shotsweep-norecord-'));
  const manifestPath = path.join(dir, 'manifest.json');
  await fs.writeFile(manifestPath, '[]');

  const record = await loadRunRecordFor(manifestPath);
  assert.equal(record, null);
});

test('loadRunRecordFor reads a run-record.json sitting next to the manifest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shotsweep-withrecord-'));
  const manifestPath = path.join(dir, 'manifest.json');
  await fs.writeFile(manifestPath, '[]');
  await fs.writeFile(
    path.join(dir, 'run-record.json'),
    JSON.stringify({ recordVersion: 1, tool: { version: '1.2.0' } }),
  );

  const record = await loadRunRecordFor(manifestPath);
  assert.equal(record.recordVersion, 1);
  assert.equal(record.tool.version, '1.2.0');
});
