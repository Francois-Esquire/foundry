import { Workflow } from "@foundry/workflows/workflow";

import { catalog } from "~/lib/catalog";
import type { AnyDefinition } from "~/lib/definition";
import { runs } from "~/lib/run-scope";
import { factoryFor } from "~/lib/tree";

/**
 * Run a named definition outside the engine against whatever the catalog is
 * bound to, then close what the run opened. The caller states the output
 * type it expects, as with `engine.run`.
 */
export async function launch<O = unknown>(
  definition: AnyDefinition,
  input: unknown = {}
): Promise<O> {
  try {
    const root = await factoryFor(definition, () => catalog.bindings())(
      input,
      undefined
    );
    return (await Workflow.attach(root, input).run()) as O;
  } finally {
    await Promise.all([...runs.values()].map((scope) => scope.settle()));
  }
}
