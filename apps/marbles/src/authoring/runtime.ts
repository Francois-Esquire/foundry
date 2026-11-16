import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskStore } from "@foundry/tasks";
import type { Catalog } from "~/authoring/catalog";
import { catalog } from "~/authoring/catalog";
import { newLoad } from "~/authoring/load-tag";
import { initializeUsage } from "~/authoring/usage";
import type { Engine } from "~/lib/engine";
import { activeContext } from "~/lib/execution-context";

export type InstanceRuntime = Pick<
  Engine,
  | "agents"
  | "artifacts"
  | "bindings"
  | "dispose"
  | "disposed"
  | "execute"
  | "sandboxes"
  | "taskStore"
  | "workspaceId"
  | "workspaces"
>;

interface Hosting {
  readonly catalog: Catalog;
  readonly id: string;
  readonly runtime: InstanceRuntime | undefined;
}

const hostings = new Map<string, Hosting>();
const released = new Set<string>();
const loads = new Map<
  number,
  { readonly catalog: Catalog; readonly workspaceId: string }
>();
type Route = { readonly load: number } | { readonly workspaceId: string };

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
  const route: Route | undefined =
    context === undefined
      ? routeScope.getStore()
      : { workspaceId: context.workspaceId };
  return route === undefined
    ? (work) => work()
    : (work) => routeScope.run(route, work);
}

export function refuseUnnamedWork(): void {
  unnamedRefused = true;
}

export async function loadInto<T>(
  workspaceId: string,
  into: Catalog,
  load: (n: number) => Promise<T>
): Promise<T> {
  const n = newLoad();
  loads.set(n, { catalog: into, workspaceId });
  if (liveHosting(workspaceId) === undefined) {
    hostings.set(workspaceId, {
      catalog: into,
      id: workspaceId,
      runtime: undefined,
    });
    released.delete(workspaceId);
  }
  importing += 1;
  try {
    return await load(n);
  } catch (error) {
    into.reset();
    abandonHost(workspaceId);
    throw error;
  } finally {
    importing -= 1;
  }
}

export function setHost(runtime: InstanceRuntime, declared?: Catalog): void {
  const hosting = hostings.get(runtime.workspaceId);
  hostings.set(runtime.workspaceId, {
    catalog: declared ?? hosting?.catalog ?? catalog,
    id: runtime.workspaceId,
    runtime,
  });
  released.delete(runtime.workspaceId);
  hostState = "hosted";
}

export function expectHost(): void {
  hostState = "loading";
}

export function abandonHost(workspaceId: string): void {
  if (hostings.get(workspaceId)?.runtime === undefined) {
    hostings.delete(workspaceId);
    released.add(workspaceId);
  }
}

function liveHosting(id: string): Hosting | undefined {
  const hosting = hostings.get(id);
  if (hosting?.runtime?.disposed) {
    hostings.delete(id);
    released.add(id);
    return;
  }
  return hosting;
}

class AmbiguousWorkspaceError extends Error {
  override readonly name = "AmbiguousWorkspaceError";
}

class WorkspaceReleasedError extends Error {
  override readonly name = "WorkspaceReleasedError";
}

function releasedError(id: string): WorkspaceReleasedError {
  return new WorkspaceReleasedError(
    `workspace ${id} is no longer hosted in this process: its host closed, so nothing it started outlives it here; nothing was read, written or declared`
  );
}

function namedWorkspace(): string | undefined {
  const named = activeContext()?.workspaceId;
  if (named !== undefined) {
    return named;
  }
  const route = routeScope.getStore();
  if (route === undefined) {
    return;
  }
  return "workspaceId" in route
    ? route.workspaceId
    : loads.get(route.load)?.workspaceId;
}

function unnamedError(): AmbiguousWorkspaceError {
  return new AmbiguousWorkspaceError(
    "this call names no workspace: it comes from outside every workspace's runs, observers and modules (a package, or Marbles itself), and this process hosts several, so none of them answers it"
  );
}

function hostingNow(): Hosting | undefined {
  const named = namedWorkspace();
  if (named !== undefined) {
    const hosting = liveHosting(named);
    if (hosting !== undefined) {
      return hosting;
    }
    if (released.has(named)) {
      throw releasedError(named);
    }
  }
  if (named === undefined && unnamedRefused) {
    throw unnamedError();
  }
  const hosted = [...hostings.keys()].flatMap((id) => {
    const live = liveHosting(id);
    return live === undefined ? [] : [live];
  });
  if (hosted.length > 1) {
    throw new AmbiguousWorkspaceError(
      `this process hosts ${String(hosted.length)} workspaces (${hosted.map((each) => each.id).join(", ")}), and this call names none of them: it runs outside their runs, observers and modules, so none of them answers it`
    );
  }
  return hosted[0];
}

export function declaringCatalog(): Catalog {
  const route = routeScope.getStore();
  const workspaceId =
    activeContext()?.workspaceId ??
    (route !== undefined && "workspaceId" in route
      ? route.workspaceId
      : undefined);
  if (workspaceId !== undefined) {
    const hosting = liveHosting(workspaceId);
    if (hosting !== undefined) {
      return hosting.catalog;
    }
    if (released.has(workspaceId)) {
      throw releasedError(workspaceId);
    }
    return catalog;
  }
  const owner =
    route !== undefined && "load" in route ? loads.get(route.load) : undefined;
  if (owner !== undefined) {
    return owner.catalog;
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
  return hostingNow()?.runtime;
}

export function hostTaskStore(): TaskStore | undefined {
  const hosting = hostingNow();
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
