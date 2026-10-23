---
title: Project structure and environment
description: Folder discovery, ignored files, workspace roots, setup, names, and module resolution.
---

Marbles loads modules from `.foundry/marbles/` under the current working
directory. There is no required entrypoint or configuration object. Calling
`step`, `workflow`, `schedule`, or `monitor` registers definitions and triggers
as modules load. Exports are optional and useful for sharing definitions.

Discovery is owned by the CLI; file operations inside a step use
[Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md).
The resolved project path also scopes local state and declared artifact
identity. Keep it stable to retain access to the same saved runs and artifacts. See
[Durability](/marbles/foundation/durability).

## Discovery and ignored files

Discovery walks subdirectories and imports JavaScript and TypeScript modules
in sorted path order: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and
`.cjs`. A module also imported by another module executes only once per process.
Names must be unique across the whole catalog.

A leading underscore excludes a file or directory from automatic discovery.
`_helpers.ts` is skipped; `_dashboard/` and everything inside it are skipped.
A trailing underscore has no special meaning. Ignored code can still be
imported normally, including any registrations or side effects it performs.
The convention controls discovery, not permissions or execution isolation.

Hidden entries, `node_modules`, TypeScript declaration files, and symlink
entries are also skipped. Other files, such as Markdown or images, are not
imported automatically. Put tests and micro apps under underscore directories
when their source must not load at startup.

```text
.foundry/marbles/
  review.ts                 automatically loaded
  releases/watch.ts         automatically loaded
  _shared/agents.ts         imported by other modules when needed
  _apps/dashboard/server.ts started explicitly by a step when needed
  _test/review.test.ts       loaded by your test runner
```

Keep top-level code to declarations. Start servers and other work in step
bodies, rather than during module import. Discovery runs when the
workspace's worker starts, and the worker restarts itself when anything
under the folder changes.

## Setup

Run `marbles init` from the project root. It writes one declaration under
`.foundry/marbles/`, creates parent directories, and refuses to overwrite an
existing file. It does not execute the step.

| Starter | Created file |
| --- | --- |
| `product`, the default | `summarize-codebase.ts` |
| `developer` | `code-review.ts` |
| `design` | `prototype.ts` |

Use `marbles init <starter>` to select one, including in an existing folder.

If the authoring folder is absent, interactive startup offers the same
Developer, Design, and Product starters with editable instructions, name,
and harness selection. It writes only when Create is activated. Skipping
setup opens an empty dashboard without creating the folder. An existing
empty folder registers nothing and skips setup. Piped commands use an empty
catalog when no source exists.

## The workspace

With `.foundry/marbles`, the workspace is the project directory above
`.foundry`, not the authoring directory. Agent sessions, sandbox workspaces,
`workspaces.current`, relative workspace paths, and report media use that
project root. State lives under `~/.foundry/marbles/<workspace-id>`.

`--source <path>` selects another directory or a single module. A custom
directory is itself the workspace; a single module uses its containing
directory. Selecting `.foundry/marbles` or a module inside it uses
the project root even when invoked from another working directory.

`--config` remains an alias for `--source`. When the default folder is absent,
an existing `./marbles.config.ts` still loads for compatibility. The folder
takes precedence when both exist. With no source, the working directory is
the workspace. `help` and `init` do not import authoring modules.

## Environment

Declare tokens and settings in a [Varlock](https://varlock.dev) `.env.schema`
at the workspace root. For example, on macOS this schema resolves a token
from the Keychain:

```sh
# .env.schema
# @defaultRequired=true
# ---
# @sensitive
FIGMA_TOKEN=exec(`security find-generic-password -s figma -w`)
```

The workspace's worker in the Marbles process, and `list`, load the schema
before importing authoring modules, using the workspace's own `varlock` or
one on `PATH`. Resolved values are added to the environment without
replacing values already set; a worker starts from the environment of the
Marbles process, not of the command that attached it. Marbles resolves
secrets each time a worker starts, so after every source reload, and does
not persist the loaded values. Without a schema, Marbles leaves the
environment as it is.

A value that does not resolve is a warning in the worker and in `list`:
what is missing is printed and loading continues; work that needs the value
can still fail. `roll --dry-run` and the MCP server under `--dry-run` stop
instead. `help`, `init`, `status`, `sessions`, `watch`, `daemon`, and `stop`
do not load the schema.

## Names and the catalog

A named step or workflow is a marble, and together they are the catalog:
`list` prints it, `roll <name>` runs one, the dashboard launches one from its
Marbles panel, and a schedule or monitor can target one.
Name launchable work explicitly with `step("review")` or `workflow("review", tree)`.

### Inferred names

A definition built without a name takes the top-level `const` it is assigned to,
read from the module's source with the project's own `typescript`, which is
an optional peer resolved from the module's location. Without `typescript`,
or when the definition is made inside a function or inline, it stays
internal: usable by reference, absent from `list`, and refused as a trigger
target with an error that says to name it.

A repeated name fails when the module loads. The error names the position of
each registration and says when one came from a `const`. Schedules and
monitors have no names; they are keyed by what they trigger and watch. See
[triggers](/marbles/reference/api#triggers).

Definitions such as `agent`, `workspace`, `sandbox`, `artifact`, and skill
sets are not catalog entries. Only steps and workflows are launched.

## Package resolution

The CLI supplies `@foundry.sh/marbles` and `@foundry.sh/marbles/prebuilt` to the
authoring module itself, through a Bun loader plugin, so the modules and the CLI
share one registry. Any other library the module imports, such as `zod`, must
resolve relative to the importing file in the usual way. Install it in that
project.

For CLI installation and editor types, see [Installation](/marbles/get-started/installation).
A plain script importing the package can use instance methods and `.run()`;
call `dispose()` when finished. A custom host can construct an `Engine` and
register definitions explicitly; see [Embedding the engine](/marbles/reference/engine).

## Prebuilt steps

Import a factory from `@foundry.sh/marbles/prebuilt` and call it to register the
one step you want. Importing the module alone registers nothing.

```ts
import { summarizeCodebase } from "@foundry.sh/marbles/prebuilt";

summarizeCodebase({ name: "summarize-codebase" });
```

Each factory opens a read-only reviewing agent through the context, so the
working directory, cancellation, and streaming are already wired. Options are
`name`, extra `instructions` appended to the read-only prompt, `provider`
(`codex`, `claude-code`, or `pi`; omitted means the first installed CLI), and
`timeoutMs` for the turn, two minutes by default, with no retries.

| Factory | Input | Result |
| --- | --- | --- |
| `summarizeCodebase(options?)` | none | `{ provider, summary }`, an orientation for a product teammate |
| `codeReview(options?)` | none | `{ provider, text }`, at most five actionable findings |
| `prototype(options?)` | `{ brief }` | `{ provider, text }`, self-contained HTML/CSS in the reply; nothing is written to disk |
| `promptStep(name, prompt, options?, description?)` | none | `{ provider, text }` for a prompt of your own |
| `reviewInWorktree(options?)` | `{ repository, base? }` | A review of `base` (default `HEAD`) checked out in a temporary worktree of `repository` |
| `reviewSession(options?)` | `{ sessionId? }` | A review that continues the same conversation on every run (default id `code-review`) |

Default names use the factory name in kebab case, such as `code-review`. Composed examples
live in `apps/marbles/examples/` in the repository; load one with `--source`
or copy from it. They are not registered by the CLI.

## The launch form

Select a row in Marbles and press `l`. A step without `.input(schema)` launches
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
express is reachable with `marbles roll <name> --input '<json>'`.
