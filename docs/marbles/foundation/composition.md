---
title: Steps and workflow composition
description: Connect typed results into a tree that executes in dependency order.
sidebar:
  label: Steps and workflows
---

A step owns one piece of work. A workflow gives a connected tree of steps a
name and launch input. A parent receives its children's results, so children
run before the parent.

Marbles builds this tree on [Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md).
The same definition can occupy a position in more than one tree. Its
position determines which results it receives in this workflow.

## Inputs and results

A step accepts input and returns a result. `.input(schema)` validates the
input and supplies its TypeScript type; `.output(schema)` validates the
result. Return plain JSON data so Marbles can record it and hand it to
another step.

A parent declares the child results it consumes in its input schema. In
the example below, `count` returns a number and `summarize` receives that
number as `input.count`.

## Hand a result to the next step

Install `zod@4.4.3` in your project. Save this complete module as
`.foundry/marbles/summary.ts`:

```ts
import { step, workflow } from "@foundry/marbles";
import { z } from "zod";

const count = step("count-matching")
  .input(z.object({ extension: z.string() }))
  .output(z.number())
  .do(async ({ input, workspaces }) => {
    const files = await workspaces.current.files();
    return files.filter((file) => file.path.endsWith(input.extension)).length;
  });

const summarize = step("summarize-count")
  .input(z.object({ count: z.number(), extension: z.string() }))
  .output(z.string())
  .do(({ input }) => `${input.count} files end in ${input.extension}`);

workflow("file-summary")
  .input(z.object({ extension: z.string() }))
  .do(({ input }) =>
    summarize({ count: count({}, { extension: input.extension }) }, input)
  );
```

Run `marbles roll file-summary --input '{"extension":".ts"}'`. The workflow
returns a sentence containing the count.

`summarize(children, literalInput)` takes children first and literal input
second. `count` supplies `input.count`; the literal supplies `input.extension`.
A key cannot appear in both. The parent's input schema declares both fields.

## Run independent work together

This separate module counts two kinds of file concurrently:

```ts
import { step, workflow } from "@foundry/marbles";
import { z } from "zod";

const count = step("count-kind")
  .input(z.object({ extension: z.string() }))
  .output(z.number())
  .do(async ({ input, workspaces }) =>
    (await workspaces.current.files()).filter((file) => file.path.endsWith(input.extension)).length
  );

const combine = step("combine-counts")
  .input(z.object({ typescript: z.number(), markdown: z.number() }))
  .do(({ input }) => input);

workflow("project-counts", combine.parallel({
  typescript: count({}, { extension: ".ts" }),
  markdown: count({}, { extension: ".md" }),
}));
```

`marbles roll project-counts` returns both counts. Calling `combine(...)` or
`combine.series(...)` runs children in key order; `.parallel(...)` runs them
together. Data flows from children to their parent, never between siblings.
If one parallel child fails, siblings are cancelled and awaited.

## Choose a boundary

Make an operation a child step when its result, failure, or progress should
be independently visible. Keep ordinary calculations inside a body. A
workflow can be a launch root, but cannot be nested as a child in another
tree; reuse its steps instead.

`.run(input)` executes a definition directly, including from inside a
body. Its nested execution does not appear as an independent dashboard run.
Lock a child into the tree when you want that visibility.

There are no race, branching, or loop combinators. You can choose a tree in
ordinary TypeScript during setup. Keep the actual commands, file access,
and agent turns inside steps. The [builder reference](/marbles/reference/api#the-builder)
lists the exact composition forms.

Step boundaries also determine what can be retried or kept while waiting.
[Durability](/marbles/foundation/durability) explains those rules after the
resource chapters. Next: [Contexts and bindings](/marbles/foundation/contexts)
explains what setup and step callbacks receive when this tree executes.
