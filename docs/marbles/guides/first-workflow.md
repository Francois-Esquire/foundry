---
title: Your first workflow
description: Turn a deterministic function into a step with typed input, then name a workflow around it.
---

After [getting the CLI running](/marbles/start-here), save this module as `.foundry/marbles/review.ts`
in a project that has `zod` installed:

```ts
import { step, workflow } from "@foundry/marbles";
import { z } from "zod";

const greet = step("greet")
  .input(z.object({ name: z.string() }))
  .do(({ input: { name }, log }) => {
    const message = `Hello ${name}`;
    log(message);
    return { message };
  });

workflow("hello", greet({}, { name: "Ada" }));
```

```sh
marbles roll greet --input '{"name":"Ada"}'
marbles roll hello
```

The first command parses the JSON, validates it against the step's schema,
runs the body, and prints `{ "message": "Hello Ada" }`. The second runs the
workflow, whose tree is one locked node: `greet` with no children and the
literal input `{ name: "Ada" }`.

Three things to notice:

- **Schemas come before the body.** `.input(schema)` gives the body its type,
  validates what `--input` and the dashboard send, and builds the launch
  form. Any [Standard Schema](https://standardschema.dev) library works; the
  docs use zod. It must resolve from the importing file, because the CLI
  supplies `@foundry/marbles` itself but not the schema library.
- **The body receives one object.** Destructure `input` and whatever else it
  needs: `log`, `agents`, `workspaces`, `ask`, `report`. The
  [API reference](/marbles/reference/api#context) lists every key.
- **Calling a step locks a node.** `greet({}, { name: "Ada" })` is children
  first, literal input second. A workflow is a name around a tree.

Use `marbles status` to inspect the saved run. Run either command with `--dry-run`
to execute the same function without writing state. The log still appears
because the body still executes.

Next, [compose multiple steps](/marbles/guides/workflows).
