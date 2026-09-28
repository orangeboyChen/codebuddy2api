/**
 * The icon a development build of the desktop app carries.
 *
 * The release icon is the console's own mark on the dark brand plate. A build
 * nobody is meant to install — a check on CI, or `electron .` from a checkout —
 * gets the same mark on an orange plate with a `DEV` badge in its bottom-right
 * corner, so an app that is not a release does not look like one in the Dock,
 * in an installer or in the window that asks about updates.
 *
 * Both icons are rendered from `app/icon.svg`, the file the console itself is
 * served from: nothing here draws the mark, it only lifts it out of the export
 * and puts it on another plate.
 */

/**
 * The mark and the silhouette it sits in, lifted out of the icon the console
 * is served from.
 *
 * `app/icon.svg` is a design export drawn twice: the mark in the brand colour
 * on a white plate, and — in the last group, the one a desktop install shows —
 * the same mark in white on the dark plate. What is wanted here is the mark
 * alone, so the plate is left behind: of that group's shapes the ones filled in
 * the mark's colour are kept, which is every one of them but the plate. The
 * plate's corner radius comes along instead, so the development icon keeps the
 * release icon's silhouette however the export is redrawn.
 */
export interface AppMark {
  /** The shapes of the mark, in the export's own 24-unit coordinates. */
  elements: string[];
  /** The plate's corner radius, in the same units. */
  radius: string;
}

/**
 * The file the development icon is written to, next to the bundled main
 * process: electron/main.ts looks for it there, and electron-builder is pointed
 * at it for every platform.
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
/** The letters: 96 pixels tall, drawn with a 16-pixel stroke centred on the outline. */
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

const GROUP = /<g clip-path="url\(#[\w-]+\)">([\s\S]*?)<\/g>/g;
const SHAPE = /<(?:path|rect)\b[^>]*\/>/g;
const RADIUS = /\brx="([\d.]+)"/;

export const readAppMark = (source: string): AppMark => {
  const groups = [...source.matchAll(GROUP)];
  const group = groups.at(-1)?.[1] ?? '';
  const shapes = [...group.matchAll(SHAPE)].map((match) => match[0]);
  const plate = shapes.find((shape) => shape.startsWith('<rect')) ?? '';
  const radius = plate.match(RADIUS)?.[1] ?? '';
  // The mark is the rest of the group: every shape filled in white, which the
  // plate — the only other thing in there — is not.
  const elements = shapes.filter((shape) => shape.includes('fill="white"'));

  if (!radius || elements.length === 0) {
    throw new Error(
      'app/icon.svg holds no dark plate with a white mark in it. ' +
        'The development icon is drawn from that group; render the icons again ' +
        'from the export, or point scripts/render-dev-icon.ts at the new one.',
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
  const width = LETTERS.reduce(
    (total, letter) => total + letter.advance + LETTER_GAP,
    -LETTER_GAP,
  );
  let x = BADGE.x + (BADGE.width - width) / 2;
  const y = BADGE.y + (BADGE.height - LETTER_HEIGHT) / 2;
  const letters = LETTERS.map((letter) => {
    const drawn = `<path d="${letter.path}" transform="translate(${x} ${y})"/>`;

    x += letter.advance + LETTER_GAP;

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
  const mark = elements
    .map((element) =>
      element.replaceAll('fill="white"', `fill="${MARK_COLOR}"`),
    )
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
    `<clipPath id="dev-mark"><rect height="${SOURCE}" rx="${radius}" ` +
    `width="${SOURCE}"/></clipPath>` +
    '</defs>' +
    '<g clip-path="url(#dev-silhouette)">' +
    `<rect fill="url(#dev-plate)" height="${SOURCE}" width="${SOURCE}"/>` +
    `<rect fill="url(#dev-sheen)" height="${SOURCE}" width="${SOURCE}"/>` +
    '<g transform="translate(24 0) scale(-1 1)">' +
    `<g clip-path="url(#dev-mark)">${mark}</g>` +
    '</g>' +
    `<g transform="scale(${SOURCE_UNIT})">${badge()}</g>` +
    '</g>' +
    '</svg>'
  );
};
