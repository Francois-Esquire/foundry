import type { Occurrence } from "@foundry/scheduling";
import type { ScheduledEngine } from "~/lib/schedule";
import { runScheduler } from "~/lib/schedule-loop";
import { runStoreEffect } from "~/lib/workflow-runs";

export interface RunningScheduler {
  readonly done: Promise<void>;
  readonly lines: string[];
  stop(): Promise<void>;
}

export function startScheduler(
  engine: ScheduledEngine,
  options: { readonly cancel?: AbortSignal } = {}
): RunningScheduler {
  const controller = new AbortController();
  const lines: string[] = [];
  const done = runScheduler(engine, {
    ...options,
    print: (line) => lines.push(line),
    signal: controller.signal,
  });
  return {
    done,
    lines,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

export async function occurrencesOf(
  engine: Pick<ScheduledEngine, "triggers">,
  key: string
): Promise<readonly Occurrence[]> {
  const store = await engine.triggers.schedules();
  return await runStoreEffect(store.listOccurrences({ scheduleId: key }));
}
