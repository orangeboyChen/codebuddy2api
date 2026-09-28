import fs from 'node:fs';
import path from 'node:path';

import { CANVAS, devIconSvg, readAppMark } from '@/scripts/dev-icon';

// What the icon is drawn from: the export the console itself is served from.
const source = fs.readFileSync(
  path.join(process.cwd(), 'app', 'icon.svg'),
  'utf8',
);

/**
 * The export's two groups, in the order it draws them: the mark on a white
 * plate, and the same mark on the dark plate an install shows.
 */
const groups = [
  ...source.matchAll(/<g clip-path="url\(#[\w.-]+\)"[^>]*>[\s\S]*?<\/g>/g),
].map((match) => match[0]);
const [onPaper, onDark] = groups;
const plate = '<rect width="24" height="24" rx="5.17895" fill="#191A23"/>';

/** The same export, with one of its two groups written over. */
const rewrite = (group: string, rewritten: string): string =>
  source.replace(group, rewritten);

/**
 * What the mark is, with the way it is written taken out: an export that draws
 * the same shapes in another colour, or closes a tag of its own, is the same
 * mark.
 */
const outline = (svg: string): { radius: string; shapes: string[] } => {
  const { elements, radius } = readAppMark(svg);

  return {
    radius,
    shapes: elements.map((element) =>
      element
        .replace(/\bfill\s*=\s*(?:"[^"]*"|'[^']*')/, 'fill=?')
        .replace(/><\/(?:path|rect)>/, '/>'),
    ),
  };
};
const expected = outline(source);

describe('readAppMark', () => {
  it('lifts the mark off the plate an install shows', () => {
    const mark = readAppMark(source);

    expect(mark.radius).toBe('5.17895');
    expect(mark.elements).toHaveLength(3);
    // The plate is left behind: no full square of the icon among the shapes.
    expect(
      mark.elements.some((element) => element.includes('width="24"')),
    ).toBe(false);
  });

  it('takes that group wherever in the export it is drawn', () => {
    // The white plate's group last: taking whichever comes last would paint
    // its plate — a full square — as the mark.
    const swapped = source
      .replace(onPaper, '@@paper@@')
      .replace(onDark, '@@dark@@')
      .replace('@@paper@@', onDark)
      .replace('@@dark@@', onPaper);

    expect(readAppMark(swapped)).toEqual(readAppMark(source));
  });

  it('reads a group whose tag is written another way', () => {
    const variants = [
      source.replace(/clip1_100_1135/g, 'clip1.100'),
      source.replace('url(#clip1_100_1135)">', 'url(#clip1_100_1135)" >'),
      source.replace(
        '<g clip-path="url(#clip1_100_1135)">',
        "<g clip-path='url(#clip1_100_1135)' data-name='mark'>",
      ),
    ];

    for (const variant of variants) {
      expect(outline(variant)).toEqual(expected);
    }
  });

  it('reads a group that nests another one, or a mark closed by its own tag', () => {
    const nested = rewrite(
      onDark,
      onDark
        .replace('<path fill-rule="evenodd"', '<g><path fill-rule="evenodd"')
        .replace(' fill="white"/>', ' fill="white"/></g>'),
    );
    const closed = rewrite(
      onDark,
      onDark.replace(' fill="white"/>', ' fill="white"></path>'),
    );
    const quoted = source.replace(/fill="white"/g, "fill='white'");

    expect(outline(nested)).toEqual(expected);
    expect(outline(closed)).toEqual(expected);
    expect(outline(quoted)).toEqual(expected);
  });

  it('reads a plate whose own corner is named, and a mark in another colour', () => {
    const placed = rewrite(
      onDark,
      onDark.replace(plate, plate.replace('<rect ', '<rect x="0" y="0" ')),
    );
    const coloured = rewrite(
      onDark,
      onDark.replace(/ fill="white"(?=\/>)/g, ' fill="#00FF00"'),
    );

    expect(outline(placed)).toEqual(expected);
    expect(outline(coloured)).toEqual(expected);
  });

  it('leaves out what is not drawn: a comment, and a shape with no fill', () => {
    // Both would be painted as the mark — the comment's rect as a full square
    // of it — if the export were read without looking at what fills a shape.
    // Neither is written the way the plate is, so taking either in shows up as
    // an element the mark does not have.
    const commented = rewrite(
      onDark,
      onDark.replace(
        '</g>',
        '<!-- <rect width="24" height="24" rx="9" fill="white"/> -->\n</g>',
      ),
    );
    const outlined = rewrite(
      onDark,
      onDark.replace(
        '</g>',
        '<rect width="24" height="24" rx="5" stroke="black"/>\n</g>',
      ),
    );

    expect(outline(commented)).toEqual(expected);
    expect(outline(outlined)).toEqual(expected);
  });

  it('takes the plate by what it spans, and by its being filled', () => {
    // A border the export draws before the plate: taken for the plate, its own
    // corner radius would become the silhouette's, and the plate itself would
    // then be painted as the mark — a full square of it.
    const bordered = rewrite(
      onDark,
      onDark.replace(
        plate,
        '<rect width="22.5882" height="22.5882" rx="4" fill="#333333"/>' +
          plate,
      ),
    );
    const unfilled = rewrite(
      onDark,
      onDark.replace(
        plate,
        '<rect width="24" height="24" rx="4" stroke="black"/>' + plate,
      ),
    );

    expect(readAppMark(bordered).radius).toBe(expected.radius);
    expect(readAppMark(bordered).elements).not.toContain(plate);
    expect(readAppMark(unfilled).radius).toBe(expected.radius);
  });

  it('throws when the export has no plate to take the mark out of', () => {
    const noPlate = source.replace(plate, '');
    const noGroup = source.replace(onDark, '');

    expect(() => readAppMark(noPlate)).toThrow(/no plate/);
    expect(() => readAppMark(noGroup)).toThrow(/no plate/);
    expect(() => readAppMark('<svg width="24" height="24"></svg>')).toThrow(
      /no plate/,
    );
  });

  it('throws when the plate carries no silhouette or no mark', () => {
    const square = source.replace(
      plate,
      '<rect width="24" height="24" fill="#191A23"/>',
    );
    const empty = rewrite(
      onDark,
      '<g clip-path="url(#a)"><rect width="24" height="24" rx="5" fill="#191A23"/></g>',
    );

    expect(() => readAppMark(square)).toThrow(/corner radius/);
    expect(() => readAppMark(empty)).toThrow(/no filled mark/);
  });
});

describe('devIconSvg', () => {
  const svg = devIconSvg(source);

  it('puts the mark on the plate in the mark’s own colour', () => {
    expect(svg).not.toContain('fill="white"');
    expect(svg).toContain('fill="#191A23"');
    // Every shape of the mark, and the badge's plate: a fourth shape in the
    // mark's colour would mean one of them was painted in some other.
    expect(svg.match(/fill="#191A23"/g)).toHaveLength(
      readAppMark(source).elements.length + 1,
    );
  });

  it('draws the mark the way the export draws it, mirrored', () => {
    // The export draws both its groups flipped. Dropping the flip would leave
    // the mark back to front, and nothing else here would notice.
    expect(svg).toContain('scale(-1 1)');
  });

  it('draws the badge in pixels, scaled into the export’s units', () => {
    // The badge is written in 1024-space pixels and the icon is drawn in the
    // export's 24: a badge drawn without that scale would cover the icon.
    expect(svg).toContain(`transform="scale(${24 / CANVAS})"`);
  });

  it('carries the badge, and the three letters in it', () => {
    // One stroked plate, one stroked group of letters — and one path per letter.
    expect(svg.match(/stroke="#FFFFFF"/g)).toHaveLength(2);
    expect(svg.match(/<path d="M 8,8/g)).toHaveLength(3);
  });

  it('rims the badge, which is what keeps it off the mark', () => {
    // The mark is the same dark as the badge and reaches into the corner the
    // badge sits in: without a rim of its own width the two read as one shape.
    const [, width = '0'] =
      svg.match(
        /<rect fill="#191A23"[^>]*stroke="#FFFFFF" stroke-width="(\d+)"/,
      ) ?? [];

    expect(Number(width)).toBeGreaterThan(0);
  });

  it('refers only to the definitions it declares', () => {
    const declared = [...svg.matchAll(/id="([\w-]+)"/g)].map(
      (match) => match[1],
    );
    const used = [...svg.matchAll(/url\(#([\w-]+)\)/g)].map(
      (match) => match[1],
    );

    expect(declared.length).toBeGreaterThan(0);

    for (const id of used) {
      expect(declared).toContain(id);
    }
  });

  it('draws the letters larger than their own outlines', () => {
    // A desktop draws an icon small, and the badge cannot grow towards the
    // corner of it, so the letters take the room inside the badge instead: the
    // first letter's advance and the gap after it are 88 of their own units,
    // and what is drawn between two letters is more than that.
    const xs = [
      ...svg.matchAll(/<path d="M 8,8[^>]*translate\(([\d.]+) /g),
    ].map((match) => Number(match[1]));

    expect(xs).toHaveLength(3);
    expect(xs[1] - xs[0]).toBeGreaterThan(88);
    expect(xs[2] - xs[1]).toBeGreaterThan(86);
  });

  it('draws the badge inside the canvas', () => {
    const [, height = '0', width = '0', x = '0', y = '0'] =
      svg.match(
        /<rect fill="#191A23" height="(\d+)" rx="\d+"[^>]*width="(\d+)" x="(\d+)" y="(\d+)"\/>/,
      ) ?? [];

    expect(Number(x) + Number(width)).toBeLessThan(CANVAS);
    expect(Number(y) + Number(height)).toBeLessThan(CANVAS);
  });
});

describe('the development icon as it is committed', () => {
  const resources = path.join(process.cwd(), 'electron', 'resources');
  const drawing = path.join(resources, 'icon-dev.svg');
  const picture = path.join(resources, 'icon-dev.png');

  it('is the drawing scripts/render-dev-icon.ts writes', () => {
    // The picture is committed because a build copies it instead of drawing it.
    // The drawing beside it is where the picture came from, and the only part
    // of the icon that can be compared without rasterising anything: change
    // app/icon.svg, or the way the icon is drawn, and this fails until the
    // script is run again and both files are committed.
    expect(fs.readFileSync(drawing, 'utf8')).toBe(devIconSvg(source));
  });

  it('is a picture electron-builder can make an installer icon from', () => {
    // What the file says about itself, taken from its own header: the eight
    // bytes every PNG starts with, then the width and the height, four bytes
    // each and big-endian — 1024 is what macOS and Windows want of the picture
    // they are handed.
    const png = fs.readFileSync(picture);

    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(CANVAS);
    expect(png.readUInt32BE(20)).toBe(CANVAS);
  });

  it('is not the picture a release carries', () => {
    // A build copying the wrong file ships a release icon with a development
    // build, which is the one thing the icon is there to prevent.
    expect(fs.readFileSync(picture)).not.toEqual(
      fs.readFileSync(path.join(resources, 'icon.png')),
    );
  });
});

describe('the icon a build ships', () => {
  const resources = path.join(process.cwd(), 'electron', 'resources');

  it('is committed, and is the export drawn over', () => {
    // scripts/render-dev-icon.ts writes the drawing and the picture beside each
    // other, and both are committed: a build copies them instead of drawing an
    // icon. An export redrawn without running it leaves a build shipping the
    // old mark inside the new silhouette.
    expect(fs.readFileSync(path.join(resources, 'icon-dev.svg'), 'utf8')).toBe(
      devIconSvg(source),
    );
  });

  it('is square at the size every platform asks for, and not the release icon', () => {
    const png = fs.readFileSync(path.join(resources, 'icon-dev.png'));

    // The width and the height, read out of the PNG's own header: four bytes
    // each, sixteen bytes in.
    expect(png.readUInt32BE(16)).toBe(CANVAS);
    expect(png.readUInt32BE(20)).toBe(CANVAS);
    expect(png.equals(fs.readFileSync(path.join(resources, 'icon.png')))).toBe(
      false,
    );
  });
});
