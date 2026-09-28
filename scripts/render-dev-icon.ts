/**
 * Draws the development icon the desktop app carries, into electron/resources:
 * the console's own mark on an orange plate, carrying a `DEV` badge, lifted out
 * of `app/icon.svg`.
 *
 * A maintenance script, not a build step. What it writes is committed, so a
 * build asking for the development icon copies a file instead of drawing one:
 * neither electron-builder nor `electron .` has to rasterise an SVG, and what a
 * check on CI ships is the same picture a maintainer looked at.
 *
 * Run it after `app/icon.svg` changes, or after the icon itself is redrawn, and
 * commit both files: tests/scripts/dev-icon.test.ts fails until they are in
 * step again.
 *
 * Usage: `bun scripts/render-dev-icon.ts [--out <png>]`
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { DEV_ICON_FILENAME, OUTPUT_SIZE, devIconSvg } from './dev-icon';

/** Where the repository is, whichever directory this is run from. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the icon is drawn from: the file the console itself is served from. */
const source = path.join(root, 'app', 'icon.svg');

/** The file the icon is written to, unless another one is asked for. */
const DEFAULT_OUT = path.join(root, 'electron', 'resources', DEV_ICON_FILENAME);

const parseArguments = (argv: string[]): string => {
  let out = DEFAULT_OUT;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--out') {
      out = argv[index + 1] ?? '';
      index += 1;

      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!out) {
    throw new Error('--out needs a file to write to.');
  }

  return out;
};

const render = async (out: string): Promise<void> => {
  if (!fs.existsSync(source)) {
    throw new Error(`${source} is missing. The icon is drawn from it.`);
  }

  const svg = devIconSvg(fs.readFileSync(source, 'utf8'));

  // `resize` after the read, not a density before it: the icon is described in
  // a 1024-pixel square and committed at 512, and this is what guarantees that
  // size however the rasteriser took the SVG's own one.
  const png = await sharp(Buffer.from(svg))
    .resize(OUTPUT_SIZE, OUTPUT_SIZE)
    .png({ compressionLevel: 9 })
    .toBuffer();

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, png);
  // The drawing beside the picture, so the committed PNG has a diff to explain
  // it and the icon can be checked without rasterising anything.
  fs.writeFileSync(out.replace(/\.png$/i, '.svg'), svg);

  console.log(`Development icon written to ${out} (${png.length} bytes)`);
};

const out = parseArguments(process.argv.slice(2));

await render(out);
