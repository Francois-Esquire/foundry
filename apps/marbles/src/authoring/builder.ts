import type { Bail } from "@foundry/workflows/types";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  activeSetupCounters,
  claimLoadDefinition,
  ownRun,
  trackCreatedDeclaration,
} from "~/authoring/runtime";
import { fillArgv, parseArgv, placeholdersOf } from "~/lib/argv";
import { timeoutMs } from "~/lib/cadence";
import type { CommandResult, ExecOptions } from "~/lib/command-error";
import type {
  AnyDefinition,
  LockedNode,
  SetupFn,
  StepConfig,
  StepFn,
} from "~/lib/definition";
import { isLockedNode } from "~/lib/definition";
import { observable, RUNS } from "~/lib/events/source";
import { DEFINITION_IDENTITY, EXPLICIT_NAME, STATIC_TREE } from "~/lib/handles";
import { sha256HexSync } from "~/lib/hash";
import type { Input, Output } from "~/lib/schema";
import { inputKeysOf } from "~/lib/schema";
import type { Context } from "~/lib/types";
import { enqueueNamed } from "./instances";
import type {
  Enqueued,
  EnqueueOptions,
  StepDefinition,
  WorkflowDefinition,
} from "./lock";
import { lockable } from "./lock";

type Empty = Record<string, never>;

type Produces<O, X> = unknown extends O ? X : O;

function nameHintOf(kind: "step" | "workflow"): string {
  return `give it one: ${kind}("name") or export it as a named constant`;
}

const CLOSURE_COUNTER_KEY = Symbol.for("marbles.definition.closureCounter.v1");

function nextClosureId(): number {
  const holder = globalThis as Record<symbol, { count: number } | undefined>;
  let state = holder[CLOSURE_COUNTER_KEY];
  if (state === undefined) {
    state = { count: 0 };
    holder[CLOSURE_COUNTER_KEY] = state;
  }
  state.count += 1;
  return state.count;
}

function anonymousIdentity(
  definition: AnyDefinition,
  sourceText?: string
): string {
  const source =
    sourceText ??
    (definition.kind === "step"
      ? definition.fn.toString()
      : definition.setup.toString());
  const hash = sha256HexSync(`${definition.kind}:${source}`).slice(0, 16);
  const setup = activeSetupCounters();
  if (setup !== undefined) {
    const occurrence = setup.get("definition") ?? 0;
    setup.set("definition", occurrence + 1);
    return `setup:definition#${String(occurrence)}:${hash}`;
  }
  const running = ownRun();
  if (running !== undefined) {
    const { occurrence } = running.scope.claim(running.frame, "definition");
    return `run:definition#${String(occurrence)}:${hash}`;
  }
  const loaded = claimLoadDefinition(hash);
  if (loaded !== undefined) {
    return loaded;
  }
  return `closure:definition#${String(nextClosureId())}:${hash}`;
}

function tagged<D extends AnyDefinition>(
  definition: D,
  explicitName: boolean,
  staticTree?: LockedNode,
  sourceText?: string
): D {
  if (explicitName) {
    Object.defineProperty(definition, EXPLICIT_NAME, { value: true });
  } else {
    Object.defineProperty(definition, DEFINITION_IDENTITY, {
      configurable: true,
      value: anonymousIdentity(definition, sourceText),
    });
  }
  if (staticTree !== undefined) {
    Object.defineProperty(definition, STATIC_TREE, { value: staticTree });
  }
  trackCreatedDeclaration(definition);
  return definition;
}

interface StepFields {
  readonly config?: StepConfig;
  readonly description?: string;
  readonly input?: StandardSchemaV1;
  readonly name?: string;
  readonly output?: StandardSchemaV1;
}

export class StepBuilder<I = Empty, R = Empty, Ret = unknown, O = unknown> {
  readonly #fields: StepFields;

  constructor(fields: StepFields = {}) {
    this.#fields = fields;
  }

  describe(text: string): StepBuilder<I, R, Ret, O> {
    return new StepBuilder({ ...this.#fields, description: text });
  }

  config(config: StepConfig): StepBuilder<I, R, Ret, O> {
    if (config.timeout !== undefined) {
      try {
        timeoutMs(config.timeout);
      } catch (error) {
        throw new Error(
          `step().config(): cannot read timeout ${JSON.stringify(config.timeout)} (want e.g. 30s, 10m, or milliseconds)`,
          { cause: error }
        );
      }
    }
    return new StepBuilder({ ...this.#fields, config });
  }

  input<S extends StandardSchemaV1>(
    schema: S
  ): StepBuilder<Output<S>, Input<S>, Ret, O> {
    return new StepBuilder({ ...this.#fields, input: schema });
  }

  output<S extends StandardSchemaV1>(
    schema: S
  ): StepBuilder<I, R, Input<S>, Output<S>> {
    return new StepBuilder({ ...this.#fields, output: schema });
  }

  exec(
    command:
      | string
      | ((context: Context<I>) => CommandLine | Promise<CommandLine>),
    options?:
      | ExecOptions
      | ((context: Context<I>) => ExecOptions | Promise<ExecOptions>)
  ): StepDefinition<I, CommandResult, R> {
    const run =
      typeof command === "string"
        ? templateCommand(command, this.#fields)
        : command;
    const { output: _output, ...fields } = this.#fields;
    const sourceText =
      typeof command === "string"
        ? `exec:${command}`
        : `exec:${command.toString()}`;
    const definition = lockable<StepDefinition<I, CommandResult, R>>({
      ...(fields.config === undefined ? {} : { config: fields.config }),
      ...(fields.description === undefined
        ? {}
        : { description: fields.description }),
      fn: async (context) => {
        const line = await run(context);
        return context.exec(
          line,
          typeof options === "function" ? await options(context) : options
        );
      },
      ...(fields.name === undefined
        ? { nameHint: nameHintOf("step") }
        : { name: fields.name }),
      ...(fields.input === undefined ? {} : { input: fields.input }),
      kind: "step",
    });
    return tagged(definition, fields.name !== undefined, undefined, sourceText);
  }

  do<X extends Ret | Bail<unknown>>(
    fn: StepFn<I, X>
  ): StepDefinition<I, Produces<O, Exclude<X, Bail<unknown>>>, R> {
    const { config, description, input, name, output } = this.#fields;
    const definition = lockable<
      StepDefinition<I, Produces<O, Exclude<X, Bail<unknown>>>, R>
    >({
      ...(config === undefined ? {} : { config }),
      ...(description === undefined ? {} : { description }),
      fn,
      ...(name === undefined ? { nameHint: nameHintOf("step") } : { name }),
      ...(input === undefined ? {} : { input }),
      kind: "step",
      ...(output === undefined ? {} : { output }),
    });
    return tagged(definition, name !== undefined);
  }
}

type CommandLine = readonly string[];

function templateCommand(
  template: string,
  { input, name }: StepFields
): (context: Context<unknown>) => CommandLine {
  const where = `step(${name === undefined ? "" : JSON.stringify(name)}).exec(${JSON.stringify(template)})`;
  let args: ReturnType<typeof parseArgv>;
  try {
    args = parseArgv(template);
  } catch (error) {
    throw new Error(
      `${where}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      }
    );
  }
  const [program] = args;
  if (!program || program.some((segment) => segment.kind !== "text")) {
    throw new Error(
      `${where}: the program, the first word, must be written out`
    );
  }
  const placeholders = placeholdersOf(args);
  const keys = input ? inputKeysOf(input) : [];
  const unknown = keys && placeholders.filter((key) => !keys.includes(key));
  if (unknown && unknown.length > 0) {
    throw new Error(
      `${where}: ${unknown.map((key) => `$${key}`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not ${input ? "an input key" : "declared; add it to .input()"}`
    );
  }
  return ({ input: values }) =>
    fillArgv(args, (values ?? {}) as Readonly<Record<string, unknown>>);
}

export function step(name?: string): StepBuilder {
  return new StepBuilder(name === undefined ? {} : { name });
}

step.enqueue = <O = unknown>(
  name: string,
  input?: Record<string, unknown>,
  options?: EnqueueOptions
): Promise<Enqueued<O>> =>
  enqueueNamed("step", name, input ?? {}, options) as Promise<Enqueued<O>>;

export class WorkflowBuilder<I = Empty, R = Empty> {
  readonly #name: string | undefined;
  readonly #description: string | undefined;
  readonly #input: StandardSchemaV1 | undefined;

  constructor(name?: string, description?: string, input?: StandardSchemaV1) {
    this.#name = name;
    this.#description = description;
    this.#input = input;
  }

  describe(text: string): WorkflowBuilder<I, R> {
    return new WorkflowBuilder(this.#name, text, this.#input);
  }

  input<S extends StandardSchemaV1>(
    schema: S
  ): WorkflowBuilder<Output<S>, Input<S>> {
    return new WorkflowBuilder(this.#name, this.#description, schema);
  }

  do<O>(setup: SetupFn<I, O>): WorkflowDefinition<I, O, R> {
    return finishWorkflow<I, O, R>(
      this.#name,
      this.#description,
      this.#input,
      setup
    );
  }
}

function finishWorkflow<I, O, R = I>(
  name: string | undefined,
  description: string | undefined,
  input: StandardSchemaV1 | undefined,
  setup: SetupFn<I, O>,
  staticTree?: LockedNode
): WorkflowDefinition<I, O, R> {
  const definition = lockable<WorkflowDefinition<I, O, R>>({
    ...(description === undefined ? {} : { description }),
    ...(name === undefined ? { nameHint: nameHintOf("workflow") } : { name }),
    ...(input === undefined ? {} : { input }),
    kind: "workflow",
    setup,
  });
  return tagged(definition, name !== undefined, staticTree);
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
  const tree = typeof first === "string" ? second : first;
  if (tree === undefined) {
    return new WorkflowBuilder(name);
  }
  if (typeof tree === "function") {
    return finishWorkflow(name, undefined, undefined, () => tree());
  }
  if (!isLockedNode(tree)) {
    throw new Error(
      `workflow(${name ? `"${name}"` : ""}): expected a locked node or a function returning one`
    );
  }
  return finishWorkflow(name, undefined, undefined, () => tree, tree);
}

workflow.enqueue = <O = unknown>(
  name: string,
  input?: Record<string, unknown>,
  options?: EnqueueOptions
): Promise<Enqueued<O>> =>
  enqueueNamed("workflow", name, input ?? {}, options) as Promise<Enqueued<O>>;

observable(workflow, RUNS);
