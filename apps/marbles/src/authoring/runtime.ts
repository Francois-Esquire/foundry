import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskStore } from "@foundry/tasks";
import type { Catalog } from "~/authoring/catalog";
import { catalog } from "~/authoring/catalog";
import { newLoad } from "~/authoring/load-tag";
import { initializeUsage } from "~/authoring/usage";
import type { Engine } from "~/lib/engine";
import type { ExecutionContext } from "~/lib/execution-context";
import { activeContext } from "~/lib/execution-context";

export type InstanceRuntime = Pick<
  Engine,
  | "agents"
  | "artifacts"
  | "bindings"
  | "context"
  | "dispose"
  | "disposed"
  | "execute"
  | "sandboxes"
  | "taskStore"
  | "workspaceId"
  | "workspaces"
>;

interface Binding {
  catalog: Catalog | undefined;
  released: boolean;
  runtime: InstanceRuntime | undefined;
  readonly workspaceId: string;
}

const bound = new Set<Binding>();

function isReleased(binding: Binding): boolean {
  if (!binding.released && binding.runtime?.disposed !== false) {
    binding.released = true;
    binding.runtime = undefined;
    binding.catalog = undefined;
    bound.delete(binding);
  }
  return binding.released;
}

function liveBindings(workspaceId: string): Binding[] {
  return [...bound].filter(
    (binding) => binding.workspaceId === workspaceId && !isReleased(binding)
  );
}

const contextBindings = new WeakMap<ExecutionContext, Binding>();

interface Hosting {
  readonly binding: Binding | undefined;
  readonly catalog: Catalog;
  readonly id: string;
}

const hostings = new Map<string, Hosting>();
const released = new Set<string>();
interface Load {
  abandoned: boolean;
  binding: Binding | undefined;
  readonly catalog: Catalog;
  readonly workspaceId: string;
}

const loads = new Map<number, Load>();
const retired = new Set<number>();

function sweep(): void {
  for (const binding of [...bound]) {
    isReleased(binding);
  }
  for (const [number, load] of loads) {
    if (load.abandoned || load.binding?.released === true) {
      loads.delete(number);
      retired.add(number);
    }
  }
  for (const id of [...hostings.keys()]) {
    liveHosting(id);
  }
}
type Route =
  | { readonly load: number }
  | { readonly binding: Binding }
  | { readonly workspaceId: string };

const routeScope = new AsyncLocalStorage<Route>();
let unnamedRefused = false;
let importing = 0;
let hostState: "unhosted" | "loading" | "hosted" = "unhosted";
let fallback: Promise<InstanceRuntime> | undefined;
let createFallback: () => Promise<InstanceRuntime> = async () => {
  const { createDefaultEngine } = await import("~/create");
  const engine = createDefaultEngine();
  const problems =
    (await engine.providers
      ?.refresh()
      .catch((error: unknown) => [String(error)])) ?? [];
  for (const problem of problems) {
    process.stderr.write(`[providers] ${problem}\n`);
  }
  return engine;
};

export function inLoad<T>(load: number, work: () => T): T {
  return routeScope.run({ load }, work);
}

export type Scope = <T>(work: () => T) => T;

export function captureScope(): Scope {
  const context = activeContext();
  let route: Route | undefined;
  if (context === undefined) {
    route = routeScope.getStore();
  } else {
    const binding = contextBindings.get(context);
    route =
      binding === undefined
        ? { workspaceId: context.workspaceId }
        : { binding };
  }
  if (route === undefined) {
    return (work) => work();
  }
  const kept = route;
  return (work) => routeScope.run(kept, work);
}

export function refuseUnnamedWork(): void {
  unnamedRefused = true;
}

export async function loadInto<T>(
  workspaceId: string,
  into: Catalog,
  load: (n: number) => Promise<T>
): Promise<T> {
  sweep();
  const n = newLoad();
  const loaded: Load = {
    abandoned: false,
    binding: undefined,
    catalog: into,
    workspaceId,
  };
  loads.set(n, loaded);
  if (liveHosting(workspaceId) === undefined) {
    hostings.set(workspaceId, {
      binding: undefined,
      catalog: into,
      id: workspaceId,
    });
    released.delete(workspaceId);
  }
  importing += 1;
  try {
    return await load(n);
  } catch (error) {
    into.reset();
    abandonHost(workspaceId, into);
    throw error;
  } finally {
    importing -= 1;
  }
}

export function setHost(runtime: InstanceRuntime, declared?: Catalog): void {
  sweep();
  const hosting = hostings.get(runtime.workspaceId);
  const taken = declared ?? hosting?.catalog ?? catalog;
  const binding: Binding = {
    catalog: taken,
    released: false,
    runtime,
    workspaceId: runtime.workspaceId,
  };
  bound.add(binding);
  contextBindings.set(runtime.context, binding);
  hostings.set(runtime.workspaceId, {
    binding,
    catalog: taken,
    id: runtime.workspaceId,
  });
  for (const load of loads.values()) {
    if (
      load.workspaceId === runtime.workspaceId &&
      load.catalog === taken &&
      load.binding === undefined &&
      !load.abandoned
    ) {
      load.binding = binding;
    }
  }
  released.delete(runtime.workspaceId);
  hostState = "hosted";
}

export function releaseEngine(runtime: InstanceRuntime): void {
  if (!runtime.disposed) {
    return;
  }
  sweep();
}

export function expectHost(): void {
  hostState = "loading";
}

export function abandonHost(workspaceId: string, given: Catalog): void {
  for (const load of loads.values()) {
    if (
      load.workspaceId === workspaceId &&
      load.catalog === given &&
      load.binding === undefined
    ) {
      load.abandoned = true;
    }
  }
  if (hostings.get(workspaceId)?.binding === undefined) {
    hostings.delete(workspaceId);
    released.add(workspaceId);
  }
}

type Owner =
  | { readonly binding: Binding }
  | { readonly load: Load }
  | { readonly workspaceId: string };

function owner(): Owner | undefined {
  const context = activeContext();
  if (context !== undefined) {
    const binding = contextBindings.get(context);
    return binding === undefined
      ? { workspaceId: context.workspaceId }
      : { binding };
  }
  const route = routeScope.getStore();
  if (route === undefined || !("load" in route)) {
    return route;
  }
  if (retired.has(route.load)) {
    throw releasedError();
  }
  const load = loads.get(route.load);
  if (load === undefined) {
    return;
  }
  if (load.abandoned) {
    throw releasedError(load.workspaceId);
  }
  return load.binding === undefined ? { load } : { binding: load.binding };
}

function live(binding: Binding): {
  readonly catalog: Catalog;
  readonly runtime: InstanceRuntime;
} {
  const { catalog: taken, runtime } = binding;
  if (isReleased(binding) || taken === undefined || runtime === undefined) {
    throw releasedError(binding.workspaceId);
  }
  return { catalog: taken, runtime };
}

function soleHosting(workspaceId: string): Hosting | undefined {
  const alive = liveBindings(workspaceId);
  if (alive.length > 1) {
    throw new AmbiguousWorkspaceError(
      `this call names workspace ${workspaceId} and no engine of it, and ${String(alive.length)} of its engines are running here (one still finishing its runs beside the one that replaced it), so none of them answers it`
    );
  }
  return liveHosting(workspaceId);
}

function namedBy(
  own: { readonly load: Load } | { readonly workspaceId: string } | undefined
): string | undefined {
  if (own === undefined) {
    return;
  }
  return "load" in own ? own.load.workspaceId : own.workspaceId;
}

interface Answer {
  readonly catalog: Catalog;
  readonly id: string;
  readonly runtime: InstanceRuntime | undefined;
}

function liveHosting(id: string): Hosting | undefined {
  const hosting = hostings.get(id);
  if (hosting?.binding !== undefined && isReleased(hosting.binding)) {
    hostings.delete(id);
    released.add(id);
    return;
  }
  return hosting;
}

function answerOf(hosting: Hosting): Answer {
  return {
    catalog: hosting.catalog,
    id: hosting.id,
    runtime: hosting.binding?.runtime,
  };
}

function refuseUnbound(workspaceId: string): void {
  if (liveBindings(workspaceId).length > 0) {
    throw new AmbiguousWorkspaceError(
      `this call comes from a run of an engine of workspace ${workspaceId} that no host here bound, and another engine is bound to that workspace here, so neither answers it`
    );
  }
  if (released.has(workspaceId)) {
    throw releasedError(workspaceId);
  }
}

class AmbiguousWorkspaceError extends Error {
  override readonly name = "AmbiguousWorkspaceError";
}

class WorkspaceReleasedError extends Error {
  override readonly name = "WorkspaceReleasedError";
}

function releasedError(id?: string): WorkspaceReleasedError {
  const named =
    id === undefined ? "the workspace this work belongs to" : `workspace ${id}`;
  return new WorkspaceReleasedError(
    `${named} is no longer hosted in this process: its host closed, so nothing it started outlives it here; nothing was read, written or declared`
  );
}

function unnamedError(): AmbiguousWorkspaceError {
  return new AmbiguousWorkspaceError(
    "this call names no workspace: it comes from outside every workspace's runs, observers and modules (a package, or Marbles itself), and this process hosts several, so none of them answers it"
  );
}

function answering(): Answer | undefined {
  const own = owner();
  if (own !== undefined && "binding" in own) {
    const { catalog: taken, runtime } = live(own.binding);
    return { catalog: taken, id: runtime.workspaceId, runtime };
  }
  if (own !== undefined && "workspaceId" in own) {
    refuseUnbound(own.workspaceId);
    return undefined;
  }
  const named = namedBy(own);
  if (named !== undefined) {
    const hosting = soleHosting(named);
    if (hosting !== undefined) {
      return answerOf(hosting);
    }
    if (released.has(named)) {
      throw releasedError(named);
    }
  }
  if (named === undefined && unnamedRefused) {
    throw unnamedError();
  }
  const hosted = [...hostings.keys()].flatMap((id) => {
    const each = liveHosting(id);
    return each === undefined ? [] : [each];
  });
  if (hosted.length > 1) {
    throw new AmbiguousWorkspaceError(
      `this process hosts ${String(hosted.length)} workspaces (${hosted.map((each) => each.id).join(", ")}), and this call names none of them: it runs outside their runs, observers and modules, so none of them answers it`
    );
  }
  const [only] = hosted;
  if (only === undefined) {
    return;
  }
  const sole = soleHosting(only.id);
  return sole === undefined ? undefined : answerOf(sole);
}

export function declaringCatalog(): Catalog {
  const own = owner();
  if (own !== undefined) {
    if ("binding" in own) {
      return live(own.binding).catalog;
    }
    if ("load" in own) {
      return own.load.catalog;
    }
    refuseUnbound(own.workspaceId);
    return catalog;
  }
  if (importing > 0) {
    throw new AmbiguousWorkspaceError(
      "this declaration comes from a package, which one process shares between every workspace it hosts, while a workspace's source loads, so it belongs to none of them. A package's module has no workspace of its own: export a function that takes the words it uses and call it from the workspace's source with that source's own, as in `export const make = ({ step }) => step(\"helper\").do(…)` and `make({ step })`"
    );
  }
  if (unnamedRefused) {
    throw unnamedError();
  }
  return catalog;
}

function activeHost(): InstanceRuntime | undefined {
  return answering()?.runtime;
}

export function hostTaskStore(): TaskStore | undefined {
  const hosting = answering();
  if (hosting === undefined && hostState === "unhosted") {
    return;
  }
  if (hosting?.runtime !== undefined) {
    return hosting.runtime.taskStore;
  }
  if (hosting !== undefined || hostState === "loading") {
    throw new Error(
      "tasks: the workspace's tasks are not available while its source loads; use them in a step, an observe handler, or once the host has started"
    );
  }
  throw new Error(
    "tasks: the workspace host that held these tasks was disposed; nothing was read or written"
  );
}

export function setDefaultRuntime(
  create: () => Promise<InstanceRuntime>
): void {
  createFallback = create;
}

/**
 * The root a definition outside a run resolves paths against: the host's
 * workspace root, else the directory the default runtime would use.
 */
export function instanceRoot(): string {
  return activeHost()?.bindings.root ?? process.cwd();
}

/** The host's engine, else the default runtime, built once. */
export function instanceRuntime(): Promise<InstanceRuntime> {
  let runtime: InstanceRuntime | undefined;
  try {
    runtime = activeHost();
  } catch (error) {
    return Promise.reject(error);
  }
  if (runtime) {
    return Promise.resolve(runtime);
  }
  if (!fallback) {
    // A step it runs may query `usage`; its default accounts come first.
    fallback = Promise.all([createFallback(), initializeUsage()]).then(
      ([created]) => created
    );
    // A script that never calls `dispose` still exits once its work is
    // done, unless something the runtime started holds the process open.
    process.once("beforeExit", () => {
      dispose().catch(() => undefined);
    });
  }
  return fallback;
}

/**
 * Close the default runtime: its models (a Codex provider holds a child
 * process), workspaces, and sandboxes. A script that used a definition
 * outside a run calls it before exiting; the next call builds a new one.
 */
export async function dispose(): Promise<void> {
  const pending = fallback;
  fallback = undefined;
  if (pending) {
    await (await pending).dispose();
  }
}
