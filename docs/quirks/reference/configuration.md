---
title: Configuration
description: Registration, module resolution, handles, and opt-in prebuilt steps.
---

The CLI looks for `./quirks.config.ts`, or the path passed to `--config`. It
imports an existing file before processing commands other than help. If the file
is absent, interactive startup offers Developer, Design, and Product starters.
Skipping setup opens an empty dashboard without creating a file. Piped commands
use an empty registry when config is absent. A valid empty config skips onboarding;
load errors are reported separately. No definitions register automatically.

The workspace root is the canonical configuration directory, or the command's
working directory without a config. Relative paths in your custom code still
follow normal JavaScript and filesystem rules; prefer `workspace.root` when
you mean the config directory.

## Registration and binding

`step` and `workflow` return executable definition handles. `agent` returns an
agent specification. `schedule` and `monitor` register definitions and return
`void`. A schedule accepts either a step/workflow handle or its registered name.
Duplicate names in the same registry are rejected.

The CLI binds runtime resources after importing the configuration. Do not
execute registered step bodies at module scope. Keep imports declarative when
inspection commands should avoid application side effects.

## Package resolution

The CLI resolves config imports of `@foundry/quirks` and `@foundry/quirks/prebuilt` to its own installed library.
This makes a global installation usable without local `node_modules`, and keeps
the configuration and CLI on one registry instance. Other libraries imported by
the config must be available through normal module resolution.

For editor types, you can additionally install the same version of
`@foundry/quirks` in the project. Keep it aligned with the global CLI; execution
uses the CLI's version. Directly importing Quirks outside the CLI only registers
definitions and does not bind a runtime.

## Prebuilt steps

Import a factory and call it to register only the step you want. Importing the
module alone registers nothing and never executes a model turn.

```ts
import { summarizeCodebase } from "@foundry/quirks/prebuilt";

summarizeCodebase({ name: "summarize-codebase" });
```

The onboarding starters register `codeReview`, `prototype`, or
`summarizeCodebase`. They create no workflows, schedules, or monitors. Options
include `name`, additional `instructions`, a specific `harness`, and `timeoutMs`.
The default model turn timeout is two minutes with no automatic retries.
`prototype` accepts `{ brief: string }` and returns HTML/CSS in its response;
it does not write the prototype to disk.

`promptStep(name, prompt, options)` creates a custom read-only model step.
`reviewInWorktree()` accepts `{ repository, base }` and reviews a temporary
checkout. `reviewSession()` accepts `{ sessionId }` and retains the conversation
in the current workspace. Use distinct session IDs for unrelated reviews.

The development-loop example lives in `apps/quirks/examples/development.ts` in
the repository. Load it explicitly or compose your own workflow; it is not
registered by the CLI or imported with prebuilt steps.

## Catalog launch arguments

Select a Catalog item and press `l`, or Enter then click Launch. Definitions
with `input: { fields: [] }` launch immediately. Definitions with fields open a
form; unknown input contracts explain how to add metadata or use `once --input`.
On acceptance, the dashboard selects the new run and clears run filters.
Schedules and monitors keep running.

Supply metadata as the third argument to `step` or `workflow`:

```ts
import { step } from "@foundry/quirks";

step("greet", async (_context, input: { name: string; excited?: boolean }) =>
  `Hello ${input.name}${input.excited ? "!" : "."}`, {
  description: "Greet someone",
  input: { fields: [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "excited", label: "Excited", type: "boolean", default: false },
  ] },
});
```

Fields support `text`, `multiline`, `number`, `boolean`, and `select`, with labels,
descriptions, required flags, and defaults. Numbers support `min` and `max`;
selects use `{ label, value }` choices. Input is a flat object. Nested objects,
arrays, and unions use `quirks once --input` for now. Tab changes form focus;
Ctrl+Enter submits; Escape returns without launching. No config is written by
launching. Setup writes the reviewed config only when Create is activated and
refuses to overwrite an existing file.
