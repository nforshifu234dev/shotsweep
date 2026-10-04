// End-to-end tests for the behaviors found while capturing a real, image-heavy
// marketing site: scroll-reveal content, a page that never fires `load`, and
// URL typos. Real Chromium, real local servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { runCapture } from '../src/capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'shotsweep-behavior-'));

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, url: `http://localhost:${server.address().port}` };
}

/** Fraction of pixels in the PNG that are fully white. */
async function whiteRatio(file, { fromY = 0, toY } = {}) {
  const png = PNG.sync.read(await fs.readFile(file));
  const end = Math.min(toY ?? png.height, png.height);
  let white = 0;
  let total = 0;
  for (let y = fromY; y < end; y += 4) {
    for (let x = 0; x < png.width; x += 4) {
      const i = (y * png.width + x) * 4;
      total++;
      if (png.data[i] === 255 && png.data[i + 1] === 255 && png.data[i + 2] === 255) white++;
    }
  }
  return white / total;
}

const base = (extra = {}) => ({ mode: 'full', viewport: ['desktop'], concurrency: 1, timeout: 15000, retries: 0, ...extra });

test('full-page capture reveals scroll-triggered sections (the "white screenshot" bug)', async () => {
  const html = await fs.readFile(path.join(__dirname, 'fixtures', 'reveal-page.html'), 'utf8');
  const { server, url } = await serve((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });

  try {
    const withScroll = await runCapture({ ...base({ out: await tmpDir() }), url });
    const noScroll = await runCapture({ ...base({ out: await tmpDir(), scroll: false }), url });

    // Sections 2-4 live below the first 900px viewport.
    const below = { fromY: 950 };
    assert.ok(await whiteRatio(withScroll.manifest[0].file, below) < 0.05, 'with scroll, lower sections should be painted');
    assert.ok(await whiteRatio(noScroll.manifest[0].file, below) > 0.5, 'sanity check: without scroll the lower sections are blank');
  } finally {
    server.close();
  }
});

test('a page that never fires `load` is still captured, with a warning', async () => {
  // The image request is accepted and then held open forever, so `load` never fires.
  const hanging = [];
  const { server, url } = await serve((req, res) => {
    if (req.url === '/slow.png') { hanging.push(res); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body style="background:#cde"><h1>Hello</h1><img src="/slow.png"></body>');
  });

  try {
    const result = await runCapture({ ...base({ out: await tmpDir(), timeout: 2500, scroll: false }), url });
    const [entry] = result.manifest;
    assert.equal(entry.error, undefined, `expected a capture, got: ${entry.error}`);
    assert.ok(entry.warnings?.some((w) => /didn't fire/.test(w)), 'expected a "load didn\'t fire" warning');

    const strict = await runCapture({ ...base({ out: await tmpDir(), timeout: 2500, scroll: false, strictLoad: true }), url });
    assert.ok(strict.manifest[0].error, '--strict-load should fail instead');
  } finally {
    hanging.forEach((res) => res.destroy());
    server.close();
  }
});

test('one invalid URL fails up front with a clear message and starts no browser', async () => {
  const out = await tmpDir();
  await assert.rejects(() => runCapture({ ...base({ out }), url: 'http://' }), /Invalid URL/);
});

test('a scheme-less URL is accepted', async () => {
  const result = await runCapture({ ...base({ out: await tmpDir() }), url: 'example.invalid', dryRun: true });
  assert.deepEqual(result.targets, ['https://example.invalid']);
});

test('re-running replaces stale error entries instead of piling them up', async () => {
  const html = await fs.readFile(path.join(__dirname, 'fixtures', 'smoke-page.html'), 'utf8');
  const { server, url } = await serve((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
  const out = await tmpDir();

  try {
    await runCapture({ ...base({ out, timeout: 3000 }), url: 'http://localhost:1' });
    await runCapture({ ...base({ out }), url });
    await runCapture({ ...base({ out }), url });
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.filter((e) => e.url === url).length, 1, 'only one entry per job after re-runs');
    assert.ok(manifest.every((e) => !String(e.file ?? '').includes('\\')), 'manifest paths use forward slashes');
    assert.ok(manifest.every((e) => !/\u001b/.test(e.error ?? '')), 'no ANSI escapes in error messages');
  } finally {
    server.close();
  }
});

test('--resume skips a full-page job whose screenshot still exists, and re-captures if it was deleted', async () => {
  const html = await fs.readFile(path.join(__dirname, 'fixtures', 'smoke-page.html'), 'utf8');
  const { server, url } = await serve((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
  const out = await tmpDir();

  try {
    const first = await runCapture({ ...base({ out }), url });
    const second = await runCapture({ ...base({ out, resume: true }), url });
    assert.equal(second.total, 0, 'nothing left to do');

    await fs.rm(first.manifest[0].file);
    const third = await runCapture({ ...base({ out, resume: true }), url });
    assert.equal(third.total, 1, 'deleted screenshot is re-captured');
  } finally {
    server.close();
  }
});

test('bearer token is sent to the captured site but not to other origins', async () => {
  const seenByOther = [];
  const other = await serve((req, res) => { seenByOther.push(req.headers.authorization); res.writeHead(200, { 'Content-Type': 'text/css' }); res.end('body{}'); });
  const seenByMain = [];
  const main = await serve((req, res) => {
    seenByMain.push(req.headers.authorization);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    // 127.0.0.1 vs localhost: a different origin from the page, like a third-party CDN
    res.end(`<!doctype html><link rel="stylesheet" href="${other.url.replace('localhost', '127.0.0.1')}/x.css"><h1>hi</h1>`);
  });

  try {
    await runCapture({ ...base({ out: await tmpDir(), scroll: false, bearer: 'secret-token' }), url: main.url });
    assert.ok(seenByMain.includes('Bearer secret-token'), 'captured site receives the token');
    assert.ok(seenByOther.length > 0 && seenByOther.every((h) => h === undefined), 'third-party origin must not receive the token');
  } finally {
    main.server.close();
    other.server.close();
  }
});

function tinyPng() {
  const png = new PNG({ width: 40, height: 40 });
  for (let i = 0; i < 40 * 40; i++) { png.data[i * 4] = 220; png.data[i * 4 + 1] = 30; png.data[i * 4 + 2] = 30; png.data[i * 4 + 3] = 255; }
  return PNG.sync.write(png);
}

test('an image cancelled after a `load` timeout is re-requested and ends up loaded', async () => {
  // First request for the image stalls (so `load` never fires); any later request succeeds.
  const png = tinyPng();
  const held = [];
  let imageRequests = 0;
  const { server, url } = await serve((req, res) => {
    if (req.url === '/photo.png') {
      imageRequests++;
      if (imageRequests === 1) { held.push(res); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body style="margin:0;background:#fff"><img id="p" src="/photo.png" width="400" height="400"></body>');
  });

  try {
    const result = await runCapture({ ...base({ out: await tmpDir(), timeout: 2000 }), url });
    const [entry] = result.manifest;
    assert.equal(entry.error, undefined, `expected a capture, got: ${entry.error}`);
    assert.ok(entry.warnings?.some((w) => /didn't fire/.test(w)), 'load timeout is still reported');
    assert.ok(!entry.warnings?.some((w) => /image\(s\) didn't finish/.test(w)), 'but the image was recovered, so no image warning');
    assert.ok(imageRequests >= 2, 'the cancelled image was requested again');
    // The 400x400 image covers ~12% of the 1440x900 page; a missing image would leave it ~100% white.
    assert.ok(await whiteRatio(entry.file) < 0.95, 'the recovered image is actually painted in the screenshot');
  } finally {
    held.forEach((res) => res.destroy());
    server.close();
  }
});

test('an image that never loads is reported in a warning instead of silently missing', async () => {
  const held = [];
  const { server, url } = await serve((req, res) => {
    if (req.url === '/never.png') { held.push(res); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body><h1>Hi</h1><img src="/never.png" alt="never arrives" width="300" height="200"></body>');
  });

  try {
    const result = await runCapture({
      ...base({ out: await tmpDir(), timeout: 1500, waitUntil: 'domcontentloaded', imageWait: 1500 }),
      url,
    });
    const [entry] = result.manifest;
    assert.equal(entry.error, undefined);
    assert.ok(entry.warnings?.some((w) => /1 of 1 image\(s\) didn't finish loading/.test(w)), `got warnings: ${JSON.stringify(entry.warnings)}`);
  } finally {
    held.forEach((res) => res.destroy());
    server.close();
  }
});