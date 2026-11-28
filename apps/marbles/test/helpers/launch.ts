import { Workflow } from "@foundry/workflows/workflow";
import type { AnyDefinition, NamedDefinition } from "~/lib/definitions";
import { isNamed } from "~/lib/definitions";
import type { Bindings } from "~/lib/definitions/bindings";
import { RunScopes } from "~/lib/runs/scope";
import { factoryFor } from "~/lib/runs/tree";

let bound: Bindings | undefined;

export function bindLaunch(bindings: Bindings): void {
  bound = bindings;
}

export function named(definition: AnyDefinition): NamedDefinition {
  if (!isNamed(definition)) {
    throw new Error("only named definitions can be launched");
  }
  return definition;
}

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
