import fs from 'node:fs';
import path from 'node:path';

/**
 * Which builds carry the development icon.
 *
 * Nothing in the code keeps a release from carrying it: scripts/build-desktop.ts
 * copies it whenever it is asked to, and asking is one flag on one command
 * line, in a workflow file or in a lane. The flag is the only thing that says
 * which build is which, so the command lines are what is guarded here.
 */
const read = (relative: string): string =>
  fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

/**
 * The file without the lines that only explain it: both formats here comment
 * with a leading `#`, and a comment that names the flag is not a build that
 * passes it.
 */
const code = (relative: string): string =>
  read(relative)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const RELEASE = '.github/workflows/release.yml';
const CHECK = '.github/workflows/ci-desktop.yml';
const LANE = 'fastlane/Fastfile';

describe('the development icon in a build', () => {
  it('is asked for by the build that checks a change', () => {
    // A check build is not meant to be installed, and is the one the icon is
    // for: dropping the flag here leaves a check build looking like a release.
    expect(code(CHECK)).toContain('--dev-icon');
  });

  it('is asked for by no release workflow', () => {
    expect(code(RELEASE)).not.toContain('--dev-icon');
  });

  it('is not what the macOS release is packaged from', () => {
    // The macOS release runs through fastlane, which calls the build script
    // itself and not `desktop:dev-dist`: the npm script asks for the
    // development icon, the script does not, and that difference is the whole
    // release.
    const lane = code(LANE);
    const commands = lane
      .split('\n')
      .filter((line) => line.includes('scripts/build-desktop.ts'));

    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain('--dev-icon');
    expect(lane).not.toContain('desktop:dist');
  });

  it('is copied by the build, not drawn by it', () => {
    // The icon is a committed file, and rasterising an SVG is nobody's build
    // step: it needs a native image library, and it makes what a check on CI
    // ships depend on the rasteriser that happened to run there.
    expect(read('scripts/build-desktop.ts')).not.toContain(
      'render-dev-icon.ts',
    );
  });
});
