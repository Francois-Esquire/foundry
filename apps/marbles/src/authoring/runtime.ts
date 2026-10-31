import type { TaskStore } from "@foundry/tasks";
import { initializeUsage } from "~/authoring/usage";
import type { Engine } from "~/lib/engine";

/**
 * Where a definition's instance methods run when they are called outside a
 * step body: the engine a host built (the CLI or the dashboard), else a
 * default built on first use. Inside a body they use the body's run, found
 * through async context, and never reach here.
 *
 * Both the CLI and an authoring module import this module, so the slot is
 * one instance per process, like the catalog.
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
  | "workspaces"
>;

let host: InstanceRuntime | undefined;
/**
 * What the builtin `tasks` reach. A script no host loaded keeps them in
 * process memory (`unhosted`). A host process reaches its workspace's tasks
 * only through the engine it bound (`hosted`): not while it loads source,
 * before there is one (`loading`), and not once that engine is disposed
 * (`disposed`), until another is bound. Neither falls back to memory, which
 * would accept a workspace's write and lose it.
 */
let taskAccess: "unhosted" | "loading" | "hosted" | "disposed" = "unhosted";
let fallback: Promise<InstanceRuntime> | undefined;
let createFallback: () => Promise<InstanceRuntime> = async () => {
  const { createDefaultEngine } = await import("~/create");
  return createDefaultEngine();
};

/** The host's engine answers instance calls made outside a run. */
export function setHost(runtime: InstanceRuntime): void {
  host = runtime;
  taskAccess = "hosted";
}

/**
 * This process is a host about to load a workspace's source: until it binds
 * that workspace's engine, the builtin `tasks` refuse every call.
 */
export function expectHost(): void {
  taskAccess = "loading";
}

/** Authoring owns its host slot; a disposed engine no longer answers calls. */
function activeHost(): InstanceRuntime | undefined {
  if (host?.disposed) {
    host = undefined;
    if (taskAccess === "hosted") {
      taskAccess = "disposed";
    }
  }
  return host;
}

/**
 * The bound host's workspace tasks; `undefined` in a script no host loaded,
 * whose tasks stay in memory. Throws in a host process with no engine bound
 * to answer for its workspace.
 */
export function hostTaskStore(): TaskStore | undefined {
  const runtime = activeHost();
  if (taskAccess === "unhosted") {
    return;
  }
  if (taskAccess === "hosted" && runtime !== undefined) {
    return runtime.taskStore;
  }
  if (taskAccess === "loading") {
    throw new Error(
      "tasks: the workspace's tasks are not available while its source loads; use them in a step, an observe handler, or once the host has started"
    );
  }
  throw new Error(
    "tasks: the workspace host that held these tasks was disposed; nothing was read or written"
  );
}

/** Replace how the default runtime is built; tests inject mock models here. */
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
  const runtime = activeHost();
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
