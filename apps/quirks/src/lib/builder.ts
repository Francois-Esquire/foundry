import type { StandardSchemaV1 } from "@standard-schema/spec";

import { catalog } from "./catalog";
import type {
  LockedNode,
  SetupFn,
  StepDefinition,
  StepFn,
  WorkflowDefinition,
} from "./definition";
import { isLockedNode, lockable } from "./definition";
import type { CallSite } from "./identity";
import { bindingAt, callSite } from "./identity";
import type { Output } from "./schema";

/**
 * `step(name?).describe(text).input(schema).output(schema).do(fn)`.
 * Schemas come before the body so `do` is typed from them. A name makes the
 * definition launchable from outside the config. Without one, the top-level
 * `const` it is assigned to names it; a definition made inside a function or
 * inline stays internal.
 */

type Empty = Record<string, never>;

/** The name to register under: the given one, else the binding's, else none. */
interface Identity {
  readonly inferred?: boolean;
  readonly name?: string;
  readonly site?: CallSite;
}

function identify(
  name: string | undefined,
  site: CallSite | undefined
): Identity {
  if (name !== undefined) {
    return { name };
  }
  if (site === undefined) {
    return {};
  }
  const bound = bindingAt(site);
  return bound === undefined ? { site } : { inferred: true, name: bound, site };
}

export class StepBuilder<I = Empty, O = unknown> {
  readonly #name: string | undefined;
  readonly #site: CallSite | undefined;
  readonly #description: string | undefined;
  readonly #input: StandardSchemaV1 | undefined;
  readonly #output: StandardSchemaV1 | undefined;

  constructor(
    name?: string,
    site?: CallSite,
    description?: string,
    input?: StandardSchemaV1,
    output?: StandardSchemaV1
  ) {
    this.#name = name;
    this.#site = site;
    this.#description = description;
    this.#input = input;
    this.#output = output;
  }

  /** Shown in the catalog and the launch form. */
  describe(text: string): StepBuilder<I, O> {
    return new StepBuilder(
      this.#name,
      this.#site,
      text,
      this.#input,
      this.#output
    );
  }

  input<S extends StandardSchemaV1>(schema: S): StepBuilder<Output<S>, O> {
    return new StepBuilder(
      this.#name,
      this.#site,
      this.#description,
      schema,
      this.#output
    );
  }

  output<S extends StandardSchemaV1>(schema: S): StepBuilder<I, Output<S>> {
    return new StepBuilder(
      this.#name,
      this.#site,
      this.#description,
      this.#input,
      schema
    );
  }

  do(fn: StepFn<I, O>): StepDefinition<I, O> {
    const definition = lockable<StepDefinition<I, O>>({
      ...(this.#description === undefined
        ? {}
        : { description: this.#description }),
      fn,
      ...identify(this.#name, this.#site),
      ...(this.#input === undefined ? {} : { input: this.#input }),
      kind: "step",
      ...(this.#output === undefined ? {} : { output: this.#output }),
    });
    catalog.register(definition);
    return definition;
  }
}

export function step(name?: string): StepBuilder {
  return new StepBuilder(name, name === undefined ? callSite() : undefined);
}

export class WorkflowBuilder<I = Empty> {
  readonly #name: string | undefined;
  readonly #site: CallSite | undefined;
  readonly #description: string | undefined;
  readonly #input: StandardSchemaV1 | undefined;

  constructor(
    name?: string,
    site?: CallSite,
    description?: string,
    input?: StandardSchemaV1
  ) {
    this.#name = name;
    this.#site = site;
    this.#description = description;
    this.#input = input;
  }

  describe(text: string): WorkflowBuilder<I> {
    return new WorkflowBuilder(this.#name, this.#site, text, this.#input);
  }

  input<S extends StandardSchemaV1>(schema: S): WorkflowBuilder<Output<S>> {
    return new WorkflowBuilder(
      this.#name,
      this.#site,
      this.#description,
      schema
    );
  }

  /** Setup: prepares things and returns the tree. Not durable. */
  do(setup: SetupFn<I>): WorkflowDefinition<I> {
    return finishWorkflow(
      identify(this.#name, this.#site),
      this.#description,
      this.#input,
      { setup }
    );
  }
}

function finishWorkflow<I>(
  identity: Identity,
  description: string | undefined,
  input: StandardSchemaV1 | undefined,
  body: { setup: SetupFn<I> } | { tree: LockedNode }
): WorkflowDefinition<I> {
  const definition = lockable<WorkflowDefinition<I>>({
    ...(description === undefined ? {} : { description }),
    ...identity,
    ...(input === undefined ? {} : { input }),
    kind: "workflow",
    setup: "setup" in body ? body.setup : undefined,
    tree: "tree" in body ? body.tree : undefined,
  });
  catalog.register(definition);
  return definition;
}

type TreeArg = LockedNode | (() => LockedNode);

export function workflow(tree: TreeArg): WorkflowDefinition;
export function workflow(name: string, tree: TreeArg): WorkflowDefinition;
export function workflow(name?: string): WorkflowBuilder;
export function workflow(
  first?: string | TreeArg,
  second?: TreeArg
): WorkflowDefinition | WorkflowBuilder {
  const name = typeof first === "string" ? first : undefined;
  const site = name === undefined ? callSite() : undefined;
  const tree = typeof first === "string" ? second : first;
  if (tree === undefined) {
    return new WorkflowBuilder(name, site);
  }
  if (typeof tree === "function") {
    return finishWorkflow(identify(name, site), undefined, undefined, {
      setup: () => tree(),
    });
  }
  if (!isLockedNode(tree)) {
    throw new Error(
      `workflow(${name ? `"${name}"` : ""}): expected a locked node or a function returning one`
    );
  }
  return finishWorkflow(identify(name, site), undefined, undefined, { tree });
}
