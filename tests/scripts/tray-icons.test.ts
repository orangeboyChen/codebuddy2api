import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CANVAS,
  MARK,
  PAD,
  TITLE_MARGIN,
  renderTrays,
} from '../../scripts/render-tray-icons';

/**
 * The two menu bar icons, which are committed rather than drawn by a build.
 *
 * What is worth pinning is not what they look like but what the code around
 * them assumes: that the mark is the size of everybody else's, that it sits
 * where the menu bar item is going to reach for it, that the one macOS calls a
 * template carries no colour, and that the script can be run twice.
 */

const RESOURCES = path.join(process.cwd(), 'electron', 'resources');

/** Where the script's output is compared against itself: never the repo's. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-icons-'));

/** The pixels of a PNG, and the box the opaque ones fall in. */
const measure = async (png: Buffer | string) => {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let coloured = 0;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const at = (y * info.width + x) * info.channels;

      if (data[at + 3] <= 8) {
        continue;
      }

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      if (
        Math.abs(data[at] - data[at + 1]) > 8 ||
        Math.abs(data[at + 1] - data[at + 2]) > 8
      ) {
        coloured += 1;
      }
    }
  }

  return {
    coloured,
    height: maxY - minY + 1,
    left: minX,
    size: [info.width, info.height] as [number, number],
    top: minY,
    width: maxX - minX + 1,
  };
};

afterAll(() => {
  fs.rmSync(scratch, { force: true, recursive: true });
});

describe('the menu bar icons', () => {
  it('are drawn again without being drawn smaller', async () => {
    // The mark used to be read out of the file the script writes, so a second
    // run resized a mark that had already been resized: the icon crept smaller
    // every time somebody ran it.
    const first = await renderTrays(path.join(scratch, 'once'));
    const second = await renderTrays(path.join(scratch, 'twice'));

    expect(second['tray.png']).toEqual(first['tray.png']);
    expect(second['tray-template.png']).toEqual(first['tray-template.png']);
  });

  it('are the size of the rest of the row', async () => {
    const drawn = await renderTrays(path.join(scratch, 'sized'));

    for (const png of [drawn['tray.png'], drawn['tray-template.png']]) {
      const box = await measure(png);

      expect(box.size).toEqual([CANVAS, CANVAS]);
      expect(box.width).toBe(MARK);
      expect(box.height).toBe(MARK);
      expect(box.top).toBe(PAD);
    }
  });

  it('leaves room for the title on the icon that is handed one', async () => {
    const drawn = await renderTrays(path.join(scratch, 'margin'));

    // Only the macOS icon carries a title, so only it carries the margin: the
    // others are centred.
    expect((await measure(drawn['tray.png'])).left).toBe(PAD);
    expect((await measure(drawn['tray-template.png'])).left).toBe(
      CANVAS - MARK - TITLE_MARGIN,
    );
  });

  it('gives macOS a template with no colour in it', async () => {
    const drawn = await renderTrays(path.join(scratch, 'template'));

    // macOS draws a template from its alpha alone; a coloured one is the only
    // coloured icon in the row.
    expect((await measure(drawn['tray-template.png'])).coloured).toBe(0);
    expect((await measure(drawn['tray.png'])).coloured).toBeGreaterThan(0);
  });

  it('are what is committed, mark for mark', async () => {
    for (const file of ['tray.png', 'tray-template.png'] as const) {
      const committed = await measure(path.join(RESOURCES, file));
      const drawn = await measure(
        (await renderTrays(path.join(scratch, 'committed')))[file],
      );

      // The script is run by hand, so what is committed is what it last wrote:
      // a mark that has drifted out of the size or the position the menu bar
      // item was written for is a mark nobody would notice until it shipped.
      // Compared whole, colour and all: a template with colour in it is one
      // macOS cannot draw from, and the committed files are what a build
      // copies.
      expect(committed).toEqual(drawn);
    }
  });
});
