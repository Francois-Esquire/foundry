---
title: Compose a workflow
description: Connect inputs and outputs before adding concurrency.
---

Save this as its own configuration, or replace the first guide's definitions:

```ts
import { step, workflow } from "@foundry/quirks";

const greet = step("greet-person", async (_resources, name: string) => ({
  message: `Hello ${name}`,
}));
const measure = step("measure-message", async (_resources, text: string) => ({
  length: text.length,
}));

workflow<string, { message: string; length: number }>("greeting-report", (graph) => {
  graph
    .step("greeting", greet, ({ input }) => input)
    .step("measurement", measure, ({ greeting }) => greeting.message)
    .output(({ greeting, measurement }) => ({
      message: greeting.message,
      length: measurement.length,
    }));
});
```

```sh
quirks once greeting-report --input '"Ada"'
```

`measurement` depends on `greeting`. Its input mapper makes that relationship
explicit. A workflow handle can replace a step handle in a larger graph.

For independent work, use `parallel` with named definitions. Use `branch` when
one predicate should select a path, and `race` when the first completed branch
is the desired result. See the [combinator reference](/quirks/reference/factories#workflowname-define)
for their call shapes.

When one attempt should inform another, use `loopUntil` with a round limit and
an explicit stopping predicate. The [implement-review pattern](/quirks/use-cases/implement-review)
shows how model work fits into this composition.
