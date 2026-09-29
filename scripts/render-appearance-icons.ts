/**
 * Draws the three pictures the appearance menu carries, into electron/resources.
 * Run by hand, not by a build: what it draws is committed, and a build copies it.
 *
 * Usage: `bun run icons:appearance`
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

/** Where the repository is, whichever directory this is run from. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = path.join(root, 'electron', 'resources');

/** What a menu item is drawn at: sixteen points, at twice the pixels. */
const SIZE = 32;

/**
 * One colour, and no colour of this app's: a menu picture is drawn by the
 * desktop, and one that carried its own would be the wrong one in whichever
 * appearance it was not drawn for.
 */
const INK = '#000000';

/**
 * Light is a full sun, dark a moon on the wane, and following the system the
 * two halves of both — which is what the choice is: the one the computer has
 * already made, either way round.
 */
const PICTURES: Record<'dark' | 'light' | 'system', string> = {
  light: `<circle cx="16" cy="16" r="7" fill="${INK}"/>`,
  dark: `<path d="M16 5a11 11 0 1 0 11 11A8.5 8.5 0 0 1 16 5Z" fill="${INK}"/>`,
  system: `<path d="M16 4a12 12 0 0 1 0 24Z" fill="${INK}"/>
    <path d="M16 4a12 12 0 0 0 0 24Z" fill="${INK}" fill-opacity="0.35"/>`,
};

const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" fill="none" height="${SIZE}" ` +
  `viewBox="0 0 32 32" width="${SIZE}">${body}</svg>`;

const main = async (): Promise<void> => {
  fs.mkdirSync(RESOURCES, { recursive: true });

  for (const [name, body] of Object.entries(PICTURES)) {
    const png = await sharp(Buffer.from(svg(body)))
      .png({ compressionLevel: 9 })
      .toBuffer();

    fs.writeFileSync(path.join(RESOURCES, `appearance-${name}.png`), png);

    console.log(`appearance-${name}.png written (${png.length} bytes)`);
  }
};

await main();
