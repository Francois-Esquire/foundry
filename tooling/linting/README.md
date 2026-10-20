# @foundry/linting

Foundry's own lint rules, for ESLint, Oxlint, and Biome. One package, one
place to add a rule for anything in Foundry. Rules are grouped by domain;
today the only domain is **prompts**: what a prompt references, checked
through `@foundry/prompts`.

| Host | Artifact | Rule id |
| --- | --- | --- |
| ESLint | `dist/index.js`, a plugin | `foundry/prompts/<code>` |
| Oxlint | the same file, as a `jsPlugins` entry | `foundry/prompts/<code>` |
| Biome | `biome/prompts-*.grit`, generated GritQL | named in the message |

The ESLint and Oxlint half is one plugin: rules written with Oxlint's
`createOnce` API and wrapped in `eslintCompatPlugin`, which adds the
`create` method ESLint calls. The Biome half is generated regex, since Biome
plugins are GritQL and cannot call the package. It covers the two checks
that need no list of names; see below.

## Prompts

A rule finds the prompts in a file and hands their text to
`@foundry/prompts`. The notations live in the package; this plugin only
says which nodes hold a prompt.

| Node | Read as |
| --- | --- |
| `` x.claude`…` ``, `x.claude("…")` | Claude Code |
| `` x.codex`…` ``, `x.codex("…")` | Codex |
| `` x.pi`…` ``, `x.pi("…")` | Pi |

Any object works before the member, so `mine.claude` from `assemble` is
checked too. A call counts when its one argument is a string literal or a
template literal without substitutions. A `${}` inside a tagged template is
a hole: nothing is reported across it.

One rule per diagnostic code, named after the code, so each has its own
severity.

| Rule | Reports | Needs names? |
| --- | --- | --- |
| `foundry/prompts/unresolved-reference` | A skill or agent nothing configured has; a command or variable the harness does not know. | For skills and agents |
| `foundry/prompts/foreign-notation` | A skill or agent the host has, written in another harness's notation: `$review` in a Claude Code prompt. | Yes |
| `foundry/prompts/template-only` | `$ARGUMENTS`, `${CLAUDE_SKILL_DIR}`, `` !`cmd` `` and the like in a message, where they are sent as literal text. | No |
| `foundry/prompts/consumed-by-harness` | A message the harness handles itself, such as `/clear` or `!git status`, so the model never receives it. | No |

`misread-reference` and `unsupported-reference` concern values interpolated
with `${}`; a static rule sees a hole there, so no rule reports them.

### Settings

Shared by every prompts rule under `settings.foundry.prompts`. All optional.

```jsonc
{
  "foundry": {
    "prompts": {
      "dialects": { "house": "claude" }, // extra member names, each a stock dialect
      "skills": ["code-review", ".claude/skills"], // names, or directories to list
      "agents": [".claude/agents"],
      "surface": "message" // or "template"
    }
  }
}
```

A list entry is a directory when it is written as a path: it contains a
slash or starts with a dot. A skills directory contributes its
subdirectory names (`.claude/skills/<name>/SKILL.md`); an agents directory
contributes its `.md` file names (`.claude/agents/<name>.md`). Directories
are relative to the linter's working directory and are listed with one
`readdir`, cached for two seconds. Nothing is discovered beyond what is
listed. With neither `skills` nor `agents` set, no skill or agent is ever
questioned, and `foreign-notation` never fires.

## ESLint

```js
// eslint.config.js
import tsParser from "@typescript-eslint/parser";
import foundry from "@foundry/linting";

export default [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
    ...foundry.configs.recommended,
    settings: {
      foundry: {
        prompts: { skills: [".claude/skills"], agents: [".claude/agents"] },
      },
    },
  },
];
```

`configs.recommended` turns every rule on: errors as errors, warnings as
warnings. Register the plugin yourself to pick the rules:

```js
{ plugins: { foundry }, rules: { "foundry/prompts/template-only": "warn" } }
```

## Oxlint

The same file loads as a `jsPlugins` entry. Oxlint's JS plugins are alpha;
the tests run `oxlint` over the fixtures to prove the plugin loads there.

```jsonc
// .oxlintrc.json
{
  "jsPlugins": ["@foundry/linting"],
  "rules": {
    "foundry/prompts/unresolved-reference": "error",
    "foundry/prompts/foreign-notation": "error",
    "foundry/prompts/template-only": "warn",
    "foundry/prompts/consumed-by-harness": "warn"
  },
  "settings": { "foundry": { "prompts": { "skills": [".claude/skills"] } } }
}
```

## Biome

Biome plugins are GritQL only, so `biome/*.grit` mirrors the notations as
regex, generated from `src/prompts/grit.ts` by `bun run grit`. The tests
fail when the committed files drift, and they run `biome lint` over the
fixtures to check that it reports where ESLint reports.

```jsonc
// biome.jsonc
{
  "plugins": [
    "./node_modules/@foundry/linting/biome/prompts-consumed-by-harness.grit",
    "./node_modules/@foundry/linting/biome/prompts-template-only.grit"
  ]
}
```

What Biome cannot do shapes what it checks:

- **Two checks only.** `template-only` and `consumed-by-harness` need no
  list of names. The other two would need names baked into the file at
  generation time, so they are left to ESLint and Oxlint.
- **No settings.** Only the stock member names are read, always as a
  message. There is no `dialects`, `skills`, `agents`, or `surface`.
- **The whole prompt is underlined.** A GritQL regex matches a node's
  whole text, so the finding spans the tagged template or the argument,
  and there is one per prompt, not one per reference. The rule name is at
  the end of the message, since every plugin finding is in Biome's
  `plugin` category; suppress one with `biome-ignore lint/plugin`.
- **Severity is fixed** at `warn`, in the file.
- **A call's template argument is read as written**, substitutions
  included, where the other hosts skip a template with substitutions.
- **No Markdown.** Biome cannot parse `.md` yet
  ([biome#3718](https://github.com/biomejs/biome/issues/3718)), so
  `SKILL.md` and agent files wait for that parser in every host.

This repository runs the rules on itself through `biome.jsonc`; the
extension's fixtures are excluded, since they hold every notation on
purpose.

## Develop

`bun run build` writes `dist/index.js`, one bundle with `@foundry/prompts`
inside and `@oxlint/plugins` outside, plus declarations. Node loads it;
the workspace's `.ts` sources it cannot. `bun run grit` rewrites
`biome/`. Tests live in `src/test/`: ESLint's `RuleTester` over
`tooling/vscode-extension/fixtures`, the `oxlint` binary over the same
files through the bundle, and the `biome` binary over them through the
generated rules.

To add a domain, put its rules under `src/<domain>/`, register them in
`src/index.ts` as `<domain>/<rule>`, read its settings from
`settings.foundry.<domain>`, and add a `.grit` to the generator if Biome
can express the check.
