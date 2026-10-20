# @foundry/eslint-plugin

ESLint and Oxlint rules that check what a prompt references, through
`@foundry/prompts`. A rule finds the prompts in a file, hands their text to
the package, and reports each finding where it was written. The notations
live in the package; this plugin only says which nodes hold a prompt.

| Node | Read as |
| --- | --- |
| `` x.claude`…` ``, `x.claude("…")` | Claude Code |
| `` x.codex`…` ``, `x.codex("…")` | Codex |
| `` x.pi`…` ``, `x.pi("…")` | Pi |

Any object works before the member, so `mine.claude` from `assemble` is
checked too. A call counts when its one argument is a string literal or a
template literal without substitutions. A `${}` inside a tagged template is
a hole: nothing is reported across it.

## Rules

One rule per diagnostic code, so each has its own severity.

| Rule | Reports | Needs names? |
| --- | --- | --- |
| `no-unresolved-reference` | A skill or agent nothing configured has; a command or variable the harness does not know. | For skills and agents |
| `no-foreign-notation` | A skill or agent the host has, written in another harness's notation: `$review` in a Claude Code prompt. | Yes |
| `no-template-only` | `$ARGUMENTS`, `${CLAUDE_SKILL_DIR}`, `` !`cmd` `` and the like in a message, where they are sent as literal text. | No |
| `no-consumed-by-harness` | A message the harness handles itself, such as `/clear` or `!git status`, so the model never receives it. | No |

`misread-reference` and `unsupported-reference` concern values interpolated
with `${}`; a static rule sees a hole there, so no rule reports them.

## Settings

Shared by every rule under `settings.foundryPrompts`. All optional.

```jsonc
{
  "dialects": { "house": "claude" }, // extra member names, each a stock dialect
  "skills": ["code-review", ".claude/skills"], // names, or directories to list
  "agents": [".claude/agents"],
  "surface": "message" // or "template"
}
```

A list entry is a directory when it is written as a path: it contains a
slash or starts with a dot. A skills directory contributes its
subdirectory names (`.claude/skills/<name>/SKILL.md`); an agents directory
contributes its `.md` file names (`.claude/agents/<name>.md`). Directories
are relative to the linter's working directory and are listed with one
`readdir`, cached for two seconds. Nothing is discovered beyond what is
listed. With neither `skills` nor `agents` set, no skill or agent is ever
questioned, and `no-foreign-notation` never fires.

## ESLint

```js
// eslint.config.js
import tsParser from "@typescript-eslint/parser";
import foundryPrompts from "@foundry/eslint-plugin";

export default [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
    ...foundryPrompts.configs.recommended,
    settings: {
      foundryPrompts: { skills: [".claude/skills"], agents: [".claude/agents"] },
    },
  },
];
```

`configs.recommended` turns every rule on: errors as errors, warnings as
warnings. Register the plugin yourself to pick the rules:

```js
{ plugins: { "foundry-prompts": foundryPrompts }, rules: { "foundry-prompts/no-template-only": "warn" } }
```

## Oxlint

The rules are written with Oxlint's `createOnce` API and wrapped in
`eslintCompatPlugin`, so the same file loads as a `jsPlugins` entry.
Oxlint's JS plugins are alpha; the tests run `oxlint` over the fixtures to
prove the plugin loads there.

```jsonc
// .oxlintrc.json
{
  "jsPlugins": ["@foundry/eslint-plugin"],
  "rules": {
    "foundry-prompts/no-unresolved-reference": "error",
    "foundry-prompts/no-foreign-notation": "error",
    "foundry-prompts/no-template-only": "warn",
    "foundry-prompts/no-consumed-by-harness": "warn"
  },
  "settings": { "foundryPrompts": { "skills": [".claude/skills"] } }
}
```

## Editor

Squiggles come from the ESLint or Oxc VS Code extension reading the same
config; `tooling/vscode-extension` adds colour only.

## Develop

`bun run build` writes `dist/index.js`, one bundle with `@foundry/prompts`
inside and `@oxlint/plugins` outside, plus declarations. Node loads it;
the workspace's `.ts` sources it cannot. Tests live in `src/test/`:
ESLint's `RuleTester` over `tooling/vscode-extension/fixtures`, and
`oxlint` over the same files through the built bundle, asserting both
linters report the same findings.
