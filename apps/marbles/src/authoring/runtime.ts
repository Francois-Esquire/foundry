import type { TaskStore } from "@foundry/tasks";
import type { Catalog } from "~/authoring/catalog";
import { catalog } from "~/authoring/catalog";
import { initializeUsage } from "~/authoring/usage";
import type { Engine } from "~/lib/engine";
import { activeContext } from "~/lib/execution-context";

/**
 * Where a definition's instance methods run when they are called outside a
 * step body, and which workspace the builtin `tasks` and the authoring
 * words reach. Inside a body, or an observer's handler, the work's
 * execution context names its workspace, found through async context; a
 * call in a body runs on the body's run and never reaches the slot.
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
  runtime: InstanceRuntime | undefined;
}

const hostings = new Map<string, Hosting>();
/** The workspace whose source is being imported now; loads take turns. */
let loading: Hosting | undefined;
let loads: Promise<unknown> = Promise.resolve();
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
 * Import a workspace's source with every declaration landing in `into`,
 * that workspace's catalog: one load at a time in this process, since
 * module evaluation carries no async context of its own. A load that
 * throws leaves nothing in `into`, and its workspace unloaded.
 */
export function loadInto<T>(
  workspaceId: string,
  into: Catalog,
  load: () => Promise<T>
): Promise<T> {
  const turn = loads.then(async () => {
    const hosting: Hosting = {
      catalog: into,
      id: workspaceId,
      runtime: undefined,
    };
    hostings.set(workspaceId, hosting);
    loading = hosting;
    try {
      return await load();
    } catch (error) {
      into.reset();
      if (hostings.get(workspaceId) === hosting) {
        hostings.delete(workspaceId);
      }
      throw error;
    } finally {
      loading = undefined;
    }
  });
  loads = turn.catch(() => undefined);
  return turn;
}

/**
 * The host's engine answers for its workspace: instance calls made outside
 * a run, and the builtin `tasks`, reach it whenever the work names that
 * workspace, or is the only one hosted here.
 */
export function setHost(runtime: InstanceRuntime): void {
  const hosting = hostings.get(runtime.workspaceId);
  hostings.set(runtime.workspaceId, {
    catalog: hosting?.catalog ?? catalog,
    id: runtime.workspaceId,
    runtime,
  });
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

/** Forget every workspace whose engine was disposed. */
function dropDisposed(): void {
  for (const [id, hosting] of hostings) {
    if (hosting.runtime?.disposed) {
      hostings.delete(id);
    }
  }
}

/** A host here holds several workspaces, and the work names none of them. */
class AmbiguousWorkspaceError extends Error {
  override readonly name = "AmbiguousWorkspaceError";
}

/**
 * The workspace the calling work belongs to: the one its execution
 * context names, else the one loading now, else the only one hosted here.
 * Undefined when none is. Throws when several are and the work names
 * none, rather than reach whichever was bound last.
 */
function hostingNow(): Hosting | undefined {
  dropDisposed();
  const id = activeContext()?.workspaceId;
  const named = id === undefined ? undefined : hostings.get(id);
  if (named !== undefined) {
    return named;
  }
  if (loading !== undefined) {
    return loading;
  }
  const hosted = [...hostings.values()];
  if (hosted.length > 1) {
    throw new AmbiguousWorkspaceError(
      `this process hosts ${String(hosted.length)} workspaces (${hosted.map((each) => each.id).join(", ")}), and this call runs outside any of their runs or observers, so none of them answers it`
    );
  }
  return hosted[0];
}

/** The catalog the authoring words declare into now; the process's own in a script no host loaded. */
export function declaringCatalog(): Catalog {
  const id = activeContext()?.workspaceId;
  return (
    (id === undefined ? undefined : hostings.get(id)?.catalog) ??
    loading?.catalog ??
    catalog
  );
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
