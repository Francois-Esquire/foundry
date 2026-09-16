---
title: Your first behavior
description: Turn a deterministic function into a manually dispatched workflow.
---

After [installing Quirks](/quirks/start-here), save this configuration:

```ts
import { step, workflow } from "@foundry/quirks";

const greet = step("greet", async ({ log }, name: string) => {
  const message = `Hello ${name}`;
  log(message);
  return { message };
});

workflow<string, { message: string }>("hello", (graph) => {
  graph.step("greeting", greet, ({ input }) => input)
    .output(({ greeting }) => greeting);
});
```

```sh
quirks once hello --input '"Ada"'
```

The CLI parses JSON input, dispatches the workflow, and prints its result. The
step receives runtime resources first and mapped input second. `output` chooses
what the workflow returns. You can also dispatch `greet` directly.

Use `quirks status` to inspect the saved run. Run with `--dry` to execute the
same function without writing Quirks state. The log still appears because the
custom body still executes.

Next, [compose multiple steps](/quirks/guides/workflows).
