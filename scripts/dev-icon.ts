/** The icon a development build carries: the console's mark on an orange plate, with a `DEV` badge. Drawn from `app/icon.svg` by scripts/render-dev-icon.ts, which is what gets committed. */
export interface AppMark {
  elements: string[];
  radius: string;
}

export const DEV_ICON_FILENAME = 'icon-dev.png';

/** What the icon is described in: 1024 pixels, drawn in the export's own 24 units. */
export const CANVAS = 1024;
const SOURCE = 24;
/**
 * What the committed picture is: 512. Linux installs a single PNG at its own
 * size, and a 1024 one lands in a `1024x1024` directory no menu looks in.
 */
export const OUTPUT_SIZE = 512;
/** What a pixel of the 1024-space badge is worth in the export's units. */
const SOURCE_UNIT = SOURCE / CANVAS;

const PLATE_STOPS = [
  { color: '#FFD15C', offset: 0 },
  { color: '#FF8F1F', offset: 0.48 },
  { color: '#EE4B00', offset: 1 },
];
const SHEEN_STOPS = [
  { color: '#FFFFFF', offset: 0, opacity: 0.55 },
  { color: '#FFFFFF', offset: 0.32, opacity: 0.14 },
  { color: '#FFFFFF', offset: 0.58, opacity: 0 },
  { color: '#4A1400', offset: 1, opacity: 0.32 },
];
const MARK_COLOR = '#191A23';
const BADGE_COLOR = '#191A23';
const BADGE_LETTER_COLOR = '#FFFFFF';

/** Bottom-right, inside the plate's rounded corner: the arc starts at 803 with a radius of 221. */
const BADGE = {
  height: 174,
  radius: 58,
  width: 380,
  x: 566,
  y: 762,
};
/** The rim that keeps the badge from reading as part of the mark, which is the same dark. */
const BADGE_RING = 9;
const LETTER_HEIGHT = 96;
const LETTER_STROKE = 16;
/**
 * Outlines, not text: a script that rasterises an icon has no typeface to
 * borrow, and a missing one renders nothing at all.
 */
const LETTERS = [
  { advance: 68, path: 'M 8,8 H 40 A 70,70 0 0 1 40,88 H 8 V 8' },
  { advance: 66, path: 'M 8,8 H 58 M 8,8 V 88 H 58 M 8,48 H 48' },
  { advance: 72, path: 'M 8,8 L 36,88 L 64,8' },
];
const LETTER_GAP = 20;
/** The letters take the room inside the badge, which cannot grow towards the corner. */
const LETTER_SCALE = 1.3;

const COMMENT = /<!--[\s\S]*?-->/g;
const GROUP_OPEN = /<g\b[^>]*\bclip-path\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>/g;
const GROUP_TAG = /<g\b|<\/g>/g;
const SHAPE = /<(?:path|rect)\b[^>]*?>(?:[^<]*<\/(?:path|rect)>)?/g;
const RADIUS = /\brx="([\d.]+)"/;
const WIDTH = /\bwidth="([\d.]+)"/;
const PAPER = /\bfill\s*=\s*(?:"white"|'white')/i;
const FILL = /\bfill\s*=\s*(?:"[^"]*"|'[^']*')/;

/** Counted, not matched: a group nested in another has a `</g>` of its own. */
const clippedGroups = (source: string): string[] =>
  [...source.matchAll(GROUP_OPEN)].map((open) => {
    const start = (open.index ?? 0) + open[0].length;
    let depth = 1;
    let end = source.length;

    GROUP_TAG.lastIndex = start;

    for (let tag = GROUP_TAG.exec(source); tag; tag = GROUP_TAG.exec(source)) {
      depth += tag[0] === '</g>' ? -1 : 1;

      if (depth === 0) {
        end = tag.index;

        break;
      }
    }

    return source.slice(start, end);
  });

/** The whole icon's rectangle: its width is the icon's own. A shape with no fill draws nothing of the plate. */
const isPlate = (shape: string): boolean =>
  shape.startsWith('<rect') &&
  FILL.test(shape) &&
  (shape.match(WIDTH)?.[1] ?? '') === `${SOURCE}`;

export const readAppMark = (source: string): AppMark => {
  const body = source.replace(COMMENT, '');
  // The group whose plate is not paper: taking the other one would paint a full
  // square of the plate as the mark.
  const shapes =
    clippedGroups(body)
      .map((group) => [...group.matchAll(SHAPE)].map((shape) => shape[0]))
      .find((group) => {
        const plate = group.find(isPlate);

        return plate !== undefined && !PAPER.test(plate);
      }) ?? [];
  const plate = shapes.find(isPlate) ?? '';
  const radius = plate.match(RADIUS)?.[1] ?? '';
  const elements = shapes.filter(
    (shape) => shape !== plate && FILL.test(shape),
  );

  if (!plate) {
    throw new Error(
      'app/icon.svg has no plate in it — a rectangle the width of the icon, ' +
        'with a fill — for the development icon to take the mark out of. ' +
        'Export app/icon.svg again, or change the icon ' +
        'scripts/render-dev-icon.ts reads.',
    );
  }

  if (!radius || elements.length === 0) {
    throw new Error(
      `app/icon.svg's plate carries no corner radius${elements.length === 0 ? ' and no filled mark' : ''}: both are what the development icon is drawn from. ` +
        'Export app/icon.svg again, or change the icon ' +
        'scripts/render-dev-icon.ts reads.',
    );
  }

  return { elements, radius };
};

const stops = (
  list: { color: string; offset: number; opacity?: number }[],
): string =>
  list
    .map(
      (stop) =>
        `<stop offset="${stop.offset}" stop-color="${stop.color}"` +
        `${stop.opacity === undefined ? '' : ` stop-opacity="${stop.opacity}"`}/>`,
    )
    .join('');

const badge = (): string => {
  const width =
    LETTERS.reduce(
      (total, letter) => total + letter.advance + LETTER_GAP,
      -LETTER_GAP,
    ) * LETTER_SCALE;
  const height = LETTER_HEIGHT * LETTER_SCALE;
  let x = BADGE.x + (BADGE.width - width) / 2;
  const y = BADGE.y + (BADGE.height - height) / 2;
  const letters = LETTERS.map((letter) => {
    const drawn =
      `<path d="${letter.path}" ` +
      `transform="translate(${x} ${y}) scale(${LETTER_SCALE})"/>`;

    x += (letter.advance + LETTER_GAP) * LETTER_SCALE;

    return drawn;
  }).join('');

  return (
    `<rect fill="${BADGE_COLOR}" height="${BADGE.height}" rx="${BADGE.radius}" ` +
    `stroke="${BADGE_LETTER_COLOR}" stroke-width="${BADGE_RING}" ` +
    `width="${BADGE.width}" x="${BADGE.x}" y="${BADGE.y}"/>` +
    `<g fill="none" stroke="${BADGE_LETTER_COLOR}" stroke-linecap="round" ` +
    `stroke-linejoin="round" stroke-width="${LETTER_STROKE}">${letters}</g>`
  );
};

export const devIconSvg = (source: string): string => {
  const { elements, radius } = readAppMark(source);
  const mark = elements
    .map((element) => element.replace(FILL, `fill="${MARK_COLOR}"`))
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" height="${CANVAS}" ` +
    `viewBox="0 0 ${SOURCE} ${SOURCE}" width="${CANVAS}">` +
    '<defs>' +
    `<linearGradient id="dev-plate" x1="0" x2="1" y1="0" y2="1">` +
    `${stops(PLATE_STOPS)}</linearGradient>` +
    `<linearGradient id="dev-sheen" x1="0" x2="0.9" y1="0" y2="1">` +
    `${stops(SHEEN_STOPS)}</linearGradient>` +
    `<clipPath id="dev-silhouette"><rect height="${SOURCE}" rx="${radius}" ` +
    `width="${SOURCE}"/></clipPath>` +
    '</defs>' +
    '<g clip-path="url(#dev-silhouette)">' +
    `<rect fill="url(#dev-plate)" height="${SOURCE}" width="${SOURCE}"/>` +
    `<rect fill="url(#dev-sheen)" height="${SOURCE}" width="${SOURCE}"/>` +
    // The export draws its mark mirrored; this puts it back the way the console shows it.
    '<g transform="translate(24 0) scale(-1 1)">' +
    mark +
    '</g>' +
    `<g transform="scale(${SOURCE_UNIT})">${badge()}</g>` +
    '</g>' +
    '</svg>'
  );
};
