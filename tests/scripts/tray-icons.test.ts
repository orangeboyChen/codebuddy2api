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
  asTemplate,
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
  let covered = 0;

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

      covered += 1;

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
    covered,
    height: maxY - minY + 1,
    left: minX,
    size: [info.width, info.height] as [number, number],
    top: minY,
    width: maxX - minX + 1,
  };
};

/**
 * Where an edge of the mark falls, which is a pixel either way.
 *
 * What sits on the mark's own boundary is the antialiasing's, and the
 * antialiasing is this machine's renderer's — so a box is pinned to the pixel
 * it is drawn to, and not to the one a sharper or a softer renderer would
 * leave. A mark that has crept a pixel smaller every run is caught by the
 * comparison against the mark beside it, which has no tolerance at all.
 */
const expectEdge = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
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
      // The plate reaches the edge of the mark; the glyph the template is cut
      // to stops a pixel short of it, because a glyph's own edge is the
      // antialiasing's. Either way the mark is the size of the rest of the row
      // and not the size of the canvas, which is what it was before.
      expectEdge(box.width, MARK);
      expectEdge(box.height, MARK);
      expectEdge(box.top, PAD);
    }
  });

  it('leaves room for the title on the icon that is handed one', async () => {
    const drawn = await renderTrays(path.join(scratch, 'margin'));

    // Only the macOS icon carries a title, so only it carries the margin: the
    // others are centred.
    expectEdge((await measure(drawn['tray.png'])).left, PAD);
    expectEdge(
      (await measure(drawn['tray-template.png'])).left,
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

  it('is the glyph, and not the plate it sits on', async () => {
    const drawn = await renderTrays(path.join(scratch, 'plate'));

    // macOS draws a template from a picture's alpha alone, and the mark's alpha
    // is the plate's all the way across — its shape is in its colour. Dropping
    // the colour, which is what a template is, leaves the plate and loses the
    // glyph: a menu bar item that is a black rounded rectangle. So the
    // template's alpha is the mark's light, and what is left of the plate is
    // nothing — not even the tenth of it a plate kept at its own darkness
    // would be, which is a square the glyph shows faintly through.
    expect((await measure(drawn['tray.png'])).covered).toBeGreaterThan(
      (await measure(drawn['tray-template.png'])).covered * 2,
    );
  });

  it('are what is committed, mark for mark', async () => {
    const noColour = await renderTrays(path.join(scratch, 'committed'));

    for (const file of ['tray.png', 'tray-template.png'] as const) {
      const committed = await measure(path.join(RESOURCES, file));
      const drawn = await measure(noColour[file]);

      // The script is run by hand, so what is committed is what it last wrote:
      // a mark that has drifted out of the size or the position the menu bar
      // item was written for is a mark nobody would notice until it shipped.
      expect(committed.size).toEqual(drawn.size);
      expectEdge(committed.width, drawn.width);
      expectEdge(committed.height, drawn.height);
      expectEdge(committed.left, drawn.left);
      expectEdge(committed.top, drawn.top);

      // macOS draws a template from its alpha alone, so all the count has to
      // say is whether there is any colour at all — the exact number is this
      // machine's renderer's, and a committed file is somebody else's.
      if (file === 'tray-template.png') {
        expect(committed.coloured).toBe(0);
      } else {
        expect(committed.coloured).toBeGreaterThan(0);
      }
    }
  });
});

describe('a mark made into a template', () => {
  /** Two pixels: the first clear with a colour left in it, the second white. */
  const twoPixels = async (): Promise<Buffer> =>
    await sharp(Buffer.from([255, 255, 255, 0, 255, 255, 255, 255]), {
      raw: { channels: 4, height: 1, width: 2 },
    })
      .png()
      .toBuffer();

  it('is nothing at all where the mark is clear', async () => {
    // A pixel the mark leaves clear has no light of its own, but a decoder is
    // free to leave a colour in it, and a bright one behind a clear pixel is a
    // stray dot in the corner of the menu bar item.
    const template = await measure(await asTemplate(await twoPixels()));

    expect(template.covered).toBe(1);
    expect(template.left).toBe(1);
    expect(template.coloured).toBe(0);
  });
});
