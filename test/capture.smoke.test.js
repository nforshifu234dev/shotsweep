// test/capture.smoke.test.js
//
// Unlike the other test files, this one doesn't test an isolated pure
// function — it runs the real runCapture() pipeline end to end: a real
// local HTTP server, a real Chromium browser via Playwright, a real
// screenshot written to disk, a real manifest written and read back.
//
// This exists specifically to catch the class of bug a unit test can't:
// something wrong in how runCapture's pieces are wired together (e.g. a
// worker function that never actually returns its result). All the other
// test files exercise helpers in isolation and would stay green even if
// runCapture itself were broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCapture } from '../src/capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function startFixtureServer() {
  const html = await fs.readFile(
    path.join(__dirname, 'fixtures', 'smoke-page.html'),
    'utf8'
  );

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, url: `http://localhost:${port}` };
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'shotsweep-smoke-'));
}

test('runCapture produces a real screenshot and a real manifest entry', async () => {
  const { server, url } = await startFixtureServer();
  const out = await tmpDir();

  try {
    const result = await runCapture({
      url,
      mode: 'full',
      viewport: ['desktop'],
      out,
      concurrency: 1,
      timeout: 15000,
      retries: 0,
    });

    // The manifest returned by runCapture itself
    assert.equal(result.manifest.length, 1);
    const [entry] = result.manifest;
    assert.equal(entry.url, url);
    assert.equal(entry.error, undefined, `expected no error, got: ${entry.error}`);
    assert.ok(entry.sizeBytes > 0, 'expected a non-empty screenshot file size');

    // The actual file on disk
    const stat = await fs.stat(entry.file);
    assert.ok(stat.size > 0, 'expected the screenshot file to actually exist and be non-empty');

    // manifest.json as written to disk, read back independently —
    // this is the exact thing that was silently null for every entry
    // during the placeholder-comment bug.
    const writtenManifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    assert.equal(writtenManifest.length, 1);
    assert.notEqual(writtenManifest[0], null, 'manifest entry must not be null/undefined on disk');
    assert.equal(writtenManifest[0].url, url);
  } finally {
    server.close();
  }
});

test('runCapture reports a real error for a page that never responds, without crashing', async () => {
  const out = await tmpDir();

  const result = await runCapture({
    url: 'http://localhost:1', // nothing listens here — guaranteed connection failure
    mode: 'full',
    viewport: ['desktop'],
    out,
    concurrency: 1,
    timeout: 3000,
    retries: 0,
  });

  assert.equal(result.manifest.length, 1);
  const [entry] = result.manifest;
  assert.ok(entry.error, 'expected an error message for an unreachable URL');
  assert.equal(entry.file, undefined);
});