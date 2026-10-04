import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeManifests, readExistingManifest, writeManifestAtomic, toPosix } from '../src/manifest.js';

const job = { url: 'https://x.com/', mode: 'full', viewport: '1440x900' };

test('a new success replaces earlier errors and earlier successes for the same job', () => {
  const merged = mergeManifests(
    [{ ...job, error: 'timeout' }, { ...job, file: 'old.png' }],
    [{ ...job, file: 'new.png' }],
  );
  assert.deepEqual(merged.map((e) => e.file), ['new.png']);
});

test('a new failure replaces old errors but keeps an earlier success', () => {
  const merged = mergeManifests(
    [{ ...job, error: 'old error' }, { ...job, file: 'good.png' }],
    [{ ...job, error: 'new error' }],
  );
  assert.equal(merged.length, 2);
  assert.ok(merged.some((e) => e.file === 'good.png'));
  assert.ok(merged.some((e) => e.error === 'new error'));
  assert.ok(!merged.some((e) => e.error === 'old error'));
});

test('unrelated entries are untouched', () => {
  const other = { url: 'https://y.com/', mode: 'full', viewport: '1440x900', file: 'y.png' };
  assert.equal(mergeManifests([other], [{ ...job, file: 'x.png' }]).length, 2);
});

test('a corrupt manifest is moved aside, not silently overwritten', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-manifest-'));
  const file = path.join(dir, 'manifest.json');
  await fs.writeFile(file, '{ not json');
  assert.deepEqual(await readExistingManifest(file), []);
  const names = await fs.readdir(dir);
  assert.ok(names.some((n) => n.startsWith('manifest.json.corrupt-')));
});

test('writeManifestAtomic writes valid JSON and leaves no temp file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-manifest-'));
  const file = path.join(dir, 'manifest.json');
  await writeManifestAtomic(file, [{ a: 1 }]);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [{ a: 1 }]);
  assert.deepEqual(await fs.readdir(dir), ['manifest.json']);
});

test('toPosix converts platform separators to forward slashes', () => {
  assert.equal(toPosix(['a', 'b', 'c.png'].join(path.sep)), 'a/b/c.png');
});