// src/zip.js
import { createWriteStream } from 'node:fs';
import { ZipArchive } from 'archiver';

/**
 * Creates a ZIP archive containing the contents of a ShotSweep
 * output directory.
 *
 * The generated archive is written alongside the output directory
 * using the same path with a `.zip` extension.
 *
 * For example:
 *
 *     ./screenshots
 *
 * becomes:
 *
 *     ./screenshots.zip
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
  const zipPath = `${outDir.replace(/[/\\]+$/, '')}.zip`;

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
     * Handle errors emitted by Archiver.
     */
    archive.on('error', reject);

    /**
     * Pipe archive data into the destination ZIP file.
     */
    archive.pipe(output);

    /**
     * Add the contents of the ShotSweep output directory
     * to the root of the archive.
     */
    archive.directory(outDir, false);

    /**
     * Finalize the archive.
     */
    archive.finalize();
  });
}