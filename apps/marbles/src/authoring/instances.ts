import { resolve } from "node:path";
import type { TurnOptions } from "@foundry/agents/harness";
import type { SessionInput, SessionStream } from "@foundry/agents/session";
import { PortablePrompt } from "@foundry/prompts";
import type { Git } from "@foundry/workspaces/git";
import type { Output } from "ai";

import type { Bindings, ManagerArgs } from "~/lib/bindings";
import type { AnyDefinition, NamedDefinition } from "~/lib/definition";
import { AGENT_DEFINITION, AGENT_PROMPT, SANDBOX_HANDLE } from "~/lib/handles";
import type { DefinitionLaunch, Launched } from "~/lib/launcher";
import { deferredStream } from "~/lib/managers/agent-turns";
import type { AgentTurns } from "~/lib/managers/agents";
import { inputSnapshot } from "~/lib/managers/agents";
import { WORKSPACE_METHODS } from "~/lib/managers/workspaces";
import { current } from "~/lib/run-scope";
import type {
  Agent,
  AgentDefinition,
  AgentLike,
  AgentRoute,
  AgentSettings,
  ArtifactDefinition,
  ArtifactFiles,
  ArtifactInstance,
  ArtifactVersion,
  ArtifactWriteOptions,
  DeferredAgent,
  SandboxDefinition,
  SandboxHandle,
  SandboxInstance,
  SessionReply,
  WorkspaceDefinition,
  WorkspaceHandle,
  WorkspaceInstance,
} from "~/lib/types";
import type { InstanceRuntime, Scope } from "./runtime";
import {
  captureScope,
  instanceRoot,
  instanceRuntime,
  launchingRuntime,
  ownRun,
  scriptCatalog,
} from "./runtime";

function inRun(): { bindings: Bindings; args: ManagerArgs } | undefined {
  const store = current.getStore();
  return (
    store && {
      args: { frame: store.frame, scope: store.scope, write: store.write },
      bindings: store.bindings,
    }
  );
}

function turnsOf(bindings: Bindings, args?: ManagerArgs): AgentTurns {
  if (!bindings.turns) {
    throw new Error(
      "this engine cannot run an agent's own turns; use agents.session"
    );
  }
  return bindings.turns(args);
}

const ROUTE_KEYS = ["model", "provider"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prior = merged[key];
    merged[key] =
      isPlainObject(prior) && isPlainObject(value)
        ? deepMerge(prior, value)
        : value;
  }
  return merged;
}

function mergeSettings(
  base: AgentSettings<Output.Output> | undefined,
  over: AgentSettings<Output.Output> | undefined
): AgentSettings<Output.Output> | undefined {
  if (over === undefined) {
    return base;
  }
  const { output, ...rest } = over;
  const merged = deepMerge(base ?? {}, rest);
  return Object.hasOwn(over, "output") ? { ...merged, output } : merged;
}

function routeOf(changes: AgentRoute): AgentRoute {
  return Object.fromEntries(
    ROUTE_KEYS.filter((key) => Object.hasOwn(changes, key)).map((key) => [
      key,
      changes[key],
    ])
  );
}

function pinned(route: AgentRoute): AgentRoute {
  return Object.fromEntries(
    ROUTE_KEYS.flatMap((key) =>
      route[key] === undefined ? [] : [[key, route[key]]]
    )
  );
}

type AgentChanges<OUTPUT extends Output.Output = Output.Output> = Pick<
  AgentDefinition<OUTPUT>,
  "model" | "provider" | "settings"
>;

function invocable<INSTANCE extends AgentLike<Output.Output>>(
  target: object,
  extend: (changes: AgentChanges) => AgentLike<Output.Output>
): INSTANCE {
  const self = target as AgentLike<Output.Output>;
  const scope = captureScope();
  const generate = <CALL extends Output.Output>(
    input: SessionInput,
    options?: TurnOptions<CALL>
  ): Promise<SessionReply<CALL>> => {
    const run = inRun();
    if (run) {
      return turnsOf(run.bindings, run.args).generate(self, input, options);
    }
    return scope(instanceRuntime).then((runtime) =>
      turnsOf(runtime.bindings).generate(self, input, options)
    );
  };
  const stream = <CALL extends Output.Output>(
    input: SessionInput,
    options?: TurnOptions<CALL>
  ): SessionStream<CALL> => {
    const run = inRun();
    if (run) {
      return turnsOf(run.bindings, run.args).stream(self, input, options);
    }
    return deferredStream(
      scope(instanceRuntime).then((runtime) =>
        turnsOf(runtime.bindings).stream(self, input, options)
      )
    );
  };
  return Object.defineProperties(target, {
    extend: { value: extend },
    generate: { value: generate },
    stream: { value: stream },
  }) as INSTANCE;
}

export function agentInstance<OUTPUT extends Output.Output>(
  definition: AgentDefinition<OUTPUT>
): Agent<OUTPUT> {
  const self = definition as AgentDefinition<Output.Output>;
  const extend = <NEXT extends Output.Output = OUTPUT>(
    changes: AgentChanges<NEXT>
  ): Agent<NEXT> => {
    const merged = mergeSettings(
      self.settings,
      changes.settings as AgentSettings<Output.Output> | undefined
    );
    return agentInstance({
      ...self,
      ...routeOf(changes),
      ...(merged === undefined ? {} : { settings: merged }),
    }) as unknown as Agent<NEXT>;
  };
  return invocable<Agent<OUTPUT>>(
    definition,
    extend as (changes: AgentChanges) => Agent<Output.Output>
  );
}

interface AgentFields<OUTPUT extends Output.Output> extends AgentRoute {
  readonly mcp?: AgentDefinition<OUTPUT>["mcp"];
  readonly prompt: string | PortablePrompt;
  readonly settings?: AgentSettings<OUTPUT>;
  readonly skills?: AgentDefinition<OUTPUT>["skills"];
}

export interface AgentDeclaration<OUTPUT extends Output.Output = never>
  extends AgentFields<OUTPUT> {
  readonly name?: string;
}

export interface AgentSpec<OUTPUT extends Output.Output = never>
  extends AgentFields<OUTPUT> {
  readonly name?: never;
}

export type DefineAgent<
  OUTPUT extends Output.Output = never,
  INPUT = undefined,
> = (
  route: AgentRoute,
  input: INPUT | undefined
) => AgentSpec<OUTPUT> | Promise<AgentSpec<OUTPUT>>;

interface AgentRecipe {
  readonly define: DefineAgent<Output.Output, unknown>;
  readonly id: string;
  readonly input?: unknown;
  readonly route: AgentRoute;
  readonly settings: readonly (AgentSettings<Output.Output> | undefined)[];
}

export function promptFields(
  prompt: string | PortablePrompt
): Pick<AgentDefinition, "prompt" | typeof AGENT_PROMPT> {
  return typeof prompt === "string"
    ? { prompt }
    : {
        [AGENT_PROMPT]: (harness) => prompt.render(harness).text,
        prompt: prompt.text,
      };
}

function checkedSpec(id: string, value: unknown): AgentSpec<Output.Output> {
  if (!isPlainObject(value)) {
    throw new Error(`agent "${id}": its function must return a definition`);
  }
  if (Object.hasOwn(value, "name")) {
    throw new Error(
      `agent "${id}": its function cannot name it; the id is fixed when agent() is called`
    );
  }
  const { prompt } = value;
  if (
    !(
      (typeof prompt === "string" || prompt instanceof PortablePrompt) &&
      promptFields(prompt).prompt.trim()
    )
  ) {
    throw new Error(`agent "${id}": its function returned no prompt`);
  }
  return value as unknown as AgentSpec<Output.Output>;
}

async function buildRecipe(
  recipe: AgentRecipe,
  kept: AgentRoute,
  input: unknown
): Promise<AgentDefinition<Output.Output>> {
  const route = { ...pinned(kept), ...pinned(recipe.route) };
  const spec = checkedSpec(recipe.id, await recipe.define(route, input));
  for (const key of ROUTE_KEYS) {
    const wanted = route[key];
    const returned = spec[key];
    if (wanted !== undefined && returned !== undefined && returned !== wanted) {
      throw new Error(
        `agent "${recipe.id}": its function returned ${key} "${returned}" for a session on ${key} "${wanted}"; choose from the route it is given`
      );
    }
  }
  const settings = recipe.settings.reduce(
    (merged, over) => mergeSettings(merged, over),
    spec.settings
  );
  return {
    ...spec,
    ...promptFields(spec.prompt),
    ...route,
    id: recipe.id,
    kind: "agent",
    ...(settings === undefined ? {} : { settings }),
  };
}

function inputOf(
  id: string,
  changes: { readonly input?: unknown },
  prior: unknown
): unknown {
  if (!Object.hasOwn(changes, "input")) {
    return prior;
  }
  if (changes.input === undefined) {
    return;
  }
  try {
    return inputSnapshot(changes.input);
  } catch (error) {
    throw new Error(
      `agent "${id}": extend's input must be JSON, so a session can keep it (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
}

export function recipeInstance<OUTPUT extends Output.Output, INPUT>(
  recipe: AgentRecipe
): DeferredAgent<OUTPUT, INPUT> {
  const extend = <NEXT extends Output.Output = OUTPUT>(
    changes: AgentChanges<NEXT> & { readonly input?: INPUT }
  ): DeferredAgent<NEXT, INPUT> => {
    const input = inputOf(recipe.id, changes, recipe.input);
    return recipeInstance<NEXT, INPUT>({
      define: recipe.define,
      id: recipe.id,
      ...(input === undefined ? {} : { input }),
      route: { ...recipe.route, ...routeOf(changes) },
      settings: [
        ...recipe.settings,
        changes.settings as AgentSettings<Output.Output> | undefined,
      ],
    });
  };
  const data = {
    id: recipe.id,
    ...(recipe.input === undefined ? {} : { input: recipe.input }),
    kind: "agent",
    ...pinned(recipe.route),
  };
  Object.defineProperty(data, AGENT_DEFINITION, {
    value: (kept: AgentRoute, input: unknown) =>
      buildRecipe(recipe, kept, input),
  });
  return invocable<DeferredAgent<OUTPUT, INPUT>>(
    data,
    extend as (changes: AgentChanges) => DeferredAgent<Output.Output, INPUT>
  );
}

export function runDefinition(
  definition: AnyDefinition,
  input: unknown,
  scope: Scope = (work) => work()
): Promise<unknown> {
  const running = current.getStore();
  return running
    ? running.run(definition, input)
    : scope(instanceRuntime).then((runtime) =>
        runtime.execute(definition, input)
      );
}

function quiet(launched: Launched<unknown>): Launched<unknown> {
  launched.result.catch(() => undefined);
  return launched;
}

export function launchDefinition(
  definition: AnyDefinition,
  input: unknown,
  scope: Scope = (work) => work(),
  options: DefinitionLaunch = {}
): Promise<Launched<unknown>> {
  const running = ownRun();
  const runs = running?.bindings.runs;
  if (running !== undefined && runs !== undefined) {
    return runs({
      frame: running.frame,
      scope: running.scope,
      write: running.write,
    })
      .launch(definition, input, options)
      .then(quiet);
  }
  return scope(instanceRuntime)
    .then((runtime) => runtime.launchDefinition(definition, input, options))
    .then(quiet);
}

type Kind = AnyDefinition["kind"];

function launchable(
  kind: Kind,
  name: string,
  found: NamedDefinition | undefined
): NamedDefinition {
  const word = `${kind}.launch(${JSON.stringify(name)})`;
  if (found === undefined) {
    throw new Error(
      `${word}: this workspace declares no step or workflow named ${JSON.stringify(name)}`
    );
  }
  if (found.kind !== kind) {
    throw new Error(
      `${word}: ${JSON.stringify(name)} is a ${found.kind}, not a ${kind}; use ${found.kind}.launch(${JSON.stringify(name)})`
    );
  }
  return found;
}

export async function launchNamed(
  kind: Kind,
  name: unknown,
  input: unknown,
  options: DefinitionLaunch = {}
): Promise<Launched<unknown>> {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(
      `${kind}.launch(): give it the name of a ${kind} the workspace declares`
    );
  }
  const running = ownRun();
  const runs = running?.bindings.runs;
  if (running !== undefined && runs !== undefined) {
    const scoped = runs({
      frame: running.frame,
      scope: running.scope,
      write: running.write,
    });
    const found = scoped.named(name) ?? scriptCatalog()?.definitions.get(name);
    return await scoped
      .launch(launchable(kind, name, found), input, options)
      .then(quiet);
  }
  const { declared, runtime } = await launchingRuntime(`${kind}.launch()`);
  const definition = launchable(
    kind,
    name,
    runtime.definition(name) ?? declared?.definitions.get(name)
  );
  return quiet(await runtime.launchDefinition(definition, input, options));
}

export function workspaceInstance(
  definition: WorkspaceDefinition
): WorkspaceInstance {
  const scope = captureScope();
  const root = () =>
    resolve(inRun()?.bindings.root ?? scope(instanceRoot), definition.path);
  const loaded = (): Promise<WorkspaceHandle> => {
    const run = inRun();
    return run
      ? run.bindings.workspaces(run.args).load(definition)
      : scope(instanceRuntime).then(({ workspaces }) =>
          workspaces.load(definition)
        );
  };
  const git = new Proxy({} as Git, {
    get(_target, property) {
      if (property === "root") {
        return root();
      }
      return (...args: unknown[]) =>
        loaded().then((handle) => {
          const method = Reflect.get(handle.git, property) as (
            ...values: unknown[]
          ) => unknown;
          return method.apply(handle.git, args);
        });
    },
  });
  const methods = Object.fromEntries(
    WORKSPACE_METHODS.map((name) => [
      name,
      {
        value: (...args: unknown[]) =>
          loaded().then((handle) =>
            (Reflect.get(handle, name) as (...values: unknown[]) => unknown)(
              ...args
            )
          ),
      },
    ])
  );
  return Object.defineProperties(definition, {
    ...methods,
    git: { get: () => git },
    root: { get: root },
  }) as WorkspaceInstance;
}

const SANDBOX_FACETS = {
  commands: "commands",
  filesystem: "files",
  ports: "ports",
  processes: "processes",
  services: "services",
  shell: "shell",
  volumes: "volumes",
} as const satisfies Record<string, keyof SandboxHandle>;

function lazyFacet(
  started: () => Promise<SandboxHandle>,
  facet: keyof SandboxHandle
): object {
  return new Proxy(
    {},
    {
      get:
        (_target, method) =>
        async (...args: unknown[]) => {
          const real = Reflect.get(await started(), facet) as object;
          const call = Reflect.get(real, method) as (
            ...values: unknown[]
          ) => unknown;
          return call.apply(real, args);
        },
    }
  );
}

export function sandboxInstance(
  definition: SandboxDefinition
): SandboxInstance {
  const scope = captureScope();
  const attempts = new WeakMap<AbortSignal, Promise<SandboxHandle>>();
  const outside = new WeakMap<InstanceRuntime, Promise<SandboxHandle>>();
  const started = (): Promise<SandboxHandle> => {
    const run = inRun();
    if (run) {
      const { signal } = run.args.frame;
      let handle = attempts.get(signal);
      if (!handle) {
        handle = run.bindings.sandboxes(run.args).start(definition);
        attempts.set(signal, handle);
      }
      return handle;
    }
    return scope(instanceRuntime).then((runtime) => {
      let handle = outside.get(runtime);
      if (!handle) {
        handle = runtime.sandboxes.start(definition);
        outside.set(runtime, handle);
      }
      return handle;
    });
  };
  const close = async (): Promise<void> => {
    const run = inRun();
    const cache = (run ? attempts : outside) as WeakMap<
      object,
      Promise<SandboxHandle>
    >;
    const key = run ? run.args.frame.signal : await scope(instanceRuntime);
    const handle = cache.get(key);
    cache.delete(key);
    await (await handle)?.close();
  };
  const facets = Object.fromEntries(
    Object.entries(SANDBOX_FACETS).map(([name, facet]) => [
      name,
      lazyFacet(started, facet),
    ])
  );
  const methods: Record<PropertyKey, unknown> = {
    ...facets,
    close,
    exec: (...args: Parameters<SandboxHandle["exec"]>) =>
      started().then((handle) => handle.exec(...args)),
    [SANDBOX_HANDLE]: started,
  };
  return new Proxy(definition, {
    get: (target, property) =>
      Object.hasOwn(methods, property)
        ? methods[property]
        : Reflect.get(target, property, target),
  }) as SandboxInstance;
}

export function artifactInstance(
  definition: ArtifactDefinition
): ArtifactInstance {
  const scope = captureScope();
  const write = (
    files: ArtifactFiles,
    options?: ArtifactWriteOptions
  ): Promise<ArtifactVersion> => {
    const run = inRun();
    return run
      ? run.bindings.artifacts(run.args).write(definition, files, options)
      : scope(instanceRuntime).then(({ artifacts }) =>
          artifacts.write(definition, files, options)
        );
  };
  const latest = () => {
    const run = inRun();
    return run
      ? run.bindings.artifacts(run.args).latest(definition)
      : scope(instanceRuntime).then(({ artifacts }) =>
          artifacts.latest(definition)
        );
  };
  return Object.defineProperties(definition, {
    latest: { value: latest },
    write: { value: write },
  }) as ArtifactInstance;
}
