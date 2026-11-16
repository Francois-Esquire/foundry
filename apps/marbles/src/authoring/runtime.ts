import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskStore } from "@foundry/tasks";
import type { Catalog } from "~/authoring/catalog";
import { catalog } from "~/authoring/catalog";
import { newLoad } from "~/authoring/load-tag";
import { initializeUsage } from "~/authoring/usage";
import type { Engine } from "~/lib/engine";
import type { ExecutionContext } from "~/lib/execution-context";
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
  | "context"
  | "dispose"
  | "disposed"
  | "execute"
  | "sandboxes"
  | "taskStore"
  | "workspaceId"
  | "workspaces"
>;

/**
 * One engine bound to its workspace here (`setHost`), with the catalog it
 * took. It is released once that engine is disposed, and only then:
 * another engine bound to the same workspace releases nothing, so an old
 * engine keeps answering the runs it still has. Work that belongs to an
 * engine carries its binding, and is answered through it alone. Once
 * released it holds neither the engine nor the catalog, only that it was
 * released, so work that still carries it keeps nothing of either alive.
 */
interface Binding {
  catalog: Catalog | undefined;
  released: boolean;
  runtime: InstanceRuntime | undefined;
  readonly workspaceId: string;
}

/** Every binding not yet released. */
const bound = new Set<Binding>();

/** Whether `binding`'s engine was disposed; once it was, it lets go of the engine and catalog. */
function isReleased(binding: Binding): boolean {
  if (!binding.released && binding.runtime?.disposed !== false) {
    binding.released = true;
    binding.runtime = undefined;
    binding.catalog = undefined;
    bound.delete(binding);
  }
  return binding.released;
}

/** The bindings of `workspaceId` whose engine is not disposed. */
function liveBindings(workspaceId: string): Binding[] {
  return [...bound].filter(
    (binding) => binding.workspaceId === workspaceId && !isReleased(binding)
  );
}

/**
 * Each bound engine's binding, by the execution context it runs its work
 * in: every run and observer of an engine, and every continuation of one,
 * sees that engine's own context (`Engine.context`), so the context says
 * whose work it is.
 */
const contextBindings = new WeakMap<ExecutionContext, Binding>();

/**
 * One workspace a host in this process loads or hosts: the catalog its
 * source declares into, and the binding of the engine answering for it
 * now, which work that names only the workspace reaches. Its tasks are
 * refused while its source loads, before its engine is bound, and once
 * that engine is disposed, until another is bound. None falls back to
 * memory, which would accept a workspace's write and lose it.
 */
interface Hosting {
  readonly binding: Binding | undefined;
  readonly catalog: Catalog;
  readonly id: string;
}

const hostings = new Map<string, Hosting>();
/**
 * Workspaces whose host here closed or gave them up: work that names only
 * the workspace is refused, never handed to whichever workspace is left.
 */
const released = new Set<string>();
/**
 * One load of a workspace's source: the catalog its modules declare into,
 * and the binding of the engine that took that catalog, once one has. A
 * load whose host gave it up before any engine took it is abandoned.
 */
interface Load {
  abandoned: boolean;
  binding: Binding | undefined;
  readonly catalog: Catalog;
  readonly workspaceId: string;
}

/** Each load that work may still answer to, by load number. */
const loads = new Map<number, Load>();
/**
 * The numbers of loads that answer nothing any more: their engine was
 * disposed, or their host gave them up. Only the number is kept, so a
 * late call from one is refused rather than taken for work that names no
 * workspace; the load and its catalog are let go.
 */
const retired = new Set<number>();

/**
 * Let go of what nothing can answer through any more: each binding whose
 * engine was disposed, each load it took or its host gave up, and each
 * workspace whose engine bound last is gone. Run as engines are bound
 * and loads begin, so a host that reloads for months keeps only what is
 * live.
 */
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
/**
 * Whom work done later on another's behalf answers to: a load, while its
 * library's words run; the binding of the engine whose run or observer
 * made a builder or an instance; or, for a run of an engine no host here
 * bound, its workspace alone.
 */
type Route =
  | { readonly load: number }
  | { readonly binding: Binding }
  | { readonly workspaceId: string };

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

/**
 * The scope the calling work runs in, kept for work done later on its
 * behalf: the binding of the engine whose run or observer calls, else the
 * load whose library word calls, which follows that load's binding.
 */
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
    // Given up whether or not an engine answers for the workspace meanwhile.
    abandonHost(workspaceId, into);
    throw error;
  } finally {
    importing -= 1;
  }
}

/**
 * The host's engine answers for its workspace: its own runs and
 * observers, the loads whose catalog it takes, and what they make, reach
 * it until it is disposed, whatever is bound after it; instance calls and
 * the builtin `tasks` that name only the workspace, or name none while it
 * is the only one hosted here, reach the engine bound last. What the
 * workspace's runs declare goes to `declared`, its own catalog: the one
 * its source loaded into when omitted, else this process's.
 */
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
  // Each load whose catalog this engine took answers to this engine alone.
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

/**
 * A host disposed `runtime`: let go of it, its catalog and the loads it
 * took now, rather than when the next engine is bound or load begins. An
 * engine disposed by anything else is let go then.
 */
export function releaseEngine(runtime: InstanceRuntime): void {
  if (!runtime.disposed) {
    return;
  }
  sweep();
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
 * A host gave up the load of workspace `workspaceId` into `given` before
 * an engine took that catalog: each such load is abandoned, so its work is
 * refused, whatever engine answers for the workspace meanwhile. When no
 * engine answers for the workspace at all, it is forgotten too, so it
 * answers nothing, and work that still names it is refused.
 */
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

/**
 * Whom the calling work belongs to: the binding of the engine whose run,
 * observer or load it is, or that made it; else a load no engine took
 * yet; else, for a run of an engine no host here bound, its workspace
 * alone. Undefined for work that names none.
 */
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
    // A load no host registered (`importLoad` on its own): it names none.
    return;
  }
  if (load.abandoned) {
    throw releasedError(load.workspaceId);
  }
  return load.binding === undefined ? { load } : { binding: load.binding };
}

/** The engine and catalog of `binding`, refused once its engine has been disposed. */
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

/**
 * The hosting of `workspaceId` for work that carries no binding, only as
 * long as one engine at most is alive for it: with an older engine still
 * finishing its runs beside a newer one, such work could belong to
 * either, so it is refused rather than handed to the one bound last.
 */
function soleHosting(workspaceId: string): Hosting | undefined {
  const alive = liveBindings(workspaceId);
  if (alive.length > 1) {
    throw new AmbiguousWorkspaceError(
      `this call names workspace ${workspaceId} and no engine of it, and ${String(alive.length)} of its engines are running here (one still finishing its runs beside the one that replaced it), so none of them answers it`
    );
  }
  return liveHosting(workspaceId);
}

/** The workspace work that has no binding names: its load's, or its run's. */
function namedBy(
  own: { readonly load: Load } | { readonly workspaceId: string } | undefined
): string | undefined {
  if (own === undefined) {
    return;
  }
  return "load" in own ? own.load.workspaceId : own.workspaceId;
}

/** What answers the calling work: its catalog and, once bound, its engine. */
interface Answer {
  readonly catalog: Catalog;
  readonly id: string;
  readonly runtime: InstanceRuntime | undefined;
}

/** `id`'s hosting, unless the engine bound last was disposed, which releases it. */
function liveHosting(id: string): Hosting | undefined {
  const hosting = hostings.get(id);
  if (hosting?.binding !== undefined && isReleased(hosting.binding)) {
    hostings.delete(id);
    released.add(id);
    return;
  }
  return hosting;
}

/** What `hosting` answers with: the engine bound last, if any. */
function answerOf(hosting: Hosting): Answer {
  return {
    catalog: hosting.catalog,
    id: hosting.id,
    runtime: hosting.binding?.runtime,
  };
}

/**
 * Work from a run of an engine no host here bound names its workspace
 * alone. It belongs to that engine, never to one bound here: while one
 * is, it is refused, as it is once that workspace's host here closed;
 * otherwise no engine here answers it.
 */
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

/** A host here holds several workspaces, and the work names none of them. */
class AmbiguousWorkspaceError extends Error {
  override readonly name = "AmbiguousWorkspaceError";
}

/** The work names a workspace whose host here has closed. */
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

/** Work that names no workspace, where that is refused. */
function unnamedError(): AmbiguousWorkspaceError {
  return new AmbiguousWorkspaceError(
    "this call names no workspace: it comes from outside every workspace's runs, observers and modules (a package, or Marbles itself), and this process hosts several, so none of them answers it"
  );
}

/**
 * What answers the calling work. Work that belongs to an engine is
 * answered by that engine alone, whatever is bound after it, and refused
 * once it is disposed; work that names only a workspace by the engine
 * bound to it last, and is refused once its host has closed here; only
 * work that names none falls to the one workspace hosted here. Undefined
 * when none is. Throws when several are and the work names none, rather
 * than reach whichever was bound last.
 */
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
  // A load no engine has taken yet: the engine answering for its
  // workspace meanwhile, while it is the only one alive.
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
  // Work that names nothing: the one workspace hosted here, while one
  // engine alone is alive for it.
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

/**
 * The catalog the authoring words declare into now: that of the engine
 * the work belongs to, else the load whose library word is declaring,
 * else the workspace a run of an unbound engine names, else this
 * process's own, as in a script no host loaded. Refused once the engine
 * the work belongs to is disposed, for a workspace whose host has closed
 * here, and for a declaration that names no workspace while one's source
 * is loading.
 */
export function declaringCatalog(): Catalog {
  const own = owner();
  if (own !== undefined) {
    if ("binding" in own) {
      return live(own.binding).catalog;
    }
    if ("load" in own) {
      return own.load.catalog;
    }
    // A run of an engine no host here bound: this process's own catalog,
    // never that of an engine bound to the workspace.
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

/** The engine answering the calling work, if one is bound and not disposed. */
function activeHost(): InstanceRuntime | undefined {
  return answering()?.runtime;
}

/**
 * The calling work's workspace tasks; `undefined` in a script no host
 * loaded, whose tasks stay in memory. Throws in a host process with no
 * engine bound to answer for the work's workspace.
 */
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
