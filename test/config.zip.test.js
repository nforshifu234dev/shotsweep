import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, toArray } from '../src/config.js';
import { zipOutput } from '../src/zip.js';
import { redactConfig } from '../src/provenance.js';

test('loadConfig throws on a broken config file instead of silently ignoring it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-config-'));
  await fs.writeFile(path.join(dir, 'shotsweep.config.json'), '{ "out": ');
  await assert.rejects(() => loadConfig(dir), /shotsweep\.config\.json is not valid/);
});

test('loadConfig accepts a UTF-8 BOM and returns {} when there is no config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-config-'));
  assert.deepEqual(await loadConfig(dir), {});
  await fs.writeFile(path.join(dir, '.shotsweeprc.json'), '\uFEFF{"out":"./x"}');
  assert.deepEqual(await loadConfig(dir), { out: './x' });
});

test('toArray wraps single values for repeatable options', () => {
  assert.deepEqual(toArray('1440x900'), ['1440x900']);
  assert.deepEqual(toArray(['a', 'b']), ['a', 'b']);
  assert.deepEqual(toArray(undefined), []);
});

test('zipOutput writes the archive next to the folder, including when run from inside it (--out .)', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-zip-'));
  const dir = path.join(parent, 'shots');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello');

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const zipPath = await zipOutput('.');
    assert.equal(zipPath, path.join(await fs.realpath(parent), 'shots.zip'));
    assert.ok((await fs.stat(zipPath)).size > 0);
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(await fs.readdir(dir), ['a.txt']); // archive was not written inside the folder
});

test('redactConfig masks credentials embedded in URLs', () => {
  const r = redactConfig({ url: 'https://user:hunter2@example.com/x', mode: 'full' });
  assert.ok(!JSON.stringify(r).includes('hunter2'));
  assert.equal(redactConfig({ url: 'https://example.com' }).url, 'https://example.com');
});