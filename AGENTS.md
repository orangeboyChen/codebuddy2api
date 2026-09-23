# Repository Guidelines

## Commit Rules

- Use English conventional commits, for example `feat: reorganize source layout`.
- Do not commit until `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test:coverage`, and `bun run build` all pass.
- Unit test coverage must stay at or above the enforced thresholds; see [Coverage Thresholds](#coverage-thresholds). Do not commit code below them.

## Code Style

- Write comments in English only.
- Keep README, deployment manifests, GitHub Actions, and Dependabot aligned with the current repository structure.
- Prefer Bun for dependency management and local commands.
- Prefer TypeScript for application and test code whenever a new file or rewrite is needed.
- Use arrow functions only. Do not introduce `function` declarations; prefer `const name = () => {}` consistently.
- Do not leave unused variables in committed code. Remove them or rename intentionally ignored values with a leading underscore only when the linter rule allows it.
- When changing user-visible copy, review every supported locale in `messages/` and keep equivalent wording aligned across them.

## Verification Before Commit

- Run `bun run lint`.
- Run `bun run format:check`.
- Run `bun run typecheck`.
- Treat unit test coverage below the enforced thresholds as a blocking failure.
- Run `bun run test:coverage` and confirm lines, statements, and functions are at or above 90% and branches at or above 70%.
- Run `bun run build`.

## Verification Before PR

- Run `bun run test:ci` to generate `coverage/lcov.info` and `test-report.junit.xml`.
- Run `bun run test:patch-branches --base "$(git merge-base HEAD origin/main)"` after coverage; changed branch coverage must be at least 90%.
- Confirm Codecov's `patch` status is successful and meets the target configured in `codecov.yml`; do not lower the patch target or threshold to bypass a coverage failure.
- Use the Codecov PR report as the source of truth for patch coverage because it compares the uploaded `lcov.info` against the PR base commit.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Coverage Thresholds

`vitest.config.ts` enforces the project-wide gate that `bun run test:coverage` runs:

- `lines`, `statements`, and `functions`: 90%
- `branches`: 70%

`bun run test:patch-branches` enforces a separate, stricter gate for a PR: **changed** branch
coverage must be at least 90% (`scripts/check-patch-branches.ts`). Codecov's `patch` status
compares the uploaded `coverage/lcov.info` against the PR base commit and is the source of truth
for that patch gate.

Read the branch number from the project gate (70%), not the patch gate (90%) — they measure
different things, and a project branch percentage in the high 80s is passing, not failing.
Never lower either threshold to get a build through.
