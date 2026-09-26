# Atlas migration

Imported from the Agents working tree on 2026-09-26, based on commit
`0090f570332366469876aa0ff0255570829ae47a`. The original checkout is unchanged.
`codebase-atlas-codex.md` was an untracked design note in that checkout and is
preserved here alongside the committed design documents.

| Agents source | Atlas destination |
| --- | --- |
| `tooling/semantic-surface/src/` | `src/lib/` |
| `tooling/semantic-surface/test/` | `test/lib/` |
| `tooling/semantic-surface/README.md` | `docs/semantic-surface.md` |
| `apps/documentation/src/atlas/` | `src/web/`, tests under `test/web/` |
| `apps/documentation/public/atlas/` | `public/atlas/` |
| `docs/designs/codebase-atlas*.md`, `semantics-v13.md` | `docs/` |

## Integration changes

- The existing Atlas CLI calls `generateSemantics`, `runInternalAnalysis`, and
  optionally `generateSemanticsHistory`. The old Agents CLI was not imported.
- The browser loaders fetch raw output files from `/data`. Package manifests are
  copied unchanged, and internal analysis results are serialized without a wrapper.
  The renderer's existing binding and geometry functions remain in the browser.
- The analysis subprocess resolves a TypeScript worker during source execution
  and a built JavaScript worker in `dist/cli`. Runtime dependencies stay external
  to the Bun bundles, including TypeScript for dependency analysis.
- Imports from the old package barrel now reference library modules directly.
  The root library barrel was omitted. Safe Ultracite formatting and import
  organization were applied; analysis and rendering algorithms were retained.
- The map loader gives an empty workspace finite dimensions. Historical data is
  optional. Missing or stale internal evidence produces a visible error.
- Custom font imports and the old documentation-host link were removed. The viewer
  uses system fallbacks. The ship
  model and its provenance were copied unchanged.

The old Astro HTTP endpoints, response envelopes, and filesystem access do not
run in Atlas. Their internals loader remains only as a test reference for the
inherited behavior tests. The exploratory CLI examples and their three tests were
not imported. Tests that exercised the old analysis CLI now call the public
library entry point. New integration tests cover Atlas's actual commands.

The renderer tests use a captured original Atlas layout in
`test/fixtures/atlas.json` so they do not require the Agents checkout or its cache.
This fixture is test data only. The terminal report snapshot was refreshed with
its fixture outside Git, making it independent of the host repository's history.

## Verification on migration

- CLI, worker, and Vite production build passed. Vite reports a large browser
  chunk of about 1 MB before gzip.
- Workspace typechecking passed across all 20 Turbo tasks. Dependency consistency
  passed. The new CLI, server, browser loaders, build scripts, and integration
  tests pass their scoped Ultracite check.
- The library and renderer suite passed 1,325 of 1,326 tests across 95 files.
  `topography.test.ts` retains one existing failure: a contour elevation error is
  `0.508651944207597` against a strict `< 0.5` assertion. Running the original
  and migrated contour functions on the same reference fixture produces deeply
  equal results. The assertion was not weakened or skipped.
- All six CLI/server integration tests passed, including built-worker execution,
  incremental reuse, Git history generation in a temporary repository, byte
  preservation, static assets, and browser loaders after source removal.
- The built CLI scanned the Foundry workspace successfully, producing reports
  for all 11 packages. Verification output was stored under
  `/private/tmp/atlas-foundry-migration`, separate from normal user state.
- Repository `validate` is not green. The imported library and renderer have
  existing code patterns rejected by Foundry's stricter Ultracite rules, and
  Knip reports retained library exports and three modules that Atlas does not
  currently call. These were not removed or broadly suppressed during migration.
  Knip also reports unrelated existing Quirks dependencies and exports.
- A follow-up headed Playwright Chromium pass verified the production build at
  desktop and 390px mobile widths. The map rendered; package search and selection,
  internal evidence, file composition inspection, map layers, zoom controls,
  experimental land/road/forest toggles, and visualization reset worked. No
  uncaught JavaScript errors occurred. The only HTTP errors were the expected
  optional history manifest 404s for a current-only scan. The stale documentation
  link discovered in this pass was removed and the rebuilt page was rechecked.

The preserved design documents describe the old host, package names, and fonts.
Use the app README and current code for Atlas's runtime wiring.
