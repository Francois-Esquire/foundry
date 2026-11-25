import { fillArgv, parseArgv, placeholdersOf } from "@foundry/lib/argv";
import type { Bail } from "@foundry/workflows/types";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Scope } from "~/authoring/runtime";
import { captureScope, declaringCatalog, ownRun } from "~/authoring/runtime";
import type { CommandResult, ExecOptions } from "~/lib/command";
import type {
  AnyDefinition,
  LockedNode,
  SetupFn,
  Shared,
  StepConfig,
  StepFn,
} from "~/lib/definition";
import { isLockedNode } from "~/lib/definition";
import { observable, RUNS } from "~/lib/events/source";
import { DEFINITION_IDENTITY } from "~/lib/handles";
import { setupCounters } from "~/lib/run-scope";
import type { Input, Output } from "~/lib/schema";
import { inputKeysOf } from "~/lib/schema";
import { timeoutMs } from "~/lib/tree";
import type { Context } from "~/lib/types";
import type { CallSite } from "./identity";
import { bindingAt, callSite, canInfer, originOf } from "./identity";
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

interface Identity {
  readonly fields: Pick<Shared, "name" | "nameHint" | "origin">;
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
    : `install typescript@6 in the config's project to name it from its const, or ${explicit}`;
  return { fields: { nameHint, origin }, inferred: false };
}

function constructionId(site: CallSite | undefined): string {
  const key =
    site === undefined
      ? "unplaced"
      : `${site.file}:${String(site.line)}:${String(site.column)}`;
  const setup = setupCounters.getStore();
  if (setup !== undefined) {
    const occurrence = setup.get(key) ?? 0;
    setup.set(key, occurrence + 1);
    return `setup:${key}#${String(occurrence)}`;
  }
  const running = ownRun();
  if (running !== undefined) {
    const { occurrence } = running.scope.claim(
      running.frame,
      `definition:${key}`
    );
    return `run:${key}#${String(occurrence)}`;
  }
  return `catalog:${declaringCatalog().claimId(key)}`;
}

function identified<D extends AnyDefinition>(
  definition: D,
  site: CallSite | undefined
): D {
  if (definition.name === undefined) {
    Object.defineProperty(definition, DEFINITION_IDENTITY, {
      value: constructionId(site),
    });
  }
  return definition;
}

interface StepFields {
  readonly config?: StepConfig;
  readonly description?: string;
  readonly input?: StandardSchemaV1;
  readonly name?: string;
  readonly output?: StandardSchemaV1;
  readonly scope?: Scope;
  readonly site?: CallSite;
}

const now: Scope = (work) => work();

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
    const untyped = new StepBuilder<I, R>(fields);
    return untyped.do(async (context) => {
      const line = await run(context);
      return context.exec(
        line,
        typeof options === "function" ? await options(context) : options
      );
    }) as unknown as StepDefinition<I, CommandResult, R>;
  }

  do<X extends Ret | Bail<unknown>>(
    fn: StepFn<I, X>
  ): StepDefinition<I, Produces<O, Exclude<X, Bail<unknown>>>, R> {
    const { config, description, input, name, output, scope, site } =
      this.#fields;
    return (scope ?? now)(() => {
      const identity = identify("step", name, site);
      const definition = lockable<
        StepDefinition<I, Produces<O, Exclude<X, Bail<unknown>>>, R>
      >({
        ...(config === undefined ? {} : { config }),
        ...(description === undefined ? {} : { description }),
        fn,
        ...identity.fields,
        ...(input === undefined ? {} : { input }),
        kind: "step",
        ...(output === undefined ? {} : { output }),
      });
      declaringCatalog().define(definition, identity.inferred);
      return identified(definition, site);
    });
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
  return new StepBuilder({
    ...(name === undefined ? {} : { name }),
    scope: captureScope(),
    site: callSite(),
  });
}

step.enqueue = <O = unknown>(
  name: string,
  input?: Record<string, unknown>,
  options?: EnqueueOptions
): Promise<Enqueued<O>> =>
  enqueueNamed("step", name, input ?? {}, options) as Promise<Enqueued<O>>;

export class WorkflowBuilder<I = Empty, R = Empty> {
  readonly #name: string | undefined;
  readonly #site: CallSite | undefined;
  readonly #description: string | undefined;
  readonly #input: StandardSchemaV1 | undefined;
  readonly #scope: Scope;

  constructor(
    name?: string,
    site?: CallSite,
    description?: string,
    input?: StandardSchemaV1,
    scope: Scope = now
  ) {
    this.#name = name;
    this.#site = site;
    this.#description = description;
    this.#input = input;
    this.#scope = scope;
  }

  describe(text: string): WorkflowBuilder<I, R> {
    return new WorkflowBuilder(
      this.#name,
      this.#site,
      text,
      this.#input,
      this.#scope
    );
  }

  input<S extends StandardSchemaV1>(
    schema: S
  ): WorkflowBuilder<Output<S>, Input<S>> {
    return new WorkflowBuilder(
      this.#name,
      this.#site,
      this.#description,
      schema,
      this.#scope
    );
  }

  do<O>(setup: SetupFn<I, O>): WorkflowDefinition<I, O, R> {
    return this.#scope(() =>
      finishWorkflow<I, O, R>(
        identify("workflow", this.#name, this.#site),
        this.#site,
        this.#description,
        this.#input,
        setup
      )
    );
  }
}

function finishWorkflow<I, O, R = I>(
  identity: Identity,
  site: CallSite | undefined,
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
  declaringCatalog().define(definition, identity.inferred);
  return identified(definition, site);
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
    return new WorkflowBuilder(
      name,
      site,
      undefined,
      undefined,
      captureScope()
    );
  }
  const identity = identify("workflow", name, site);
  if (typeof tree === "function") {
    return finishWorkflow(identity, site, undefined, undefined, () => tree());
  }
  if (!isLockedNode(tree)) {
    throw new Error(
      `workflow(${name ? `"${name}"` : ""}): expected a locked node or a function returning one`
    );
  }
  return finishWorkflow(identity, site, undefined, undefined, () => tree);
}

workflow.enqueue = <O = unknown>(
  name: string,
  input?: Record<string, unknown>,
  options?: EnqueueOptions
): Promise<Enqueued<O>> =>
  enqueueNamed("workflow", name, input ?? {}, options) as Promise<Enqueued<O>>;

observable(workflow, RUNS);
