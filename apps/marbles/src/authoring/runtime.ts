import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskStore } from "@foundry/tasks";
import type { Catalog } from "~/authoring/catalog";
import { catalog } from "~/authoring/catalog";
import { newLoad } from "~/authoring/load-tag";
import { initializeUsage } from "~/authoring/usage";
import type { Engine } from "~/lib/engine";
import { activeContext } from "~/lib/execution-context";

/**
 * Where a definition's instance methods run when they are called outside a
 * step body, and which workspace the builtin `tasks` and the authoring
 * words reach. Inside a body, or an observer's handler, the work's
 * execution context names its workspace, found through async context; a
 * call in a body runs on the body's run and never reaches the slot.
 * Anywhere else a workspace's own code names it by its load: each load's
 * modules import a library of their own whose words run in that load's
 * scope (`inLoad`), and what those words make keeps the scope it was made
 * in (`captureScope`), so a timer, a promise, a listener or a tail call
 * cannot lose it.
 *
 * Both the host and an authoring module import this module, so these
 * slots are one instance per process; every workspace a host here loads
 * or hosts has its own (`Hosting`), keyed by its id.
 */
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

/**
 * One workspace a host in this process loads or hosts: the catalog its
 * source declares into, and the engine bound to answer for it. Its tasks
 * are refused while its source loads, before its engine is bound, and once
 * that engine is disposed, until another is bound. None falls back to
 * memory, which would accept a workspace's write and lose it.
 */
interface Hosting {
  readonly catalog: Catalog;
  readonly id: string;
  readonly runtime: InstanceRuntime | undefined;
}

const hostings = new Map<string, Hosting>();
/**
 * Workspaces whose host here closed or gave them up: work that still names
 * one is refused, never handed to whichever workspace is left.
 */
const released = new Set<string>();
/** Each load's workspace, and the catalog its modules declare into, by load number. */
const loads = new Map<
  number,
  { readonly catalog: Catalog; readonly workspaceId: string }
>();
/**
 * Whom work done later on another's behalf answers to: a load, while its
 * library's words run, or the workspace of the run or observer that made
 * a builder or an instance. Only this identity is kept, never the stores
 * of the run it came from.
 */
type Route = { readonly load: number } | { readonly workspaceId: string };

const routeScope = new AsyncLocalStorage<Route>();
/**
 * Whether work that names no workspace is refused outright, rather than
 * answered by the only workspace hosted here: set by a host of several
 * workspaces, where one closing must never hand its work to another.
 */
let unnamedRefused = false;
/**
 * How many loads are importing now. A declaration that names no workspace
 * meanwhile (a package's module, evaluated once for the whole process) is
 * refused rather than given to one: this counts, it routes nothing.
 */
let importing = 0;
/**
 * Whether this process has been a host: from then on, `tasks` with no
 * workspace to answer are refused rather than kept in memory. `loading`
 * once `expectHost` says a source is about to load, until one is bound.
 */
let hostState: "unhosted" | "loading" | "hosted" = "unhosted";
let fallback: Promise<InstanceRuntime> | undefined;
let createFallback: () => Promise<InstanceRuntime> = async () => {
  const { createDefaultEngine } = await import("~/create");
  const engine = createDefaultEngine();
  // It is never started, so its providers are read, and a provider that
  // lists its models asked, here.
  const problems =
    (await engine.providers
      ?.refresh()
      .catch((error: unknown) => [String(error)])) ?? [];
  for (const problem of problems) {
    process.stderr.write(`[providers] ${problem}\n`);
  }
  return engine;
};

/**
 * Import a workspace's source as load number `n` of this process, every
 * declaration its modules make landing in `into`, that workspace's
 * catalog. `load` imports the modules as that load's copies
 * (`load-tag.ts`), so whatever their code does later, from a timer, a
 * promise or a listener, still names this load and this workspace. Loads
 * may overlap. One that throws leaves nothing in `into`, and its workspace
 * unloaded.
 */
/** Run `work` as load `load`'s, as its library's words do. */
export function inLoad<T>(load: number, work: () => T): T {
  return routeScope.run({ load }, work);
}

/** Work run later in the scope captured: it names the same run, observer or load. */
export type Scope = <T>(work: () => T) => T;

/** The scope the calling work runs in, kept for work done later on its behalf. */
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

/**
 * From now on, work in this process that names no workspace is refused
 * rather than answered by the only one hosted: a host of several
 * workspaces asks for it.
 */
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

/**
 * The host's engine answers for its workspace: instance calls made outside
 * a run, and the builtin `tasks`, reach it whenever the work names that
 * workspace, or names none and it is the only one hosted here. What the
 * workspace's runs declare goes to `declared`, its own catalog: the one
 * its source loaded into when omitted, else this process's.
 */
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

/**
 * This process is a host about to load a workspace's source: until it binds
 * that workspace's engine, the builtin `tasks` refuse every call that no
 * other hosted workspace answers.
 */
export function expectHost(): void {
  hostState = "loading";
}

/**
 * A host gave workspace `workspaceId` up before it bound an engine to it:
 * forget it, so it answers nothing, and work that still names it is
 * refused.
 */
export function abandonHost(workspaceId: string): void {
  if (hostings.get(workspaceId)?.runtime === undefined) {
    hostings.delete(workspaceId);
    released.add(workspaceId);
  }
}

/** `id`'s hosting, unless its engine was disposed, which releases it. */
function liveHosting(id: string): Hosting | undefined {
  const hosting = hostings.get(id);
  if (hosting?.runtime?.disposed) {
    hostings.delete(id);
    released.add(id);
    return;
  }
  return hosting;
}

/** A host here holds several workspaces, and the work names none of them. */
class AmbiguousWorkspaceError extends Error {
  override readonly name = "AmbiguousWorkspaceError";
}

/** The work names a workspace whose host here has closed. */
class WorkspaceReleasedError extends Error {
  override readonly name = "WorkspaceReleasedError";
}

function releasedError(id: string): WorkspaceReleasedError {
  return new WorkspaceReleasedError(
    `workspace ${id} is no longer hosted in this process: its host closed, so nothing it started outlives it here; nothing was read, written or declared`
  );
}

/**
 * The workspace the calling work names: its execution context's (a run, an
 * observer), else that of the load whose library word is calling.
 */
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

/** Work that names no workspace, where that is refused. */
function unnamedError(): AmbiguousWorkspaceError {
  return new AmbiguousWorkspaceError(
    "this call names no workspace: it comes from outside every workspace's runs, observers and modules (a package, or Marbles itself), and this process hosts several, so none of them answers it"
  );
}

/**
 * The workspace the calling work belongs to. Work that names one is
 * answered by it alone, and refused once its host has closed here; only
 * work that names none falls to the one workspace hosted here. Undefined
 * when none is. Throws when several are and the work names none, rather
 * than reach whichever was bound last.
 */
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

/**
 * The catalog the authoring words declare into now: the workspace a run
 * or observer runs for, else the load whose library word is declaring, else this
 * process's own, as in a script no host loaded. Refused for a workspace
 * whose host has closed here, and for a declaration that names no
 * workspace while one's source is loading.
 */
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
    // A load's module declaring after its host closed, from a timer or a
    // callback: no engine uses that catalog any more.
    if (
      liveHosting(owner.workspaceId) === undefined &&
      released.has(owner.workspaceId)
    ) {
      throw releasedError(owner.workspaceId);
    }
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

/** The engine answering for the calling work's workspace, if one is bound and not disposed. */
function activeHost(): InstanceRuntime | undefined {
  return hostingNow()?.runtime;
}

/**
 * The calling work's workspace tasks; `undefined` in a script no host
 * loaded, whose tasks stay in memory. Throws in a host process with no
 * engine bound to answer for the work's workspace.
 */
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
