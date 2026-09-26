---
title: Compose a workflow
description: Hand one step's result to another, run independent work together, and give a workflow input.
---

Save this as its own configuration, or replace the first guide's definitions:

```ts
import { step, workflow } from "@foundry/quirks";
import { z } from "zod";

const greet = step("greet")
  .input(z.object({ name: z.string() }))
  .output(z.string())
  .do(({ input: { name } }) => `Hello ${name}`);

const measure = step("measure")
  .input(z.object({ text: z.string() }))
  .do(({ input: { text } }) => ({ text, length: text.length }));

workflow("greeting-report", measure({ text: greet({}, { name: "Ada" }) }));
```

```sh
quirks once greeting-report
```

`measure` takes `greet` as a child under the key `text`. The child runs first;
its result arrives in the parent's `input.text`; the parent returns
`{ text: "Hello Ada", length: 9 }`, which is the workflow's result. In logs and
the dashboard the child is `greeting-report.text`: keys name steps, so choose
keys that read well.

The parent declares its children in `.input()` like any other input, and each
child's output is checked against its key when the config loads. A child
whose `.output()` does not fit, or a key the parent does not declare, is an
error before anything runs.

## Independent work runs together

Children in key order is the default. `.parallel` runs them together:

```ts
const shout = step("shout")
  .input(z.object({ name: z.string() }))
  .output(z.string())
  .do(({ input: { name } }) => `HELLO ${name.toUpperCase()}`);

const both = step("both")
  .input(z.object({ plain: z.string(), loud: z.string() }))
  .do(({ input }) => input);

workflow("greet-twice", both.parallel({
  plain: greet({}, { name: "Ada" }),
  loud: shout({}, { name: "Ada" }),
}));
```

Siblings never see each other. Data flows only from a child to its parent, so
a step that needs another's result takes it as a child. If a parallel sibling
fails, the others are stopped and the run fails; if one parks on a question,
the others finish and the parent waits.

## A workflow with input

To take input at launch, put the tree in a setup function:

```ts
workflow("greet-anyone")
  .input(z.object({ name: z.string() }))
  .do(({ input: { name } }) => measure({ text: greet({}, { name }) }));
```

```sh
quirks once greet-anyone --input '{"name":"Grace"}'
```

Setup receives `{ input, log, run }` and returns the tree. It is not durable:
it runs again whenever the run is set up, including after a restart, so it
prepares and returns rather than doing work. Anything it must keep goes into
a step as input, which the run records.

Series and parallel are the two combinators today. Race, branch, and loops
are not available yet. The [implement-review pattern](/quirks/use-cases/implement-review)
shows how model work fits into this composition.
