import type { Engine } from "./engine";

/**
 * Where a definition's instance methods run when they are called outside a
 * step body: the engine a host built (the CLI or the dashboard), else a
 * default built on first use. Inside a body they use the body's run, found
 * through async context, and never reach here.
 *
 * Both the CLI and an authoring module import this module, so the slot is
 * one instance per process, like the catalog.
 */
export type InstanceRuntime = Pick<Engine, "agents" | "bindings" | "dispose">;

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

/** Stop answering through `runtime`, if it is still the host. */
export function clearHost(runtime: InstanceRuntime): void {
  if (host === runtime) {
    host = undefined;
  }
}

/** Replace how the default runtime is built; tests inject mock models here. */
export function setDefaultRuntime(
  create: () => Promise<InstanceRuntime>
): void {
  createFallback = create;
}

/** The host's engine, else the default runtime, built once. */
export function instanceRuntime(): Promise<InstanceRuntime> {
  if (host) {
    return Promise.resolve(host);
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
