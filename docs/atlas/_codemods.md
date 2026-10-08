# Atlas codemods

Maintainer note, excluded from the Blume site. Dated 2026-10-06. Research
for the third layer in [`_roadmap.md`](./_roadmap.md): what a codemod is in
Atlas, what the code already does, which tools could carry it, and an
opinion on how to build it. Paths are under `apps/atlas/src/lib`.

## What we need

Rules declare what a workspace wants to be true about its own structure:
what a package may expose, what may depend on what, where a concept
belongs. Observations are the dataset: the scan's facts, the opportunities
with their eligibility gates, the plans, scenarios, and reviews that
describe how the code departs from a rule. A codemod is the step that
applies a plan to the code the rule is connected to, so that the next scan
observes the rule holding.

Codemods consume rules; they never define them. The order is fixed: a rule
names what must hold, an observation names where it does not, a plan names
the files and edits that would make it hold, and only then does a mutator
touch the repository. Nothing writes without a rule that says it may.

Done means a workspace can declare a rule, see the places that break it,
preview the edits that would fix one, and apply them with the same
verification and rollback the existing operator has, from the CLI, with
the workspace otherwise never modified.

## What exists

The read-only side is nearly complete and the mutating side has one proven
path.

- **One mutating operator.** `apply.ts` implements `internalize-export`: a
  package-public symbol stops being part of the package's public surface.
  The lifecycle is fixed and worth keeping for every future codemod:
  analyze fresh, revalidate the plan against that analysis, refuse when a
  planned file has uncommitted changes, edit deterministically through
  ts-morph, and only with `write: true` save, verify, and restore the exact
  pre-mutation bytes on any verification failure. Without `write` it is a
  preview.
- **Verification is structural, not textual.** `verifyInternalizeExport`
  checks that the symbol still exists, that no entrypoint route exposes it,
  that external usage stayed at zero, and that the observed delta matches
  the plan's prediction. Typecheck diagnostics are diffed before and after
  so an edit cannot introduce an error.
- **A capability registry.** `mutation-capabilities.ts` is data: which
  planned transformation kinds and syntax forms a mutator can execute
  today, atomically and reversibly. Of the thirteen
  `PlannedTransformationKind`s in `operator-plan-types.ts`, six are
  covered (`remove-export`, `rewrite-reexport`, `rewrite-import`,
  `update-test-import`, `preserve-compatibility-export`, `verify-only`),
  each for a short list of forms such as `named-import-relative`. The
  comment says widening it is done by adding mutator support first.
- **An operator catalog.** `operator-catalog.ts` defines every
  architectural operator as data: subjects, required fields, verification
  kinds, and whether it decomposes into planned transformations. Only
  `internalize` is `executable: true`; `move`, `redirect-dependency`,
  `rehome-behavior`, `rehome-concept`, and the structural actions all say
  `executable: false`.
- **A readiness gate.** `operator-readiness.ts` is the last read-only
  check before a mutator runs. It answers with one authorization, with a
  fixed precedence: `stale`, then `unsupported`, then `blocked`, then
  `not-authorized`, then `authorized`. It never repairs a plan and never
  writes.
- **ts-morph is already a dependency**, and `project.ts` builds the
  compiler project the analysis and the mutator share. The mutator uses
  ts-morph's node API (`setIsExported`, `remove`) rather than text edits.
- **The CLI does not expose any of it.** Nothing under `src/cli` imports
  `apply.ts`. The roadmap says nothing should until rules say when a
  mutator may run.

Rules are the missing layer. `config.ts` holds the analysis policy, with
thresholds and gates, but nothing a workspace can declare about its own
structure that the readiness gate could consult.

## Tools

Surveyed 2026-10-06 from primary sources (official docs, repositories, the
npm registry) and a scratch run on Bun 1.3.14 outside the repository. One
lens for every tool: can a transform be declared as data keyed by
transformation kind and syntax form, so the capability registry grows
declaratively, and does the tool find references across packages or only
match syntax? Plus: runs under Bun, and a license an MIT package can use.

The backdrop that shapes every answer: TypeScript 7.0 (the Go compiler)
shipped 2026-07-08 with no programmatic API; a new one is expected in 7.1,
and Microsoft publishes `@typescript/typescript6` so API consumers can keep
a TS 6 side by side
([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)).
Every type-aware tool below is therefore on TS 6 or on a separate `tsgo`
binary.

- **ts-morph** (MIT, 28.0.0 on 2026-04-12, already our dependency at
  `^26`). Wraps the TypeScript compiler and language service: full types,
  `findReferences`, project-wide `rename`, `SourceFile.move` that rewrites
  relative specifiers, and the service refactors (`organizeImports`,
  `getEditsForRefactor`, `getCombinedCodeFix`)
  ([references](https://ts-morph.com/navigation/finding-references),
  [renaming](https://ts-morph.com/manipulation/renaming),
  [source files](https://ts-morph.com/details/source-files)). Edits stay in
  memory until `project.save()`, per file, with no cross-file atomic commit
  ([manipulation](https://ts-morph.com/manipulation/)). Since 0.29
  `@ts-morph/common` bundles its own compiler (TS 6.0.2 in the probe), so
  it keeps working beside a `typescript@7` install. The maintainer reports
  a native TS 7 backend in progress, unreleased
  ([issue 1621](https://github.com/dsherret/ts-morph/issues/1621)). Known
  costs: every manipulation re-parses the file, so analyze first and batch
  ([performance](https://ts-morph.com/manipulation/performance)); a
  `Project` leaks without `dispose()` until
  [PR 1681](https://github.com/dsherret/ts-morph/pull/1681) lands; `move`
  with `paths` aliases is an open PR since 2024
  ([PR 1495](https://github.com/dsherret/ts-morph/pull/1495)). Imperative
  only; nothing declarative. Runs on Bun. **The only tool with types.**
- **ast-grep** (MIT, 0.45.3 on 2026-08-31, releases every few weeks).
  Tree-sitter, TypeScript built in. Rules are YAML data: `pattern`, `kind`,
  `regex`, relational `inside`/`has`/`follows`/`precedes`, composite
  `all`/`any`/`not`/`matches`, reusable `utils`, `transform` on captured
  variables, and a `fix` template
  ([rule config](https://ast-grep.github.io/guide/rule-config.html),
  [utils](https://ast-grep.github.io/guide/rule-config/utility-rule.html),
  [transform](https://ast-grep.github.io/reference/yaml/transformation.html)).
  No types, scope, or data flow, by design
  ([FAQ](https://ast-grep.github.io/advanced/faq.html)). The CLI writes
  only with `-U` or per-match `-i`; the napi package gives
  `findAll`, `replace`, `commitEdits` in-process, but does not interpolate
  metavariables in `replace`, so YAML `fix` templates must be rendered by
  our code when run in-process
  ([JS API](https://ast-grep.github.io/guide/api-usage/js-api.html)).
  Both the napi package and the CLI ran on Bun in the probe. **The best
  declarative rule language; blind to types.**
- **Codemod CLI and jssg** (Apache-2.0, `codemod` 1.18.3 on 2026-09-11,
  formerly Intuita). A Rust binary with a `workflow.yaml` engine (DAG,
  matrix fan-out, manual approval gates, persisted state) and a registry
  ([workflows](https://docs.codemod.com/community/workflows/reference)).
  jssg transforms are TypeScript over ast-grep bindings, run in a QuickJS
  sandbox with a deny-by-default file and network policy; secondary-file
  edits are collected and applied with the primary file's
  ([jssg reference](https://docs.codemod.com/community/jssg/reference.md),
  [security](https://docs.codemod.com/community/jssg/security.md)).
  `definition()` and `references()` are symbol resolution through oxc,
  not a type checker. Because transforms run in QuickJS they cannot import
  ts-morph; a type-gated step would be a shell step. The CLI ran under
  `bunx`. **Orchestration and distribution, not a type gate.**
- **Biome GritQL plugins** (MIT or Apache-2.0, 2.5.15 on 2026-09-30,
  already our linter through Ultracite). Biome 2.5 applies plugin rewrites
  with `--write` (`=>` in the pattern, `fix_kind = "safe"` or unsafe), one
  rewrite per diagnostic, single file, no types for plugins
  ([plugins](https://biomejs.dev/linter/plugins/),
  [2.5 release](https://biomejs.dev/blog/biome-v2-5/)). GritQL has no
  `utils` or `transform` composition. **Zero new dependencies for a
  trivial lint-with-fix rule; nothing more.**
- **jscodeshift and recast** (MIT, 17.4.0 on 2026-07-15 and 0.24.0 on
  2026-08-10). Babel parser, imperative, no types. Alive again after a
  long pause, but Codemod.com now positions jssg as its successor
  ([jssg](https://codemod.com/blog/jssg)). Nothing ts-morph does not
  already give us.
- **typescript-eslint custom rules.** `getParserServices` exposes the
  program and `getTypeAtLocation`; fixes go through `context.report`
  ([custom rules](https://typescript-eslint.io/developers/custom-rules/)).
  Type-aware rule plus fix, but a second lint stack beside Biome.
- **oxlint JS plugins** (MIT, 1.87.0 on 2026-10-05). Alpha, ESLint-shaped,
  with fixes; custom rules cannot see types, and the built-in type-aware
  rules need TS 7 through `tsgolint`
  ([plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html),
  [type-aware](https://oxc.rs/docs/guide/usage/linter/type-aware.html)).
- **Knip** (ISC, already our `dead-code` task). `--fix` removes unused
  exports and dependencies in place, with `--fix-type` and
  `--allow-remove-files` ([auto-fix](https://knip.dev/features/auto-fix)).
  Module-graph aware for its fixed set of edits; not a framework, but a
  precedent for "remove-export" that users already trust.
- **Not worth more time.** Putout (Babel, one maintainer), magicast
  (config files), Comby (last release 2022), Semgrep CE (security
  oriented, no types in CE, LGPL), Grit's standalone CLI (dormant since
  Honeycomb acquired Grit; the language lives on inside Biome), Hypermod
  (jscodeshift wrapper, quiet), and Sourcegraph Batch Changes (needs a
  Sourcegraph instance).

| Tool | Substrate | Authoring | Types and references | Preview | Bun | License |
| --- | --- | --- | --- | --- | --- | --- |
| ts-morph 28 | TS compiler, bundled 6.0.2 | imperative | full | in memory until `save()` | yes | MIT |
| ast-grep 0.45 | tree-sitter | YAML rules, napi | none | `-i`, `-U`, or in-process | yes | MIT |
| Codemod CLI 1.18, jssg | ast-grep, oxc symbols | TS in QuickJS, YAML workflow | symbols, no types | `--dry-run` | CLI yes | Apache-2.0 |
| Biome 2.5 plugins | Biome CST, GritQL | GritQL | none | `--write` | binary | MIT or Apache-2.0 |
| jscodeshift 17 | Babel, recast | imperative | none | `--dry` | yes | MIT |
| typescript-eslint rule | TS 6 program | rule and fixer | full | `--fix` | yes | MIT |
| oxlint 1.87 plugin | oxc | ESLint rule API | none for plugins | `--fix` | Node for plugins | MIT |
| Knip 6 | TS module graph | fixed set | module graph | none, in place | yes | ISC |

## Opinion: how to build it

- **Keep the lifecycle, widen the registry.** The `apply.ts` sequence
  (fresh analysis, revalidate, dirty-tree block, edit, write on request,
  verify, restore) is the contract every codemod runs under. New codemods
  are new entries in `DEFAULT_MUTATION_CAPABILITIES` backed by a mutator
  for that kind and form, in that order, as the registry's comment already
  says.
- **A plan is executable only when a rule authorizes it.** Readiness
  gains one more input: the workspace's rules. A plan goes `authorized`
  only when a rule permits that operator kind on that subject and every
  planned transformation's form is in the registry. Without a matching
  rule the answer is `not-authorized`, the same word the gate already
  uses for anything required and missing.
- **ts-morph for anything that needs references.** Most transformation
  kinds in the plan schema (`move-symbol`, `move-module`, `rewrite-import`,
  `rewrite-reexport`, `update-test-import`) depend on knowing who imports
  what across packages. That is the compiler's job, and Atlas already pays
  for the project. The manifest edits (`update-package-export`,
  `update-package-dependency`) and module creation or deletion do not need
  it.
- **ast-grep for the declarative layer, under the registry, not beside
  it.** The registry stays the one place that says what Atlas can change.
  Where a kind and form is a pure syntax rewrite, an ast-grep YAML rule run
  in-process through `@ast-grep/napi` against the ts-morph source text is
  the cheapest way to implement that entry: match, map the range to a
  ts-morph node, let ts-morph decide the type-dependent part, then edit.
  Our code renders the `fix` template, since the napi `replace` does not.
  Never a second path to the file system, and never adopted before a
  second executable kind needs it.
- **Codemod CLI only if we want its orchestration.** Workflow DAGs,
  approval gates, and a registry are real, but jssg cannot import
  ts-morph, so every type-gated step would be a shell step calling Atlas.
  Nothing today needs that layer.
- **Pin ts-morph's costs.** Analyze first and batch edits; dispose the
  project between runs once the fix lands; treat `SourceFile.move` with
  `paths` aliases as unverified until `move-module` is executable.
- **Expose it in the CLI last.** `atlas apply <plan>` previews by default
  and writes with `--write`, mirroring the library. It ships only once a
  rule can be declared in `foundry.config.json` and the readiness gate
  reads it.

## Open questions

- **Rule shape.** What a rule must carry for the gate to consume it:
  at least an operator kind, a subject selector (package, symbol, concept,
  boundary), and whether it permits or requires. Whether a rule may also
  name forbidden edits (a `preserve-*` operator in rule form) decides
  whether preservation stays plan-local or becomes workspace policy.
- **Where rules live.** `foundry.config.json` already carries
  `semantics`; a `rules` key beside it is the obvious home. Package-level
  rules, which the roadmap names, need a precedence story against
  workspace-level ones.
- **Verification per kind.** `verifyInternalizeExport` is bespoke. Each
  new executable kind needs its own structural checks, or a general
  "predicted delta equals observed delta" check must be proven sufficient.
- **Batching.** Today one plan runs at a time. A rule that is violated in
  many places wants to apply many plans, which raises ordering, shared
  files, and one rollback across all of them.
