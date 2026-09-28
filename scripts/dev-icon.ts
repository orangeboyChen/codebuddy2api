/**
 * The icon a development build of the desktop app carries.
 *
 * The release icon is the console's own mark on the dark brand plate. A build
 * nobody is meant to install — a check on CI, or `electron .` from a checkout —
 * gets the same mark on an orange plate with a `DEV` badge in its bottom-right
 * corner, so an app that is not a release does not look like one: in an
 * installer, in the Finder, and on the Dock whenever the app shows one.
 *
 * Both icons are rendered from `app/icon.svg`, the file the console itself is
 * served from: nothing here draws the mark, it only lifts it out of the export
 * and puts it on another plate. scripts/render-dev-icon.ts draws the result
 * once, into electron/resources, and that is what gets committed — the build
 * copies the picture, it does not make it.
 */

/**
 * The mark and the silhouette it sits in, lifted out of the icon the console
 * is served from.
 *
 * `app/icon.svg` is a design export drawn twice: the mark in the brand colour
 * on a white plate, and — in the group a desktop install shows — the same mark
 * in white on the dark plate. What is wanted here is the mark alone, so the
 * plate is left behind: the group taken is the one whose plate is not paper,
 * and every filled shape in it but the plate is the mark. The plate's corner
 * radius comes along instead, so the development icon keeps the release icon's
 * silhouette however the export is redrawn.
 */
export interface AppMark {
  /** The shapes of the mark, in the export's own 24-unit coordinates. */
  elements: string[];
  /** The plate's corner radius, in the same units. */
  radius: string;
}

/**
 * The name the development icon carries, committed in electron/resources and
 * copied next to the bundled main process: electron/main.ts spells the same
 * name out rather than importing it from a build script the app would then
 * carry, and electron-builder is pointed at it for every platform.
 */
export const DEV_ICON_FILENAME = 'icon-dev.png';

/** How many pixels wide the icon is rendered, and how big the source is. */
export const CANVAS = 1024;
const SOURCE = 24;
/**
 * What a pixel of the 1024-space badge is worth once it is drawn inside the
 * export's 24-unit viewBox.
 */
const SOURCE_UNIT = SOURCE / CANVAS;

/** The plate: a polarized orange, light at the top-left and deep at the bottom-right. */
const PLATE_STOPS = [
  { color: '#FFD15C', offset: 0 },
  { color: '#FF8F1F', offset: 0.48 },
  { color: '#EE4B00', offset: 1 },
];
/**
 * Laid over the plate: the sheen a polarizing filter leaves, a bright top-left
 * falling off to nothing by the middle and a shadow in the far corner.
 */
const SHEEN_STOPS = [
  { color: '#FFFFFF', offset: 0, opacity: 0.55 },
  { color: '#FFFFFF', offset: 0.32, opacity: 0.14 },
  { color: '#FFFFFF', offset: 0.58, opacity: 0 },
  { color: '#4A1400', offset: 1, opacity: 0.32 },
];
/** The mark's colour on the plate: the brand dark, which reads on orange. */
const MARK_COLOR = '#191A23';
/** The badge: the brand dark, carrying the letters in white. */
const BADGE_COLOR = '#191A23';
const BADGE_LETTER_COLOR = '#FFFFFF';

/**
 * The badge, in 1024-space pixels: bottom-right, inside the plate's rounded
 * corner with room to spare. The corner arc starts at 803 and has a radius of
 * 221, so the badge's own far corner — 195 pixels from that arc's centre, 202
 * once the rim below is counted — stays well within the silhouette.
 */
const BADGE = {
  height: 174,
  radius: 58,
  width: 380,
  x: 566,
  y: 762,
};
/**
 * The badge's white rim.
 *
 * The mark reaches into the corner the badge sits in, and the two are the same
 * dark, so without a rim the badge reads as part of the mark rather than as
 * something put on top of the icon.
 */
const BADGE_RING = 9;
/** The letters: 96 pixels tall including the stroke, drawn at `LETTER_SCALE`. */
const LETTER_HEIGHT = 96;
const LETTER_STROKE = 16;
/**
 * The three letters, as outlines rather than as text.
 *
 * A build script that rasterises an icon has no typeface to borrow, and a
 * missing one renders nothing at all — silently, which would leave an icon
 * whose badge says nothing. Each letter is a stroke drawn through an outline:
 * `D` a stem with a shallow bowl, `E` a stem with three arms, `V` a chevron.
 * `advance` is the width the letter takes including the space after it.
 */
const LETTERS = [
  { advance: 68, path: 'M 8,8 H 40 A 70,70 0 0 1 40,88 H 8 V 8' },
  { advance: 66, path: 'M 8,8 H 58 M 8,8 V 88 H 58 M 8,48 H 48' },
  { advance: 72, path: 'M 8,8 L 36,88 L 64,8' },
];
/** The gap between two letters. */
const LETTER_GAP = 20;
/**
 * What the letters are drawn at.
 *
 * A desktop draws an icon small — a menu bar, a taskbar, a window that names
 * what is installed — and three letters in a corner are the first thing to
 * stop reading when it does. The badge cannot grow towards the corner of the
 * icon, so the letters take the room inside it instead: at 1.3 they measure
 * 320 by 125 in a badge whose rim leaves 371 by 165, which keeps a margin all
 * round them. Even so they stop reading below 64 pixels, where what tells a
 * development build apart is the plate's colour.
 */
const LETTER_SCALE = 1.3;

/** A comment, which can hide a shape in it that is not drawn at all. */
const COMMENT = /<!--[\s\S]*?-->/g;
/** The opening tag of a clipped group, with any attributes and either quote. */
const GROUP_OPEN = /<g\b[^>]*\bclip-path\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>/g;
/** Either end of a `<g>`, which a group nested in another one also has. */
const GROUP_TAG = /<g\b|<\/g>/g;
// A shape is either self-closing or closed by its own tag, and the tag an
// export writes may carry a space before its `>`.
const SHAPE = /<(?:path|rect)\b[^>]*?>(?:[^<]*<\/(?:path|rect)>)?/g;
const RADIUS = /\brx="([\d.]+)"/;
const WIDTH = /\bwidth="([\d.]+)"/;
const PAPER = /\bfill\s*=\s*(?:"white"|'white')/i;
/** Whatever fill a shape of the mark was exported with, in either quote. */
const FILL = /\bfill\s*=\s*(?:"[^"]*"|'[^']*')/;

/**
 * What each clipped group of the export holds, the tag's own contents.
 *
 * Counted rather than matched, because a group a design tool nests inside
 * another one has a `</g>` of its own: a pattern that stops at the first of
 * those would drop everything drawn after it, silently.
 */
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

/**
 * The plate, of the group's shapes: the one the whole icon is drawn on, which
 * is what its width being the icon's own says. A shape with no fill of its
 * own — a border, or a clip path left in the group — is not one: it draws
 * nothing of the plate's colour, and taking it for the plate would leave the
 * plate itself to be painted as the mark.
 */
const isPlate = (shape: string): boolean =>
  shape.startsWith('<rect') &&
  FILL.test(shape) &&
  (shape.match(WIDTH)?.[1] ?? '') === `${SOURCE}`;

export const readAppMark = (source: string): AppMark => {
  const body = source.replace(COMMENT, '');
  // The group a desktop install shows is the one whose plate is not paper: the
  // export draws the plate twice, and taking the other one would paint a full
  // square of the plate as the mark — an icon with nothing on it.
  const shapes =
    clippedGroups(body)
      .map((group) => [...group.matchAll(SHAPE)].map((shape) => shape[0]))
      .find((group) => {
        const plate = group.find(isPlate);

        return plate !== undefined && !PAPER.test(plate);
      }) ?? [];
  const plate = shapes.find(isPlate) ?? '';
  const radius = plate.match(RADIUS)?.[1] ?? '';
  // The mark is every other shape of the group that is filled, whatever colour
  // the export drew it in: it is put on the plate in the mark's own below.
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

/**
 * The badge: its plate, and the letters centred in it — laid out from the
 * advances above so the three sit in the middle whatever they measure. Every
 * number is a pixel of the 1024-space canvas, which the caller scales into the
 * export's units.
 */
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

/**
 * The development icon, as the SVG it is rasterised from.
 *
 * Drawn in the export's own 24 units and asked for at 1024 pixels, so the mark
 * keeps the size and the place it has on the release icon while the badge is
 * written in pixels and scaled to fit: `SOURCE_UNIT` is what a pixel is worth
 * in there.
 */
export const devIconSvg = (source: string): string => {
  const { elements, radius } = readAppMark(source);
  // Whatever colour the export drew the mark in: it goes on the plate in the
  // mark's own. Every shape of it carries a fill of its own — a shape that does
  // not is not part of the mark, and is left out for that reason.
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
    // The rounded corner everything is clipped to: the plate is drawn as a
    // square and takes its silhouette from here, and nothing of the mark or of
    // the badge is left outside it however far they reach.
    `<clipPath id="dev-silhouette"><rect height="${SOURCE}" rx="${radius}" ` +
    `width="${SOURCE}"/></clipPath>` +
    '</defs>' +
    '<g clip-path="url(#dev-silhouette)">' +
    `<rect fill="url(#dev-plate)" height="${SOURCE}" width="${SOURCE}"/>` +
    `<rect fill="url(#dev-sheen)" height="${SOURCE}" width="${SOURCE}"/>` +
    // The export draws its mark mirrored, and so is this one: the mark is put
    // back the way the console shows it.
    '<g transform="translate(24 0) scale(-1 1)">' +
    mark +
    '</g>' +
    `<g transform="scale(${SOURCE_UNIT})">${badge()}</g>` +
    '</g>' +
    '</svg>'
  );
};
