import type { TurnOptions } from "@foundry/agents/harness";
import type { SessionInput, SessionStream } from "@foundry/agents/session";
import { PortablePrompt } from "@foundry/prompts";
import type { Git } from "@foundry/workspaces/node/git";
import type { Output } from "ai";
import type { AnyDefinition } from "~/lib/definitions";
import type { Bindings, ManagerArgs } from "~/lib/definitions/bindings";
import {
  AGENT_DEFINITION,
  AGENT_META,
  AGENT_PROMPT,
  SANDBOX_HANDLE,
} from "~/lib/definitions/handles";
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
} from "~/lib/definitions/types";
import type { AgentTurns } from "~/lib/managers/agents";
import { deferredStream } from "~/lib/managers/deferred-stream";
import { WORKSPACE_METHODS } from "~/lib/managers/workspace-methods";
import type { DefinitionLaunch, Launched } from "~/lib/runs";
import { inputSnapshot } from "~/lib/shared/json-data";
import type { InstanceRuntime, Scope } from "./runtime";
import {
  activeAgentId,
  captureScope,
  enqueuingRuntime,
  instanceRoot,
  instanceRuntime,
  ownRun,
} from "./runtime";

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

function resolvePath(base: string, target: string): string {
  const normalizedBase = base.replaceAll("\\", "/");
  const normalizedTarget = target.replaceAll("\\", "/");
  const absoluteTarget =
    normalizedTarget.startsWith("/") || DRIVE_PATH.test(normalizedTarget);
  const raw = absoluteTarget
    ? normalizedTarget
    : `${normalizedBase}/${normalizedTarget}`;
  const drive = DRIVE_PATH.test(raw) ? raw.slice(0, 2) : "";
  const rest = drive ? raw.slice(2) : raw;
  const rooted = rest.startsWith("/");
  const stack: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (stack.length > 0 && stack.at(-1) !== "..") {
        stack.pop();
      } else if (!rooted) {
        stack.push("..");
      }
      continue;
    }
    stack.push(part);
  }
  const joined =
    `${rooted ? "/" : ""}${stack.join("/")}` || (rooted ? "/" : ".");
  return `${drive}${joined}`;
}

function inRun(): { bindings: Bindings; args: ManagerArgs } | undefined {
  const store = ownRun();
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

export interface AgentMeta {
  readonly define?: object;
  readonly digest: string;
  readonly explicit: boolean;
  readonly recipe?: AgentRecipe;
  readonly root?: object;
}

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
  definition: AgentDefinition<OUTPUT>,
  meta?: AgentMeta
): Agent<OUTPUT> {
  const baseId = definition.id;
  const self = definition as AgentDefinition<Output.Output>;
  const storedMeta =
    meta === undefined ? undefined : { ...meta, root: meta.root ?? definition };
  const extend = <NEXT extends Output.Output = OUTPUT>(
    changes: AgentChanges<NEXT>
  ): Agent<NEXT> => {
    const merged = mergeSettings(
      self.settings,
      changes.settings as AgentSettings<Output.Output> | undefined
    );
    const promptRender = self[AGENT_PROMPT];
    return agentInstance(
      {
        ...self,
        ...(promptRender === undefined ? {} : { [AGENT_PROMPT]: promptRender }),
        ...routeOf(changes),
        id: baseId,
        ...(merged === undefined ? {} : { settings: merged }),
      },
      storedMeta
    ) as unknown as Agent<NEXT>;
  };
  Object.defineProperty(definition, "id", {
    configurable: true,
    enumerable: true,
    get: () => activeAgentId(self) ?? baseId,
  });
  if (storedMeta !== undefined) {
    Object.defineProperty(definition, AGENT_META, { value: storedMeta });
  }
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

export interface AgentRecipe {
  readonly define: DefineAgent<Output.Output, unknown>;
  readonly id: string;
  readonly input?: unknown;
  readonly route: AgentRoute;
  readonly settings: readonly (AgentSettings<Output.Output> | undefined)[];
}

export function promptFields(
  prompt: string | PortablePrompt
): Pick<AgentDefinition, "prompt" | typeof AGENT_PROMPT> {
  if (typeof prompt === "string") {
    return { prompt };
  }
  return {
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
  input: unknown,
  resolvedId?: string
): Promise<AgentDefinition<Output.Output>> {
  const id = resolvedId ?? recipe.id;
  const route = { ...pinned(kept), ...pinned(recipe.route) };
  const spec = checkedSpec(id, await recipe.define(route, input));
  for (const key of ROUTE_KEYS) {
    const wanted = route[key];
    const returned = spec[key];
    if (wanted !== undefined && returned !== undefined && returned !== wanted) {
      throw new Error(
        `agent "${id}": its function returned ${key} "${returned}" for a session on ${key} "${wanted}"; choose from the route it is given`
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
    id,
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
  recipe: AgentRecipe,
  meta?: AgentMeta
): DeferredAgent<OUTPUT, INPUT> {
  const baseId = recipe.id;
  const data: Record<string, unknown> = {
    id: baseId,
    ...(recipe.input === undefined ? {} : { input: recipe.input }),
    kind: "agent",
    ...pinned(recipe.route),
  };
  const self = data as unknown as AgentLike<Output.Output>;
  const nextMeta =
    meta === undefined
      ? undefined
      : { ...meta, recipe, root: meta.root ?? data };
  const extend = <NEXT extends Output.Output = OUTPUT>(
    changes: AgentChanges<NEXT> & { readonly input?: INPUT }
  ): DeferredAgent<NEXT, INPUT> => {
    const id = activeAgentId(self) ?? baseId;
    const input = inputOf(id, changes, recipe.input);
    const updated: AgentRecipe = {
      define: recipe.define,
      id: baseId,
      ...(input === undefined ? {} : { input }),
      route: { ...recipe.route, ...routeOf(changes) },
      settings: [
        ...recipe.settings,
        changes.settings as AgentSettings<Output.Output> | undefined,
      ],
    };
    return recipeInstance<NEXT, INPUT>(updated, nextMeta);
  };
  Object.defineProperty(data, "id", {
    configurable: true,
    enumerable: true,
    get: () => activeAgentId(self) ?? baseId,
  });
  Object.defineProperty(data, AGENT_DEFINITION, {
    value: (kept: AgentRoute, input: unknown, resolvedId?: string) =>
      buildRecipe(recipe, kept, input, resolvedId ?? activeAgentId(self)),
  });
  if (nextMeta !== undefined) {
    Object.defineProperty(data, AGENT_META, { value: nextMeta });
  }
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
  const running = ownRun();
  return running
    ? running.run(definition, input)
    : scope(instanceRuntime).then((runtime) =>
        runtime.execute(definition, input)
      );
}

function quiet(launched: Launched<unknown>): Launched<unknown> {
  launched.result.catch(() => undefined);
  return { id: launched.id, result: launched.result };
}

export function enqueueDefinition(
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
      .enqueue(definition, input, options)
      .then(quiet);
  }
  return scope(instanceRuntime)
    .then((runtime) => runtime.enqueueDefinition(definition, input, options))
    .then(quiet);
}

type Kind = AnyDefinition["kind"];

function enqueueable(
  kind: Kind,
  name: string,
  found: AnyDefinition | undefined
): AnyDefinition {
  const word = `${kind}.enqueue(${JSON.stringify(name)})`;
  if (found === undefined) {
    throw new Error(
      `${word}: this workspace declares no step or workflow named ${JSON.stringify(name)}`
    );
  }
  if (found.kind !== kind) {
    throw new Error(
      `${word}: ${JSON.stringify(name)} is a ${found.kind}, not a ${kind}; use ${found.kind}.enqueue(${JSON.stringify(name)})`
    );
  }
  return found;
}

export async function enqueueNamed(
  kind: Kind,
  name: unknown,
  input: unknown,
  options: DefinitionLaunch = {}
): Promise<Launched<unknown>> {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(
      `${kind}.enqueue(): give it the name of a ${kind} the workspace declares`
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
    const found = scoped.named(name);
    return await scoped
      .enqueue(enqueueable(kind, name, found), input, options)
      .then(quiet);
  }
  const { runtime } = await enqueuingRuntime(`${kind}.enqueue()`);
  const definition = enqueueable(kind, name, runtime.definition(name));
  return quiet(await runtime.enqueueDefinition(definition, input, options));
}

export function workspaceInstance(
  definition: WorkspaceDefinition
): WorkspaceInstance {
  const scope = captureScope();
  const root = () =>
    resolvePath(inRun()?.bindings.root ?? scope(instanceRoot), definition.path);
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
