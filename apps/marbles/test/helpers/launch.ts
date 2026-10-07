import { Workflow } from "@foundry/workflows/workflow";

import type { Bindings } from "~/lib/bindings";
import type { AnyDefinition, NamedDefinition } from "~/lib/definition";
import { isNamed } from "~/lib/definition";
import { RunScopes } from "~/lib/run-scope";
import { factoryFor } from "~/lib/tree";

let bound: Bindings | undefined;

/** What `launch` runs against: an engine's `bindings`. */
export function bindLaunch(bindings: Bindings): void {
  bound = bindings;
}

/** A definition a test launches by hand; the engine only ever holds named ones. */
export function named(definition: AnyDefinition): NamedDefinition {
  if (!isNamed(definition)) {
    throw new Error("only named definitions can be launched");
  }
  return definition;
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
  const scopes = new RunScopes();
  try {
    const root = await factoryFor(
      named(definition),
      () => {
        if (!bound) {
          throw new Error("launch(): call bindLaunch or bindMock first");
        }
        return bound;
      },
      scopes
    )(input, undefined);
    return (await Workflow.attach(root, input).run()) as O;
  } finally {
    await Promise.all([...scopes].map((scope) => scopes.settle(scope.id)));
  }
}
