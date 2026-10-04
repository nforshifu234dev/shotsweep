// src/zip.js
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { ZipArchive } from 'archiver';

/**
 * Creates a ZIP archive containing the contents of a ShotSweep
 * output directory.
 *
 * The generated archive is written alongside the output directory, named
 * after it, in the directory's parent.
 *
 * For example:
 *
 *     ./screenshots
 *
 * becomes:
 *
 *     ./screenshots.zip
 *
 * and `--out .` (the current directory, e.g. `C:\work\shots`) becomes
 * `C:\work\shots.zip` — outside the folder being archived.
 *
 * The output directory itself is not added as a parent directory
 * inside the archive. Its contents are placed at the root of the ZIP.
 *
 * @param {string} outDir
 *   Path to the directory containing the files to archive.
 *
 * @returns {Promise<string>}
 *   Resolves with the path to the generated ZIP archive.
 *
 * @throws {Error}
 *   Rejects when the archive or output stream encounters an error.
 */
export async function zipOutput(outDir) {
  const resolvedDir = path.resolve(outDir);

  // Always write the archive *next to* the directory, never inside it.
  // (With `--out .` the old code produced a file literally named "..zip" and
  // told the archiver to include the directory it was still writing into.)
  const baseName = path.basename(resolvedDir) || 'shotsweep-output';
  const zipPath = path.join(path.dirname(resolvedDir), `${baseName}.zip`);

  const output = createWriteStream(zipPath);

  const archive = new ZipArchive({
    zlib: {
      level: 9,
    },
  });

  return new Promise((resolve, reject) => {
    /**
     * Handle errors from the destination file stream.
     */
    output.on('error', reject);

    /**
     * Resolve when the ZIP file has completely finished writing.
     */
    output.on('close', () => {
      resolve(zipPath);
    });

    /**
     * Handle errors emitted by Archiver. Non-fatal warnings (e.g. a file
     * disappearing mid-archive) are surfaced as failures too, rather than
     * producing a silently incomplete archive.
     */
    archive.on('error', reject);
    archive.on('warning', reject);

    /**
     * Pipe archive data into the destination ZIP file.
     */
    archive.pipe(output);

    /**
     * Add the contents of the ShotSweep output directory
     * to the root of the archive.
     */
    archive.directory(resolvedDir, false);

    /**
     * Finalize the archive.
     */
    archive.finalize();
  });
}