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
  | "workspaces"
>;

let host: InstanceRuntime | undefined;
let fallback: Promise<InstanceRuntime> | undefined;
let createFallback: () => Promise<InstanceRuntime> = async () => {
  const { createDefaultEngine } = await import("~/create");
  return createDefaultEngine();
};

/** The host's engine answers instance calls made outside a run. */
export function setHost(runtime: InstanceRuntime): void {
  host = runtime;
}

/** Authoring owns its host slot; a disposed engine no longer answers calls. */
function activeHost(): InstanceRuntime | undefined {
  if (host?.disposed) {
    host = undefined;
  }
  return host;
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
    fallback = createFallback();
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
