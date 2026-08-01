import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const defaultThreshold = 90;

const normalizePath = (filePath: string) =>
  relative(process.cwd(), resolve(process.cwd(), filePath)).replaceAll(
    '\\',
    '/',
  );

const parseArguments = () => {
  const argumentsMap = new Map<string, string>();

  for (let index = 0; index < process.argv.length; index += 1) {
    const argument = process.argv[index];

    if (argument?.startsWith('--')) {
      const value = process.argv[index + 1];

      if (value && !value.startsWith('--')) {
        argumentsMap.set(argument, value);
        index += 1;
      }
    }
  }

  return argumentsMap;
};

const getChangedLines = (base: string) => {
  const diff = execFileSync('git', ['diff', '--unified=0', `${base}...HEAD`], {
    encoding: 'utf8',
  });
  const changedLines = new Map<string, Set<number>>();
  let currentFile: string | undefined;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);

    if (!hunk || !currentFile) {
      continue;
    }

    const start = Number(hunk[1]);
    const count = Number(hunk[2] ?? '1');

    if (count === 0) {
      continue;
    }

    const lines = changedLines.get(currentFile) ?? new Set<number>();

    for (let lineNumber = start; lineNumber < start + count; lineNumber += 1) {
      lines.add(lineNumber);
    }

    changedLines.set(currentFile, lines);
  }

  return changedLines;
};

const getBranchCoverage = (changedLines: Map<string, Set<number>>) => {
  const branchCoverage = new Map<string, { covered: number; total: number }>();
  let currentFile: string | undefined;

  for (const line of readFileSync('coverage/lcov.info', 'utf8').split('\n')) {
    if (line.startsWith('SF:')) {
      currentFile = normalizePath(line.slice(3));
      continue;
    }

    if (!currentFile || !line.startsWith('BRDA:')) {
      continue;
    }

    const [lineNumber, , , hits] = line.slice(5).split(',');
    const changedFileLines = changedLines.get(currentFile);

    if (!changedFileLines?.has(Number(lineNumber))) {
      continue;
    }

    const coverage = branchCoverage.get(currentFile) ?? {
      covered: 0,
      total: 0,
    };
    coverage.total += 1;
    coverage.covered += hits !== '-' && Number(hits) > 0 ? 1 : 0;
    branchCoverage.set(currentFile, coverage);
  }

  return branchCoverage;
};

const argumentsMap = parseArguments();
const base = argumentsMap.get('--base');
const threshold = Number(argumentsMap.get('--threshold') ?? defaultThreshold);

if (!base) {
  throw new Error('Provide the PR base commit with --base <sha>.');
}

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  throw new Error('Provide a branch coverage threshold between 0 and 100.');
}

const branchCoverage = getBranchCoverage(getChangedLines(base));
const totals = [...branchCoverage.values()].reduce(
  (result, coverage) => ({
    covered: result.covered + coverage.covered,
    total: result.total + coverage.total,
  }),
  { covered: 0, total: 0 },
);
const coverage =
  totals.total === 0 ? 100 : (totals.covered / totals.total) * 100;

console.log(
  `Changed branch coverage: ${coverage.toFixed(2)}% (${totals.covered}/${totals.total})`,
);

if (coverage < threshold) {
  throw new Error(
    `Changed branch coverage ${coverage.toFixed(2)}% is below ${threshold.toFixed(2)}%.`,
  );
}
