import { resolve } from "node:path";
import type { TurnOptions } from "@foundry/agents/harness";
import type { SessionInput, SessionStream } from "@foundry/agents/session";
import type { Git } from "@foundry/workspaces/git";
import type { Output } from "ai";

import type { Bindings, ManagerArgs } from "~/lib/bindings";
import type { AnyDefinition } from "~/lib/definition";
import { SANDBOX_HANDLE } from "~/lib/handles";
import { deferredStream } from "~/lib/managers/agent-turns";
import type { AgentTurns } from "~/lib/managers/agents";
import { WORKSPACE_METHODS } from "~/lib/managers/workspaces";
import { current } from "~/lib/run-scope";
import type {
  Agent,
  AgentDefinition,
  AgentSettings,
  ArtifactDefinition,
  ArtifactFiles,
  ArtifactInstance,
  ArtifactVersion,
  ArtifactWriteOptions,
  SandboxDefinition,
  SandboxHandle,
  SandboxInstance,
  SessionReply,
  WorkspaceDefinition,
  WorkspaceHandle,
  WorkspaceInstance,
} from "~/lib/types";
import type { InstanceRuntime } from "./runtime";
import { instanceRoot, instanceRuntime } from "./runtime";

/**
 * What a definition does when it is called rather than locked. Inside a
 * step body the call joins the body's run: it is cancelled with the step,
 * writes to its stream, and is replayed from the ledger. Anywhere else it
 * runs on the host's engine, or a default runtime in a plain script.
 */

/** The step a body runs in, as its managers take it. */
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

/** `over` on top of `base`: plain objects merge, anything else replaces. */
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

/**
 * An extension's settings over the base's. `output` is a plain object too,
 * but one structured output, so it replaces rather than merges.
 */
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

/**
 * Give an agent definition `generate` and `stream`, one turn on a fresh
 * session each, and `extend`. They are not enumerable, so a spread of the
 * agent is a plain definition.
 */
export function agentInstance<OUTPUT extends Output.Output>(
  definition: AgentDefinition<OUTPUT>
): Agent<OUTPUT> {
  const self = definition as AgentDefinition<Output.Output>;
  // The id is copied, not claimed: an extension is the same subject, and
  // the catalog keeps the agent it was declared as.
  const extend = <NEXT extends Output.Output = OUTPUT>(
    changes: Pick<AgentDefinition<NEXT>, "model" | "provider" | "settings">
  ): Agent<NEXT> => {
    // Only the route and settings change, whatever else the object carries.
    const route = Object.fromEntries(
      ROUTE_KEYS.filter((key) => Object.hasOwn(changes, key)).map((key) => [
        key,
        changes[key],
      ])
    );
    const merged = mergeSettings(
      self.settings,
      changes.settings as AgentSettings<Output.Output> | undefined
    );
    return agentInstance({
      ...self,
      ...route,
      ...(merged === undefined ? {} : { settings: merged }),
    }) as unknown as Agent<NEXT>;
  };
  const generate = <CALL extends Output.Output = OUTPUT>(
    input: SessionInput,
    options?: TurnOptions<CALL>
  ): Promise<SessionReply<CALL>> => {
    const run = inRun();
    if (run) {
      return turnsOf(run.bindings, run.args).generate(self, input, options);
    }
    return instanceRuntime().then((runtime) =>
      turnsOf(runtime.bindings).generate(self, input, options)
    );
  };
  const stream = <CALL extends Output.Output = OUTPUT>(
    input: SessionInput,
    options?: TurnOptions<CALL>
  ): SessionStream<CALL> => {
    const run = inRun();
    if (run) {
      return turnsOf(run.bindings, run.args).stream(self, input, options);
    }
    return deferredStream(
      instanceRuntime().then((runtime) =>
        turnsOf(runtime.bindings).stream(self, input, options)
      )
    );
  };
  return Object.defineProperties(definition, {
    extend: { value: extend },
    generate: { value: generate },
    stream: { value: stream },
  }) as Agent<OUTPUT>;
}

/** Direct calls use the current step, or the host engine outside a run. */
export function runDefinition(
  definition: AnyDefinition,
  input: unknown
): Promise<unknown> {
  const running = current.getStore();
  return running
    ? running.run(definition, input)
    : instanceRuntime().then((runtime) => runtime.execute(definition, input));
}

/**
 * Give a workspace definition its handle: `root` resolved against the run's
 * or host's root, and the methods and `git` of the handle `workspaces.load`
 * returns, loaded at first use so nothing is watched until then.
 */
export function workspaceInstance(
  definition: WorkspaceDefinition
): WorkspaceInstance {
  const root = () =>
    resolve(inRun()?.bindings.root ?? instanceRoot(), definition.path);
  const loaded = (): Promise<WorkspaceHandle> => {
    const run = inRun();
    return run
      ? run.bindings.workspaces(run.args).load(definition)
      : instanceRuntime().then(({ workspaces }) => workspaces.load(definition));
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

/** The container facets a declared sandbox reaches; each starts it first. */
const SANDBOX_FACETS = {
  commands: "commands",
  filesystem: "files",
  ports: "ports",
  processes: "processes",
  services: "services",
  shell: "shell",
  volumes: "volumes",
} as const satisfies Record<string, keyof SandboxHandle>;

/** A facet whose every method starts the sandbox, then calls the real one. */
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

/**
 * A declared sandbox you can use: `exec`, `close`, and the container's
 * facets, the first call starting it. In a step body it starts through the
 * step's sandboxes, once per attempt, so a replay reopens the one it
 * started; outside a run, once per runtime. A proxy with only a `get`
 * trap: the record underneath answers `in`, keys, and spreads, so a spec's
 * `files` is never confused with the container's filesystem.
 */
export function sandboxInstance(
  definition: SandboxDefinition
): SandboxInstance {
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
    return instanceRuntime().then((runtime) => {
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
    const key = run ? run.args.frame.signal : await instanceRuntime();
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

/** Give an artifact definition `write`, the same as `artifacts.write(def, files)`. */
export function artifactInstance(
  definition: ArtifactDefinition
): ArtifactInstance {
  const write = (
    files: ArtifactFiles,
    options?: ArtifactWriteOptions
  ): Promise<ArtifactVersion> => {
    const run = inRun();
    return run
      ? run.bindings.artifacts(run.args).write(definition, files, options)
      : instanceRuntime().then(({ artifacts }) =>
          artifacts.write(definition, files, options)
        );
  };
  const latest = () => {
    const run = inRun();
    return run
      ? run.bindings.artifacts(run.args).latest(definition)
      : instanceRuntime().then(({ artifacts }) => artifacts.latest(definition));
  };
  return Object.defineProperties(definition, {
    latest: { value: latest },
    write: { value: write },
  }) as ArtifactInstance;
}
