import { Workflow } from "@foundry/workflows/workflow";

import type { Bindings } from "~/lib/bindings";
import type { AnyDefinition } from "~/lib/definition";
import { runs } from "~/lib/run-scope";
import { factoryFor } from "~/lib/tree";

let bound: Bindings | undefined;

/** What `launch` runs against: an engine's `bindings`. */
export function bindLaunch(bindings: Bindings): void {
  bound = bindings;
}

/**
 * Run a named definition outside the engine against the bindings last given
 * to `bindLaunch`, then close what the run opened. The caller states the
 * output type it expects, as with `engine.run`.
 */
export async function launch<O = unknown>(
  definition: AnyDefinition,
  input: unknown = {}
): Promise<O> {
  try {
    const root = await factoryFor(definition, () => {
      if (!bound) {
        throw new Error("launch(): call bindLaunch or bindMock first");
      }
      return bound;
    })(input, undefined);
    return (await Workflow.attach(root, input).run()) as O;
  } finally {
    await Promise.all([...runs.values()].map((scope) => scope.settle()));
  }
}
