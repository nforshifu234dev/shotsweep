// test/diff.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { runDiff } from '../src/diff.js';

async function makePng(filePath, { width = 10, height = 10, fill = [255, 0, 0, 255] }) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = fill[0];
    png.data[i * 4 + 1] = fill[1];
    png.data[i * 4 + 2] = fill[2];
    png.data[i * 4 + 3] = fill[3];
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, PNG.sync.write(png));
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'shotsweep-diff-'));
}

// Real capture runs give the same page the same filename across runs
// (e.g. "full-1440x900.png"), just under a different run's output directory.
// keyFor() matches on url + viewport + filename, so these fixtures mirror
// that shape — same filename, different parent dir — instead of using
// differently-named files, which would make keyFor() treat them as two
// unrelated pages rather than a pair to diff.
function paths(dir) {
  return {
    oldImg: path.join(dir, 'before', 'full-1440x900.png'),
    newImg: path.join(dir, 'after', 'full-1440x900.png'),
  };
}

test('runDiff reports "unchanged" for identical images', async () => {
  const dir = await tmpDir();
  const { oldImg, newImg } = paths(dir);
  await makePng(oldImg, {});
  await makePng(newImg, {});

  const oldManifest = path.join(dir, 'old-manifest.json');
  const newManifest = path.join(dir, 'new-manifest.json');
  const entry = (file) => ([{ url: 'https://example.com', viewport: '1440x900', file }]);
  await fs.writeFile(oldManifest, JSON.stringify(entry(oldImg)));
  await fs.writeFile(newManifest, JSON.stringify(entry(newImg)));

  const { summary } = await runDiff({
    oldManifest, newManifest, out: path.join(dir, 'diff'), threshold: 0.001,
  });

  assert.equal(summary.unchanged, 1);
  assert.equal(summary.changed, 0);
});

test('runDiff reports "changed" and writes old/new/diff images', async () => {
  const dir = await tmpDir();
  const { oldImg, newImg } = paths(dir);
  await makePng(oldImg, { fill: [255, 0, 0, 255] });
  await makePng(newImg, { fill: [0, 255, 0, 255] }); // fully different color, every pixel changed

  const oldManifest = path.join(dir, 'old-manifest.json');
  const newManifest = path.join(dir, 'new-manifest.json');
  const entry = (file) => ([{ url: 'https://example.com', viewport: '1440x900', file }]);
  await fs.writeFile(oldManifest, JSON.stringify(entry(oldImg)));
  await fs.writeFile(newManifest, JSON.stringify(entry(newImg)));

  const outDir = path.join(dir, 'diff');
  const { summary, results } = await runDiff({
    oldManifest, newManifest, out: outDir, threshold: 0.001,
  });

  assert.equal(summary.changed, 1);
  const [result] = results;
  assert.equal(result.status, 'changed');

  await fs.access(result.oldImage);
  await fs.access(result.newImage);
  await fs.access(result.diffImage);
});

test('runDiff reports "added" and "removed" for pages only in one run', async () => {
  const dir = await tmpDir();
  const imgA = path.join(dir, 'before', 'full-1440x900.png');
  const imgB = path.join(dir, 'after', 'full-1440x900.png');
  await makePng(imgA, {});
  await makePng(imgB, {});

  const oldManifest = path.join(dir, 'old-manifest.json');
  const newManifest = path.join(dir, 'new-manifest.json');
  await fs.writeFile(oldManifest, JSON.stringify([
    { url: 'https://example.com/removed-page', viewport: '1440x900', file: imgA },
  ]));
  await fs.writeFile(newManifest, JSON.stringify([
    { url: 'https://example.com/added-page', viewport: '1440x900', file: imgB },
  ]));

  const { summary } = await runDiff({
    oldManifest, newManifest, out: path.join(dir, 'diff'), threshold: 0.001,
  });

  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 1);
});

test('runDiff reports "size-changed" when image dimensions differ', async () => {
  const dir = await tmpDir();
  const { oldImg, newImg } = paths(dir);
  await makePng(oldImg, { width: 10, height: 10 });
  await makePng(newImg, { width: 20, height: 20 });

  const oldManifest = path.join(dir, 'old-manifest.json');
  const newManifest = path.join(dir, 'new-manifest.json');
  const entry = (file) => ([{ url: 'https://example.com', viewport: '1440x900', file }]);
  await fs.writeFile(oldManifest, JSON.stringify(entry(oldImg)));
  await fs.writeFile(newManifest, JSON.stringify(entry(newImg)));

  const { summary, results } = await runDiff({
    oldManifest, newManifest, out: path.join(dir, 'diff'), threshold: 0.001,
  });

  assert.equal(summary.sizeChanged, 1);
  assert.equal(results[0].oldDimensions, '10x10');
  assert.equal(results[0].newDimensions, '20x20');
});