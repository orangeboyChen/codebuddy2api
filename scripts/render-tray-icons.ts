/**
 * Writes the two menu bar icons into electron/resources. Run by hand, not by a
 * build: what it writes is committed, and a build copies it.
 *
 * Usage: `bun scripts/render-tray-icons.ts`
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

/** Where the repository is, whichever directory this is run from. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RESOURCES = path.join(root, 'electron', 'resources');
const TRAYS = ['tray.png', 'tray-template.png'] as const;

/**
 * The canvas a menu bar icon is drawn on: sixteen points wide, at twice the
 * pixels on a Retina menu bar.
 */
const CANVAS = 32;
/**
 * What the app's mark takes of it.
 *
 * A menu bar is a row of icons the same size as everybody else's, and a mark
 * drawn edge to edge is larger than the rest of the row — twenty-two of the
 * thirty-two pixels, eleven of the sixteen points, is the size the others are.
 */
const MARK = 22;
/** The room above and below it, which is what centres it in the row. */
const PAD = (CANVAS - MARK) / 2;
/**
 * The room the icon that gets a title keeps on its right.
 *
 * macOS draws the menu bar item's title right against its icon, and transparent
 * pixels inside the picture are the only spacing a status item can be given —
 * so the icon that is handed a title is the one carrying the margin for it.
 * The other two platforms draw the icon on its own, and keep it centred.
 */
const TITLE_MARGIN = 8;

/** The mark, at the size it is drawn in the row and no bigger. */
const mark = async (file: string): Promise<Buffer> =>
  sharp(fs.readFileSync(path.join(RESOURCES, file)))
    .resize(MARK, MARK, { fit: 'contain' })
    .png()
    .toBuffer();

const write = async (file: string, left: number): Promise<void> => {
  const png = await sharp({
    create: {
      background: { alpha: 0, b: 0, g: 0, r: 0 },
      channels: 4,
      height: CANVAS,
      width: CANVAS,
    },
  })
    .composite([{ input: await mark(file), left, top: PAD }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  fs.writeFileSync(path.join(RESOURCES, file), png);
  console.log(
    `${file}: ${MARK}px mark at ${left},${PAD} (${png.length} bytes)`,
  );
};

for (const file of TRAYS) {
  // Only the macOS icon is ever handed a title.
  const left =
    file === 'tray-template.png' ? CANVAS - MARK - TITLE_MARGIN : PAD;

  await write(file, left);
}
