# Repository standards

Create new worktrees only under `<repository root>/.worktrees/`. Use `wt`
with `worktree-path = "{{ repo_path }}/.worktrees/{{ branch | sanitize }}"`.

Use Bun and Turborepo. Keep dependency versions explicit in each package.json;
do not introduce dependency catalogs. Internal packages use `workspace:*`.
Use Varlock for application environment loading and validation.
Keep shared dependency ranges consistent. Install repository tools locally and
commit bun.lock; do not use floating bunx downloads in scripts or CI.

## Commands and ownership

- `bun run validate`: combined lint/format, dependency consistency, typecheck, and dead-code checks.
- `bun run lint` / `lint:fix`: repository-wide Biome lint using Ultracite rules.
- `bun run format` / `format:fix`: repository-wide Biome formatting.
- `bun run check` / `fix`: combined Ultracite checks or fixes, including import organization.
- `bun run typecheck`: Turbo runs each package's `typecheck`. Use this spelling in new packages.
- `bun run lint:deps`: Sherif checks workspace manifests and dependency versions.
- `bun run dead-code`: Knip analyzes the workspace graph. Add real entry points for dynamic loading; justify narrow exceptions rather than disabling whole rules.
- `bun run build`, `test`, `test:coverage`, and `clean`: delegate to package scripts through Turbo.
- `bun run test:watch` and `dev`: persistent, uncached tasks for local development.

Build, test, and clean implementations belong in each package. Add only scripts
that perform real work. Source-only packages do not need a placeholder build.
Declare generated build outputs in turbo.json or a package-level turbo.json.
Typechecking waits for dependency builds; tests wait for their package build.
Keep integration tests requiring credentials or external services separate from
the default test command. Declare task-specific environment inputs in Turbo.

Clean scripts remove only named generated directories, never source, env files,
or node_modules. Dependency removal is a separate manual maintenance action.
Do not run clean concurrently with builds, tests, or typechecking.

## Code style

Ultracite (Biome) enforces code style and lint rules; run `bun run fix` on the
paths you changed. The `ultracite` skill holds the full code standards.

## Testing

- Vitest is the only test runner; never `bun test`. A package's `test` script is
  one `vitest run`. Packages whose code needs Bun (OpenTUI, `Bun.serve`) run it
  on Bun with `bun ../../node_modules/vitest/vitest.mjs run`.
- Packages keep tests in `src/test/`; apps keep tests in root `test/`.
- Shared test helpers belong in that test directory's `helpers/` folder.
