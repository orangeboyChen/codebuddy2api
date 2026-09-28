import fs from 'node:fs';
import path from 'node:path';

// Which builds carry the development icon. The flag is the only thing that says
// which build is which, so the command lines are what is guarded here.
const read = (relative: string): string =>
  fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

// Without the lines that only explain it: both formats comment with a leading
// `#`, and a comment naming the flag is not a build that passes it.
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
    // A check build is the one the icon is for: dropping the flag leaves it
    // looking like a release.
    expect(code(CHECK)).toContain('--dev-icon');
  });

  it('is asked for by no release workflow', () => {
    expect(code(RELEASE)).not.toContain('--dev-icon');
  });

  it('is not what the macOS release is packaged from', () => {
    // fastlane calls the build script itself, not `desktop:dev-dist`: the npm
    // script asks for the development icon, the build script does not.
    const lane = code(LANE);
    const commands = lane
      .split('\n')
      .filter((line) => line.includes('scripts/build-desktop.ts'));

    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain('--dev-icon');
    expect(lane).not.toContain('desktop:dist');
  });

  it('is copied by the build, not drawn by it', () => {
    // The icon is committed, so a build copies it: rasterising an SVG needs a
    // native image library nobody's build should have to load.
    expect(read('scripts/build-desktop.ts')).not.toContain(
      'render-dev-icon.ts',
    );
  });
});
