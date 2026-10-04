import type { AnyDefinition, LockedNode } from "./definition";
import { isLockedNode } from "./definition";

/**
 * What a trigger starts: a named definition and the input it was locked
 * with. A locked node with children is a tree, not a target; it needs a
 * workflow name to run on its own.
 */

export interface Launch {
  readonly input: unknown;
  readonly workflow: string;
}

function nameless(verb: string, definition: AnyDefinition): string {
  const hint = definition.uninferable
    ? "; install typescript in the config's project to name it from its const, or"
    : ";";
  return `${verb}: this ${definition.kind} has no name${hint} give it one: ${definition.kind}("name")`;
}

export function launchTarget(
  target: AnyDefinition | LockedNode,
  verb: string
): Launch {
  const node = isLockedNode(target) ? target : undefined;
  if (node && node.children.length > 0) {
    throw new Error(
      `${verb}: a locked tree has children; wrap it in workflow(name, tree) first`
    );
  }
  const definition = node ? node.definition : (target as AnyDefinition);
  if (definition.name === undefined) {
    throw new Error(nameless(verb, definition));
  }
  const literal = node?.literal ?? {};
  return {
    input: Object.keys(literal).length === 0 ? null : literal,
    workflow: definition.name,
  };
}

export function isLaunch(value: unknown): value is Launch {
  return (
    typeof value === "object" &&
    value !== null &&
    "workflow" in value &&
    typeof value.workflow === "string" &&
    "input" in value
  );
}
