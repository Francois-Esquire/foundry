import type { TaskContext } from "@foundry.sh/marbles/engine";
import type { RunBody, WorksExecution } from "~/main/execution/contract";

let runs = 0;

function inlineContext(signal?: AbortSignal): TaskContext {
  const controller = new AbortController();
  runs += 1;
  return {
    observe: () => true,
    progress: () => undefined,
    release: () => undefined,
    run: { id: `rn-inline-${runs}` },
    signal: signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal,
  } as unknown as TaskContext;
}

/**
 * Runs each body at once, for renderer tests that drive the router in
 * happy-dom, where the engine cannot load. Main-process tests use the real
 * engine from `execution.ts`.
 */
export const inlineExecution: Pick<WorksExecution, "dispatch" | "launch"> = {
  async dispatch(_name, options, body) {
    return await body(inlineContext(options.signal));
  },
  launch<O>(
    _name: string,
    options: { readonly signal?: AbortSignal },
    body: RunBody<O>
  ) {
    runs += 1;
    const result = (async () => await body(inlineContext(options.signal)))();
    result.catch(() => undefined);
    return Promise.resolve({ id: `rn-inline-${runs}`, result });
  },
};
