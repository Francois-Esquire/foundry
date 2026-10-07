import type { StandardSchemaV1 } from "@standard-schema/spec";
import { catalog } from "~/authoring/catalog";
import type { LockedNode, SetupFn, Shared, StepFn } from "~/lib/definition";
import { isLockedNode } from "~/lib/definition";
import type { Input, Output } from "~/lib/schema";
import type { CallSite } from "./identity";
import { bindingAt, callSite, canInfer, originOf } from "./identity";
import type { StepDefinition, WorkflowDefinition } from "./lock";
import { lockable } from "./lock";

/**
 * `step(name?).describe(text).input(schema).output(schema).do(fn)`.
 * Schemas come before the body so `do` is typed from them. A name makes the
 * definition launchable from outside the module. Without one, the top-level
 * `const` it is assigned to names it; a definition made inside a function or
 * inline stays internal.
 */

type Empty = Record<string, never>;

/** What a node produces: the output schema's type, else the body's return. */
type Produces<O, X> = unknown extends O ? X : O;

/**
 * The name to register under (the given one, else the binding's, else
 * none), with where the call was and how to name it, in the words the
 * engine quotes back without knowing how names are inferred.
 */
interface Identity {
  readonly fields: Pick<Shared, "name" | "nameHint" | "origin">;
  /** The name came from the config's `const`, not the call. */
  readonly inferred: boolean;
}

function identify(
  kind: "step" | "workflow",
  name: string | undefined,
  site: CallSite | undefined
): Identity {
  const explicit = `give it one: ${kind}("name")`;
  if (site === undefined) {
    return {
      fields: name === undefined ? { nameHint: explicit } : { name },
      inferred: false,
    };
  }
  const origin = originOf(site);
  if (name !== undefined) {
    return { fields: { name, origin }, inferred: false };
  }
  const bound = bindingAt(site);
  if (bound !== undefined) {
    return { fields: { name: bound, origin }, inferred: true };
  }
  const nameHint = canInfer(site.file)
    ? explicit
    : `install typescript in the config's project to name it from its const, or ${explicit}`;
  return { fields: { nameHint, origin }, inferred: false };
}

/**
 * `I`: parsed input the body sees. `R`: raw input a literal takes. `Ret`:
 * what the body must return (the output schema's input). `O`: what the node
 * produces for its parent (the output schema's output).
 */
export class StepBuilder<I = Empty, R = Empty, Ret = unknown, O = unknown> {
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
  describe(text: string): StepBuilder<I, R, Ret, O> {
    return new StepBuilder(
      this.#name,
      this.#site,
      text,
      this.#input,
      this.#output
    );
  }

  input<S extends StandardSchemaV1>(
    schema: S
  ): StepBuilder<Output<S>, Input<S>, Ret, O> {
    return new StepBuilder(
      this.#name,
      this.#site,
      this.#description,
      schema,
      this.#output
    );
  }

  output<S extends StandardSchemaV1>(
    schema: S
  ): StepBuilder<I, R, Input<S>, Output<S>> {
    return new StepBuilder(
      this.#name,
      this.#site,
      this.#description,
      this.#input,
      schema
    );
  }

  do<X extends Ret>(fn: StepFn<I, X>): StepDefinition<I, Produces<O, X>, R> {
    const identity = identify("step", this.#name, this.#site);
    const definition = lockable<StepDefinition<I, Produces<O, X>, R>>({
      ...(this.#description === undefined
        ? {}
        : { description: this.#description }),
      fn,
      ...identity.fields,
      ...(this.#input === undefined ? {} : { input: this.#input }),
      kind: "step",
      ...(this.#output === undefined ? {} : { output: this.#output }),
    });
    catalog.define(definition, identity.inferred);
    return definition;
  }
}

export function step(name?: string): StepBuilder {
  return new StepBuilder(name, callSite());
}

export class WorkflowBuilder<I = Empty, R = Empty> {
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

  describe(text: string): WorkflowBuilder<I, R> {
    return new WorkflowBuilder(this.#name, this.#site, text, this.#input);
  }

  input<S extends StandardSchemaV1>(
    schema: S
  ): WorkflowBuilder<Output<S>, Input<S>> {
    return new WorkflowBuilder(
      this.#name,
      this.#site,
      this.#description,
      schema
    );
  }

  /** Setup: prepares things and returns the tree. Not durable. */
  do<O>(setup: SetupFn<I, O>): WorkflowDefinition<I, O, R> {
    return finishWorkflow<I, O, R>(
      identify("workflow", this.#name, this.#site),
      this.#description,
      this.#input,
      setup
    );
  }
}

function finishWorkflow<I, O, R = I>(
  identity: Identity,
  description: string | undefined,
  input: StandardSchemaV1 | undefined,
  setup: SetupFn<I, O>
): WorkflowDefinition<I, O, R> {
  const definition = lockable<WorkflowDefinition<I, O, R>>({
    ...(description === undefined ? {} : { description }),
    ...identity.fields,
    ...(input === undefined ? {} : { input }),
    kind: "workflow",
    setup,
  });
  catalog.define(definition, identity.inferred);
  return definition;
}

type TreeArg<O = unknown> = LockedNode<O> | (() => LockedNode<O>);

export function workflow<O>(tree: TreeArg<O>): WorkflowDefinition<Empty, O>;
export function workflow<O>(
  name: string,
  tree: TreeArg<O>
): WorkflowDefinition<Empty, O>;
export function workflow(name?: string): WorkflowBuilder;
export function workflow(
  first?: string | TreeArg,
  second?: TreeArg
): WorkflowDefinition | WorkflowBuilder {
  const name = typeof first === "string" ? first : undefined;
  const site = callSite();
  const tree = typeof first === "string" ? second : first;
  if (tree === undefined) {
    return new WorkflowBuilder(name, site);
  }
  const identity = identify("workflow", name, site);
  if (typeof tree === "function") {
    return finishWorkflow(identity, undefined, undefined, () => tree());
  }
  if (!isLockedNode(tree)) {
    throw new Error(
      `workflow(${name ? `"${name}"` : ""}): expected a locked node or a function returning one`
    );
  }
  // A tree known up front is a setup that returns it.
  return finishWorkflow(identity, undefined, undefined, () => tree);
}
