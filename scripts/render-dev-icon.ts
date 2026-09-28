/**
 * Writes the development icon as a PNG: the app's own mark on an orange plate,
 * carrying a `DEV` badge, drawn from `app/icon.svg`.
 *
 * Its own script, and not part of scripts/build-desktop.ts, because rasterising
 * an SVG takes a native image library that nothing else in the build needs — a
 * release build must not fail on a machine that has no development
 * dependencies installed.
 *
 * Usage: `bun scripts/render-dev-icon.ts [--out <file>]`
 */

import fs from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

import { CANVAS, DEV_ICON_FILENAME, devIconSvg } from './dev-icon';

/** The file the icon is written to, unless another one is asked for. */
const DEFAULT_OUT = path.join('build', 'electron-app', DEV_ICON_FILENAME);

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
  const source = path.join(process.cwd(), 'app', 'icon.svg');

  if (!fs.existsSync(source)) {
    throw new Error(`${source} is missing. The icon is drawn from it.`);
  }

  // `resize` after the read, not a density before it: what the icon is asked
  // for is a 1024-pixel square, and this is what guarantees one however the
  // rasteriser took the SVG's own size.
  const png = await sharp(
    Buffer.from(devIconSvg(fs.readFileSync(source, 'utf8'))),
  )
    .resize(CANVAS, CANVAS)
    .png({ compressionLevel: 9 })
    .toBuffer();

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, png);

  console.log(`Development icon written to ${out} (${png.length} bytes)`);
};

const out = parseArguments(process.argv.slice(2));

await render(out);
