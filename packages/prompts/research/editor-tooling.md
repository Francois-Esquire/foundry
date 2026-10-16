# Editor tooling and linting for prompts: research

Research notes as of 2026-10-16. No code yet. Covers a VS Code extension (highlighting, diagnostics, hovers and more) and linting for `@foundry/prompts`. Items marked **[unverified]** were not confirmed against a primary source.

## What already exists

`@foundry/prompts` was built to be bundled into an editor. It has no Node imports and exports:

- `new Parser(dialect).tokenize(text)`: contiguous tokens, each with a `kind` and a `span`.
- `HIGHLIGHT_SCOPES`: the TextMate scope for each token kind.
- `parser.tokenizeTemplate(chunks)`: reads a template literal statically, with a zero-width `hole` for each `${}`.
- `cookedToRaw(rawChunk)`: maps cooked offsets back to source offsets through escapes.
- Six fixed diagnostic codes, each with a severity: `unresolved-reference`, `foreign-notation`, `misread-reference`, `template-only`, `consumed-by-harness` and `unsupported-reference`.
- `Dialect` values (`claudeCode`, `codex`, `pi`) that carry their notations, sigils and built-in name lists.

These pieces do not exist yet:

- **Extraction**: finding prompt bodies inside TS source and markdown files.
- **A filesystem-backed `PromptSource`**: skills from SKILL.md directories, agents, workspace files. `createCatalog` in `packages/agents/src/prompts.ts` only wraps registries held in memory.
- **Real usage to test against**: outside the package, only `packages/agents` touches it, through `createCatalog` and one test. No `prompts.claude` tags exist in app code.

Prompts appear in two places:

1. **TS tagged templates and calls**: `prompts.claude\`…\``, `prompts.codex("…")`, `prompts.pi`, and custom tags from `assemble({ dialects: { custom } })` such as `mine.custom`.
2. **Markdown template files**: SKILL.md, `.claude/commands/*.md`, Codex custom prompts and Pi prompt templates. All are markdown with frontmatter.

## Platform facts that shape the design

### TypeScript 7 ended tsserver plugins

- TS 7.0 shipped on 2026-07-08 as a native Go port, and it "does not ship with an API". 7.1 is expected to bring a different one. Source: <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>
- With TS 7 enabled, VS Code warns that `typescriptServerPlugins` "will not be loaded". Source: <https://github.com/microsoft/TypeScript/issues/64356>
- VS Code PR #335369, merged 2026-09-16, prompts users without plugins to switch to TS 7. Source: <https://github.com/microsoft/vscode/pull/335369>
- TS 7's replacement is "content mappers", which handle whole-file languages such as `.vue`, not templates embedded in `.ts`. Sources: <https://github.com/microsoft/typescript-go/pull/4712>, <https://github.com/microsoft/TypeScript/issues/63875>
- `typescript-template-language-service-decorator` is archived; its last release was 2.3.2 in 2023. `microsoft/typescript-styled-plugin` is archived and deprecated. lit-analyzer has open TS 7 issues #396 and #399.
- In this repo, `.vscode/settings.json` sets `js/ts.tsdk.path` to the workspace TS 6, so a plugin *would* load here today. It would still be a dead end anywhere else and in the editor's default setup.
- `typescript@latest` on npm is 7.0.2, and its main export is only `lib/version.cjs`. Anything that parses TS in JS must pin `typescript@^6` or alias `@typescript/typescript6`.

### VS Code gives Claude markdown files their own language IDs

The built-in `prompt-basics` extension assigns them. Sources: <https://github.com/microsoft/vscode/blob/main/extensions/prompt-basics/package.json>, `src/vs/workbench/contrib/chat/common/promptSyntax/promptTypes.ts`

| Files | Language id |
| --- | --- |
| `SKILL.md` | `skill` |
| `**/.claude/agents/*.md` | `chatagent` |
| `**/.claude/rules/**/*.md` | `instructions` |
| `*.prompt.md` | `prompt` |
| `.claude/commands/*.md` | still `markdown` |

- These languages use the root scope `text.html.markdown.prompt`. vscode-textmate collects injections only for the root scope (`_collectInjections` in vscode-textmate `grammar.ts`).
- So `injectTo` must list both `text.html.markdown` and `text.html.markdown.prompt`, and every `DocumentSelector` must list `markdown`, `skill`, `chatagent`, `instructions` and `prompt`.
- VS Code's own prompt-file semantic tokens are turned off when a file targets Claude. No existing extension highlights Claude skills or slash commands; the official `Anthropic.claude-code` extension only adds a settings JSON schema.

### VS Code's merge rules

- **Semantic tokens do not merge.** "The best-matching provider is used" (vscode.d.ts). Registering a provider for `typescript` would replace TS's own semantic highlighting for the whole file, so don't use semantic tokens in `.ts` files. They are fine for the markdown languages.
- **Hover, definition, completion, code actions and document links do merge.** Providers run in parallel and their results combine, so they can sit alongside TS.
- **TS registers only a *range* semantic-token provider.** An extension's range provider with the same score goes first. It suppresses TS's tokens when it returns tokens, and falls back to TS when it returns nothing (`languageFeatureRegistry.ts`, `getSemanticTokens.ts`). That is still too fragile to rely on.
- **Use decorations instead:** `createTextEditorDecorationType` plus `setDecorations`. They must be reapplied whenever the visible editors or the document change.
- **Markdown preview, links and the markdown language server** are hard-coded to `markdown`, `prompt`, `instructions`, `chatagent` and `skill` (`markdown-language-features/src/util/file.ts`). A new language id would lose all of them, so don't add one.
- **Language matching order:**
  1. User `files.associations`.
  2. Exact filename.
  3. Longest pattern; patterns containing `/` match the full path.
  4. File extension.

  So `**/.claude/commands/*.md` works if it is ever needed.

### Injection grammar details (verified against the TypeScript-TmLanguage and vscode-textmate sources)

- **Selector:** `"injectionSelector": "L:source.ts -comment -(string -meta.embedded)"`. A bare `-string` would also switch the injection off inside `${}`, because `string.template.ts` stays on the stack there. lit-html uses this exact selector.
- **Where the begin rule matches:**
  - Matching at `prompts` takes over the tag's colour.
  - A lookbehind `(?<=prompts\.claude)\s*(\`)` keeps TS's `template-call` colouring of the tag.
  - `L:` wins the tie either way.
- **Multi-line limits:** the tag and the opening backtick must be on the same line. Once `begin` has matched, the template body can run over many lines.
- **Root grammars:** list every one in `injectTo`: `source.ts`, `source.tsx`, `source.js` and `source.js.jsx`.
- **Call form** `prompts.codex("…")`: a quote rule ending at `\1`. Not yet tested.

### Biome 2.5.x: what it can and cannot do

Verified by running Biome 2.5.12 in a scratch directory.

**Biome can:**
- Match the tag with `JsTemplateExpression(tag=$tag, elements=$els)` where `$tag <: \`prompts.claude\``.
- Match the call form with `` `prompts.$d($s)` ``.
- Regex-match a chunk's text.
- Report a diagnostic with a safe fix.
- Read `$filename`.
- Output `--reporter=github|sarif`.

**Biome cannot:**
- Narrow a span below a whole template chunk.
- Match more than once per chunk.
- Run JS: `function … js {}` does not compile.
- Read the filesystem or use type info.
- Lint markdown: plugins target only JS, CSS and JSON.

Using GritQL would mean rewriting the dialect grammar as regex, and it misfires. Example: `@src/auth` was flagged as `Unknown skill /auth`.

**Other Biome notes:**
- **JS plugins**: merged to main and run in the Boa engine, but not compiled into release builds (`js_plugin` feature off). They probably have no Node APIs **[unverified]**. Source: <https://github.com/biomejs/biome/issues/11420>
- **Plugin fixes as editor code actions** arrived in 2.5.14; the repo is on 2.5.12. Source: <https://github.com/biomejs/biome/releases/tag/%40biomejs%2Fbiome%402.5.14>
- **2.5.x gotcha**: plugin `includes` globs match absolute paths, so use `**/packages/...`.
- **Markdown**: lint and format support is pending in a changeset. GritQL markdown targets are **[unverified]**.

**Verdict:** Biome cannot host the real check. At most, a GritQL rule can catch a purely syntactic case.

### Linters that can run our JS

- **oxlint JS plugins** (ESLint-compatible API, oxlint 1.88.0):
  - Verified: they run under Node with `node:fs`, report exact spans, `--fix` works, and `-f github|sarif` works.
  - `"categories": {"correctness":"off"}` makes oxlint run only our rule, so Biome stays the primary linter.
  - Limits: "alpha", and no type-aware rules. Source: <https://oxc.rs/docs/guide/usage/linter/js-plugins.html>
  - Blocker: Node cannot import our TS source because the imports have no extensions, so the plugin needs a bundle step.
- **ESLint with typescript-eslint**: the only type-aware route. It costs a second, slow linter plus TS 6 kept alongside TS 7.
- **Standalone CLI**: parses with the TS 6 API or `oxc-parser` and outputs github or SARIF. A `problemMatcher` puts results in the Problems panel, though not live as you type.
- **markdownlint custom rules**: give live squiggles in `.md` files and support `fixInfo`. The VS Code extension blocks custom-rule JS in untrusted workspaces. Source: <https://github.com/DavidAnson/markdownlint/blob/main/doc/CustomRules.md>

## Offset mapping (how others do it)

Two corrections are both required:

1. ESTree and TS chunk ranges include the opening backtick or `}`.
2. Spans into the cooked text need `cookedToRaw`.

Prior art:

- **lit-analyzer** swaps each substitution for a placeholder of the same length (`virtual-ast-document.ts`).
- **graphql-eslint** extracts virtual files and shifts locations back in `postprocess`, turning fixes off where a location is unreliable.
- **SafeQL** finds custom tags from configured tag and wrapper globs or regexes. That is a model for `assemble(...)` tags without type info.

## Prior art to copy

| Source | What to take |
| --- | --- |
| runem/lit-analyzer: `syntaxes/vscode-lit-html/lit-html.json` | Tag regex `(\b(?:\w+\.)*(?:html\|raw)\s*)(\`)`, which handles member-expression tags. Also the separate `${}` string-injection grammar. |
| graphql/graphiql: `packages/vscode-graphql-syntax` | `grammars/graphql.js.json` (split between call and tag forms). The markdown code-block injection. `tests/__utilities__/utilities.ts`: grammar snapshot tests with vscode-textmate and vscode-oniguruma under vitest. |
| microsoft/vscode: `contrib/chat/common/promptSyntax/` | The semantic-token provider pattern for prompt files, and the frontmatter validator structure (`promptValidator.ts`, `validateClaudeAttributes`). |
| frigus02/vscode-sql-tagged-template-literals | Grammar handling for `obj?.tag<T>` and `tag('x')`. The split between a syntax-only extension and a plugin extension. |
| styled-components/vscode-styled-components `package.json` | `injectTo` combined with `embeddedLanguages: {"meta.embedded.line.ts": "typescript"}`. |

Resolved: `source.ts#template-substitution-element` is the right include for `${}` inside an injected grammar. Both lit-analyzer and es6-string-html use it.

## Candidate architecture

```
@foundry/prompts            (exists) dialects, Parser, check, cookedToRaw; Node-free
        │
  extraction layer          (new) find prompt bodies:
        │                   TS source → tags/calls → chunks → tokens/diagnostics at raw offsets
        │                   markdown → strip frontmatter → body
        │                   plus a filesystem-backed PromptSource (skills, agents, files)
        │
  ┌─────┼──────────────┬──────────────────┐
VS Code ext        CLI `prompts check`   (optional) oxlint/ESLint rule
```

**VS Code extension:**
- One bundled CJS `extension.js`, with `vscode` external.
- An injection grammar for `prompts.(claude|codex|pi)` and the markdown languages, *generated from the `Dialect` objects* and `HIGHLIGHT_SCOPES` so the grammar and the parser cannot drift.
- Decorations for what a grammar cannot know: custom tags, and known versus unknown names.
- A DiagnosticCollection, hover, go to definition (`/skill` → SKILL.md), completion after a sigil, a quick fix for `foreign-notation` via `dialect.write(ref)`, and document links for `@path`.
- A FileSystemWatcher keeps the catalog current.

**CLI:** the same extraction core. Outputs github annotations or SARIF for CI and supports `--fix`.

## Dev loop and testing

- **Live editing:**
  - Press F5 to open an Extension Development Host, with `--extensionDevelopmentPath` set in `.vscode/launch.json`.
  - A watch build runs as the preLaunchTask.
  - `.gitignore` already allows committing `launch.json` and `tasks.json`.
  - The extension host is Electron's Node; Bun is only the build tool.
- **Module format: output CJS.**
  - ESM extensions need VS Code 1.100 or later.
  - Cursor was on 1.99.3 in late 2025.
  - vsce rejects an `@types/vscode` newer than `engines.vscode`, so pin the two together.
- **Bundler:**
  - `bun build --target node --format cjs --external vscode` should work. Bun calls `cjs` "experimental", and `--target bun` would emit a wrapper Node can't load.
  - The F5 preLaunchTask needs a background problem matcher. `$esbuild-watch` waits for `[watch] build started` and `[watch] build finished`, which `bun build --watch` probably doesn't print **[unverified]**. Use an esbuild script or write a custom matcher.
- **Versions:** `@vscode/test-electron` 3.1 and `@vscode/vsce` 4 need Node 22 or later. vsce knows only npm and yarn, so `--no-dependencies` with a bundle is required.
- **Test layers**, from fastest:
  1. Pure provider functions (text in, ranges out) under vitest.
  2. Grammar snapshot tests with vscode-textmate and oniguruma under vitest, run against the same fixtures as `Parser.tokenize`. Avoid `vscode-tmgrammar-test`: no release since 2024.
  3. A few smoke tests with `@vscode/test-cli` and `@vscode/test-electron`, kept out of the default `test` task.
- **Fixtures come first**: TS samples with tags in each dialect, custom tags, escapes and holes, plus SKILL.md and command samples. The grammar tests, the checker tests and the F5 dev host all share them.
- **Installing**: `@vscode/vsce package --no-dependencies`, then `code --install-extension x.vsix`. Open VSX (`ovsx`) is the route to publishing later.
- **Repo plumbing**:
  - Declare the bundle output in Turbo.
  - Add knip entry points for the extension `main`, the grammar generator and any lint plugin.
  - The bundler inlines `workspace:*` packages from source. `@foundry/core/agents` types resolve to `dist/`, so typecheck needs core's build.

## Unverified

| Status | Item |
| --- | --- |
| Open | Whether VS Code 1.142 (2026-10-14) ships TS 7 as the default. |
| Open | Whether `bun build --target node --format cjs --external vscode` produces a working extension bundle. esbuild is the documented route. |
| Open | Whether the oxc language server shows JS-plugin diagnostics and fixes in VS Code. |
| Open | Whether the Biome VS Code extension shows GritQL plugin diagnostics. Implied by the 2.5.14 fix. |
| Open | Whether `cursor --install-extension` accepts the same vsix. |
| Open | Whether `oxc-parser`, a native napi module, can be bundled into an extension host at all. TS 6, being pure JS, can. |
| Open | Which directories each harness scans for skills, agents and commands. Claude Code: `.claude/skills/`, `~/.claude/skills/`, plugin roots. Codex and Pi: not researched. |
| Resolved | `source.ts#template-substitution-element`: confirmed by lit-analyzer and es6-string-html. |

## Decisions to make before planning

1. **Where the extraction layer lives**
   - Option: a new package that depends on a TS parser.
   - Option: inside `@foundry/prompts`, which would add a parser dependency to a package that is deliberately lean and Node-free.
2. **TS parser**
   - `typescript@^6`: pure JS, bundles anywhere, around 8 MB.
   - `oxc-parser`: fast, but native.
3. **Location of the extension**
   - `tooling/`: dev tooling for this repo.
   - `apps/`: a shippable product.
4. **Live squiggles vs CI-only**
   - CI-only needs just the CLI.
   - Live squiggles need the extension, which is the plan anyway.
5. **Second linter**
   - Whether oxlint for one rule is acceptable in a Biome-first repo.
   - The alternative is the CLI plus the extension, with no lint plugin.
6. **Catalog source for static runs**
   - Scan the skill and agent directories on disk.
   - Or an explicit config file.
