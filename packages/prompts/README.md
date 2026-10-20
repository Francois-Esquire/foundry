# @foundry/prompts

Prompts written for a CLI harness. Each harness reads its own notation:
Claude Code invokes a skill as `/name`, Codex mentions one as `$name`, Pi
loads one as `/skill:name`. This package knows those grammars, extracts what
a prompt references in one harness-neutral vocabulary, checks the references
against what a host has, and writes a reference the way each harness reads
it. The glossary is `CONTEXT.md`.

No Node imports, so an editor extension and a renderer can both load it.
The generic reference vocabulary (`Reference`, `ReferenceKind`,
`ReferenceSource`, `Referenceable`, `REFERENCE`, and `referenceSource`, which
builds a source from a predicate per kind) is defined in
`@foundry/core/agents` beside the skill, agent, and MCP shapes. This package
extends it with the kinds only a prompt has (`PromptReference`,
`PromptSource`), so it and the agents package build on core rather than on
each other.

## Usage

`prompts` is one flat object: a tag per dialect, and the utilities that say
what exists, all at depth one.

```typescript
import { prompts, ref } from "@foundry/prompts";
import { createCatalog } from "@foundry/agents/prompts";

prompts.add(createCatalog({ skills, agents }));
prompts.add({ file: (path) => exists(path) });

const review = prompts.claude`Run /code-review on @src/auth and ask ${ref.agent("reviewer")}.`;
review.text;        // 'Run /code-review on @src/auth and ask @"reviewer (agent)".'
review.references;  // [{ kind: "skill", name: "code-review", span }, { kind: "file", path: "src/auth", span }, …]
review.diagnostics; // [] or [{ code: "unresolved-reference", message: 'Unknown agent "reviewer".', severity: "error", span }]
review.ok;          // true when no diagnostic is an error
String(review);     // the text, so it drops straight into agent({ prompt })

prompts.codex("use $review");              // from plain text
prompts.codex`Use ${ref.skill("review")}`; // "Use $review": one reference, each dialect's own notation
prompts.claude`First ${review}`;           // a prompt is inserted as its text, references and all
```

A value that knows what it refers to, such as a skill from `defineSkill`,
can be interpolated too; see "References by value" below.

A prompt's `diagnostics` and `ok` are read against what exists each time,
so a skill or agent added after the prompt was written resolves on the next
read. There is nothing to call afterwards.

### What exists

`add` layers in a source: listed names, predicates, or any `PromptSource`
(an object with `covers(kind)` and `has(kind, name)`). A reference resolves
when any layer has it; a kind is validated only when some layer covers it,
so with no `file` layer no path is ever questioned. Each dialect's built-in
commands and variables are its own layer, beneath the host's. A listed
iterable is read once; pass a predicate for a live source such as a
registry. `@foundry/agents/prompts` exports `createCatalog({ skills, agents })`,
a live layer over that package's registries, built with core's
`referenceSource`.

### References by value

A value can say what it refers to by implementing the reference protocol,
a well-known symbol. Interpolated into a tag it is written in the dialect's
notation, and its reference has origin `symbol` instead of `text`. A skill
from `defineSkill` already does this; a code-declared agent can too. The
point is static analysis: a tool resolves the identifier through the type
checker instead of looking a name up, so virtual skills and agents are
checkable without running anything.

```typescript
import { REFERENCE, type Referenceable } from "@foundry/prompts";

const reviewer: Referenceable<"agent"> = {
  [REFERENCE]: () => ({ kind: "agent", name: "reviewer" }),
};
prompts.claude`Ask ${reviewer}`; // 'Ask @"reviewer (agent)"'
```

### Strict

With `strict` on, a tag throws a `PromptError` instead of returning a
prompt that has errors. The error carries the prompt and its diagnostics.
Warnings never throw.

```typescript
prompts.strict = true;
prompts.claude`/nope`; // PromptError: Claude Code prompt has 1 error: Unknown skill "nope".
```

The out-of-the-box `prompts` is one object shared by every importer in the
process: its `strict` and its layers are process-wide. An application may
set them once at startup; a library should `assemble` its own instead of
changing the shared one.

### Assembling your own

Same shape, built from named dialects. The names become the keys. The
out-of-the-box `prompts` is this with `claude`, `codex`, and `pi`.

```typescript
import { assemble, claudeCode, codex, pi } from "@foundry/prompts";

const mine = assemble({
  dialects: { claude: claudeCode, codex, pi, custom },
  sources: [createCatalog({ skills, agents })],
  strict: true,
  surface: "message",
});
mine.custom`Use #review`;
```

`add`, `covers`, `has`, `remove`, `strict`, and `surface` are reserved
keys.

## Diagnostics

A closed set of codes. `unresolved-reference` is an error: no layer and no
built-in has the name. `foreign-notation` is an error: a skill or agent the
host has, written with another dialect's sigil, such as `$review` in a
Claude Code prompt; the message gives the right spelling.
`misread-reference` is an error: an interpolated reference the dialect
writes but reads back as something else, such as `ref.skill("review")`
opening a Claude Code message, where `/review` is the built-in command.
`template-only`, `consumed-by-harness`, and `unsupported-reference` are
warnings.

The surface defaults to `message`, what an agent turn sends. Assemble with
`surface: "template"` for `SKILL.md`, command files, and prompt templates,
where `$ARGUMENTS`, `${CLAUDE_SKILL_DIR}`, and `` !`cmd` `` are substituted.

A dialect that cannot write an interpolated reference (Codex has no agent
mention) writes the bare name and records a warning. So does one that
writes it where it does not read it: Pi's `/skill:name` only opens a
message, so interpolated mid-sentence it is plain text. The tag uses cooked
strings: write `\${CLAUDE_SKILL_DIR}` for a literal `${…}` and
`` !\`cmd\` `` for inline shell.

## Underneath

| Object | Nature | Job |
| --- | --- | --- |
| `prompts` | the host's | what exists, and the tags that author against it |
| `Prompt` | a value | text, references, and live diagnostics |
| `Dialect` | a value | one harness's grammar: notations in precedence order, built-ins, `write(ref)` |
| `Parser` | a service | text to tokens, for highlighting |

## Static analysis

`new Parser(dialect).tokenize(text)` returns contiguous tokens with a
`kind` and a `span`; `HIGHLIGHT_SCOPES` maps each kind to a TextMate scope.
That is all a semantic-tokens provider needs. A notation that matches only
known names, such as a built-in command, asks a source; pass one as the
second argument to recognize a host's `command` layer, as a tag does. A token that stands for a
reference also carries the `reference` and the id of the `notation` that
read it; an escape, a hole, or plain text carries neither, so
`"reference" in token` tells the two apart.

A tool reading source has the template's chunks, not its values.
`tokenizeTemplate(chunks)` keeps a zero-width `hole` token per
interpolation and never spans one, so a hole is reported as dynamic, never
as unknown. Spans are into the cooked text; `cookedToRaw(rawChunk)` maps
them back to source positions through escapes. `check(dialect, chunks,
{ sources?, surface? })` does the whole pass for a linter: it tokenizes the
chunks, reads them with the other stock dialects too, and returns the
diagnostics, with `sources` layered over the dialect's built-ins; nothing
configured means no skill or agent is questioned.
`@foundry/linting` is that function behind ESLint and Oxlint rules, and
mirrors the two name-free checks as GritQL for Biome.
What exists is whatever the tool can see: filesystem-backed sources for skills, agents, and files, plus
the type checker for references by value. Code-declared things referenced
by name stay uncovered statically and are caught by strict mode at runtime.

## Composing a dialect

A dialect is a list of notation builders; declared order is precedence.

```typescript
import { Dialect, notation } from "@foundry/prompts";

const custom = new Dialect({
  id: "custom",
  label: "Custom",
  notations: [
    notation.invocation({ id: "custom/skill", kind: "skill", sigil: "#" }),
    notation.mention({ id: "custom/file" }),
  ],
});
```

Builders: `invocation` (`<sigil><name> [args]`, kinds `skill`, `template`,
`command`, optionally only built-in names, optionally only at message
start), `mention` (`@path`), `agentMention` (`@"name (agent)"`),
`placeholder` (`$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$@`, `$NAME`, `$name`),
`variable` (`${NAME}`), `inlineShell` (`` !`cmd` ``), `shellLine` (`!cmd` as
the whole message), and `escape` (`$$`). The built-in command lists are
snapshots of each harness's `/` menu; a `command` layer extends them.

## Local checks

Tests live in `src/test/`. Run `bun run test` and `bun run typecheck` from
this package. Lint and formatting are owned by the repository root.
