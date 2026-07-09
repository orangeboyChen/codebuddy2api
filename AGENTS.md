# Repository Guidelines

## Commit Rules

- Use English conventional commits, for example `feat: reorganize source layout`.
- Use the Codex identity for Codex-authored commits: `codex <codex@users.noreply.github.com>`.
- Do not commit until `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test:coverage`, and `bun run build` all pass.
- Unit test coverage must stay at or above 90%; do not commit code below the enforced coverage threshold.

## Code Style

- Write comments in English only.
- Keep README, deployment manifests, GitHub Actions, and Dependabot aligned with the current repository structure.
- Prefer Bun for dependency management and local commands.
- Prefer TypeScript for application and test code whenever a new file or rewrite is needed.
- Use arrow functions only. Do not introduce `function` declarations; prefer `const name = () => {}` consistently.
- Do not leave unused variables in committed code. Remove them or rename intentionally ignored values with a leading underscore only when the linter rule allows it.

## Verification Before Commit

- Run `bun run lint`.
- Run `bun run format:check`.
- Run `bun run typecheck`.
- Treat unit test coverage below 90% as a blocking failure.
- Run `bun run test:coverage` and confirm the reported coverage stays at or above 90%.
- Run `bun run build`.
