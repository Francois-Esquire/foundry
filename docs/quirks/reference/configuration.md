---
title: Configuration
description: Where the config lives, how names register, module resolution, prebuilt steps, and the launch form.
---

The CLI looks for `./quirks.config.ts`, or the path passed to `--config`, and
imports it before every command except `help`. Calling one of the nine words
from `@foundry/quirks` registers what it describes; nothing is exported. A
valid empty config registers nothing and skips onboarding.

If the file is absent, interactive startup offers three starters: Developer
(`codeReview`), Design (`prototype`), and Product (`summarizeCodebase`). Each
writes a one-call config that registers one prebuilt step. Setup writes the
file only when Create is activated and refuses to overwrite an existing one.
Skipping setup opens an empty dashboard. Piped commands run with an empty
registry when the config is absent.

## The workspace

The directory that contains the config is the workspace, whatever the
shell's working directory was. Every agent session and sandbox runs there,
`workspaces.current` is it, relative paths in `workspace({ path })` and in
`report` media resolve from it, and its state lives under
`~/.foundry/quirks/<workspace-id>`. Put the config at the root of the project
the automation should work on. Without a config the working directory stands
in.

## Names and the catalog

A named step or workflow is the catalog: `list` prints it, `once <name>`
runs it, the dashboard launches it, and a schedule or monitor can target it.
A name is the builder's first argument, `step("review")`. A step or workflow
built without one takes the name of the top-level `const` it is assigned to,
read from the config's source with the project's own `typescript`, which is
an optional peer resolved from the config's location. Without `typescript`,
or when the definition is made inside a function or inline, it stays
internal: usable by reference, absent from `list`, and refused as a trigger
target with an error that says to name it.

A repeated name fails when the config loads. The error names the position of
each registration and says when one came from a `const`. Schedules and
monitors have no names; they are keyed by what they trigger and watch. See
[triggers](/quirks/reference/api#triggers).

Definitions such as `agent`, `workspace`, `sandbox`, `artifact`, and skill
sets are presets, not catalog entries. Only steps and workflows are launched.

## Package resolution

The CLI supplies `@foundry/quirks` and `@foundry/quirks/prebuilt` to the
config module itself, through a Bun loader plugin, so the config and the CLI
share one registry. Any other library the config imports, such as `zod`, must
resolve from the config's directory in the usual way. Install it in that
project.

`@foundry/quirks` is not on npm yet. Inside the Foundry repository run the
CLI with `bun run quirks -- --config <path> …`; elsewhere run the built
`apps/quirks/dist/cli.js` with Bun. For editor types, point the project's
TypeScript at the built package or the repository. Importing `@foundry/quirks`
outside the CLI registers definitions but binds no runtime; a step body run
that way fails with `the runtime is not bound; the CLI binds it`.

## Prebuilt steps

Import a factory from `@foundry/quirks/prebuilt` and call it to register the
one step you want. Importing the module alone registers nothing.

```ts
import { summarizeCodebase } from "@foundry/quirks/prebuilt";

summarizeCodebase({ name: "summarize-codebase" });
```

Each factory opens a read-only reviewing agent through the context, so the
working directory, cancellation, and streaming are already wired. Options are
`name`, extra `instructions` appended to the read-only prompt, `provider`
(`codex` or `claude-code`; omitted means the first installed CLI), and
`timeoutMs` for the turn, two minutes by default, with no retries.

| Factory | Input | Result |
| --- | --- | --- |
| `summarizeCodebase(options?)` | none | `{ provider, summary }`, an orientation for a product teammate |
| `codeReview(options?)` | none | `{ provider, text }`, at most five actionable findings |
| `prototype(options?)` | `{ brief }` | `{ provider, text }`, self-contained HTML/CSS in the reply; nothing is written to disk |
| `promptStep(name, prompt, options?, description?)` | none | `{ provider, text }` for a prompt of your own |
| `reviewInWorktree(options?)` | `{ repository, base? }` | A review of `base` (default `HEAD`) checked out in a temporary worktree of `repository` |
| `reviewSession(options?)` | `{ sessionId? }` | A review that continues the same conversation on every run (default id `code-review`) |

The default names are the factory names in kebab case. Composed examples
live in `apps/quirks/examples/` in the repository; load one with `--config`
or copy from it. They are not registered by the CLI.

## The launch form

Select a Catalog row and press `l`. A step without `.input(schema)` launches
at once. A step with one gets a form derived from the schema's JSON Schema:
a flat object of strings, numbers, booleans, and string enums becomes text,
multiline, number, boolean, and select fields, with labels, descriptions,
required flags, defaults, and numeric bounds carried over. `.describe(text)`
on the builder is shown above the form. Any other shape, or a schema library
without JSON Schema output, becomes one JSON field.

The factory parses the input at dispatch, once. A value the schema rejects
keeps the form open and shows the error; nothing is registered in the run
table. On acceptance the dashboard selects the new run and clears run
filters. Schedules and monitors keep running. Tab moves focus, Ctrl+Enter
submits, Esc returns without launching. Nested input that the form cannot
express is reachable with `quirks once <name> --input '<json>'`.
