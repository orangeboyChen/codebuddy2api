/**
 * Draws the two menu bar icons into electron/resources. Run by hand, not by a
 * build: what it draws is committed, and a build copies it.
 *
 * Usage: `bun run icons:tray`
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

/** Where the repository is, whichever directory this is run from. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What the mark is drawn from: the file the console itself is served from.
 *
 * Not the file this script writes. Reading its own output made it a script that
 * could only be run once — a second run resized the mark it had already
 * resized, and the pristine mark existed nowhere for anybody to run it again
 * from.
 */
const SOURCE = path.join(root, 'app', 'icon.svg');
const RESOURCES = path.join(root, 'electron', 'resources');

/**
 * The canvas a menu bar icon is drawn on: sixteen points wide, at twice the
 * pixels on a Retina menu bar.
 */
export const CANVAS = 32;
/**
 * What the app's mark takes of it.
 *
 * A menu bar is a row of icons the same size as everybody else's, and a mark
 * drawn edge to edge is larger than the rest of the row — twenty-two of the
 * thirty-two pixels, eleven of the sixteen points, is the size the others are.
 */
export const MARK = 22;
/** The room above and below it, which is what centres it in the row. */
export const PAD = (CANVAS - MARK) / 2;
/**
 * The room the icon that gets a title keeps on its right.
 *
 * macOS draws the menu bar item's title right against its icon, and transparent
 * pixels inside the picture are the only spacing a status item can be given —
 * so the icon that is handed a title is the one carrying the margin for it.
 * The other two platforms draw the icon on its own, and keep it centred.
 */
export const TITLE_MARGIN = 8;

/** The mark, at the size it is drawn in the row and no bigger. */
const mark = async (): Promise<Buffer> => {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`${SOURCE} is missing. The mark is drawn from it.`);
  }

  return await sharp(fs.readFileSync(SOURCE))
    .resize(MARK, MARK, { fit: 'contain' })
    .png()
    .toBuffer();
};

/**
 * The darkest a pixel can be and still be the glyph, and not the plate.
 *
 * The plate is the app's own dark, which is near black but not black, and a
 * template has no greys to tell the two apart: a plate left in at a tenth of
 * the alpha is a square the glyph shows faintly through. Everything darker than
 * this is the plate, and drops out of the template.
 */
const GLYPH_LIGHT = 64;

/**
 * The same mark as a template, which is what macOS asks a menu bar item for:
 * it draws one from the picture's alpha alone, so the shape is kept and every
 * colour in it is dropped. A coloured mark is the only one in the row.
 *
 * Which is why the template is the glyph and not the whole mark: the mark is a
 * dark plate with a lighter glyph on it, so its alpha is the plate's all the
 * way across and its shape is in its colour. Dropping the colour alone leaves
 * the plate and loses the glyph — a menu bar item that is a black rounded
 * rectangle — so the template's alpha is made from the mark's light, which is
 * where the glyph is.
 */
export const asTemplate = async (png: Buffer): Promise<Buffer> => {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let at = 0; at < data.length; at += info.channels) {
    const light =
      0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
    const alpha =
      light <= GLYPH_LIGHT
        ? 0
        : Math.round(((light - GLYPH_LIGHT) / (255 - GLYPH_LIGHT)) * 255);

    data[at] = 0;
    data[at + 1] = 0;
    data[at + 2] = 0;
    // Kept inside the mark: a pixel the mark leaves clear is whatever the
    // decoder left in it, and has no light of its own.
    data[at + 3] = Math.round((alpha * data[at + 3]) / 255);
  }

  return await sharp(data, {
    raw: { channels: info.channels, height: info.height, width: info.width },
  })
    .png()
    .toBuffer();
};

const write = async (
  outDir: string,
  file: string,
  left: number,
  input: Buffer,
): Promise<Buffer> => {
  const png = await sharp({
    create: {
      background: { alpha: 0, b: 0, g: 0, r: 0 },
      channels: 4,
      height: CANVAS,
      width: CANVAS,
    },
  })
    .composite([{ input, left, top: PAD }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, file), png);

  return png;
};

/** The two files the menu bar is drawn from. */
export type TrayFile = 'tray-template.png' | 'tray.png';

/** Both menu bar icons, in whatever directory they are asked for. */
export const renderTrays = async (
  outDir: string = RESOURCES,
): Promise<Record<TrayFile, Buffer>> => {
  const fullColour = await mark();
  const template = await asTemplate(fullColour);
  const [tray, trayTemplate] = await Promise.all([
    write(outDir, 'tray.png', PAD, fullColour),
    write(outDir, 'tray-template.png', CANVAS - MARK - TITLE_MARGIN, template),
  ]);

  return { 'tray-template.png': trayTemplate, 'tray.png': tray };
};

if (import.meta.main) {
  const written = await renderTrays();

  for (const [file, png] of Object.entries(written)) {
    const left =
      file === 'tray-template.png' ? CANVAS - MARK - TITLE_MARGIN : PAD;

    console.log(
      `${file}: ${MARK}px mark at ${left},${PAD} (${png.length} bytes)`,
    );
  }
}
