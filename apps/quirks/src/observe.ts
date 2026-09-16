import type { ChannelEvent } from "@foundry/workflows/channels";
import type { BaseContext } from "@foundry/workflows/executable";
import type { Workflow } from "@foundry/workflows/workflow";

/**
 * Print step lifecycle as it happens. The Orchestrator's run journal only
 * carries Run-level frames, so the step tree is read from the workflow's own
 * channel stream. Resolves once the root step settles; the stream itself stays
 * open until the workflow is disposed.
 *
 * The root path segment is the definition key (`quirks.develop`); it is
 * replaced by the registered name so lines match the final `[run]` line.
 */
export async function observeSteps<I, O, X extends BaseContext>(
  name: string,
  workflow: Workflow<I, O, X>,
  print: (line: string) => void
): Promise<void> {
  const rootDepth = workflow.root.path.length;
  const reader = workflow.root.channelStream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value._tag !== "event") {
        continue;
      }
      const line = describe(name, value.event);
      if (line) {
        print(`[step] ${line}`);
      }
      if (isTerminal(value.event) && value.event.path.length === rootDepth) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function describe(name: string, event: ChannelEvent): string | undefined {
  const path = [name, ...event.path.slice(1)].join(".");
  if (event._tag === "step.started") {
    return `${path} started`;
  }
  if (event._tag === "step.complete") {
    return `${path} complete`;
  }
  if (event._tag === "step.failed") {
    return `${path} failed: ${event.error.message}`;
  }
  if (event._tag === "step.bailed") {
    return `${path} bailed`;
  }
  if (event._tag === "step.aborted") {
    return `${path} aborted`;
  }
  return undefined;
}

function isTerminal(event: ChannelEvent): boolean {
  return (
    event._tag === "step.complete" ||
    event._tag === "step.failed" ||
    event._tag === "step.bailed" ||
    event._tag === "step.aborted"
  );
}
