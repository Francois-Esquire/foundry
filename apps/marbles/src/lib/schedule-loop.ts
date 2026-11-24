import type { Schedule as StoredSchedule } from "@foundry/scheduling";
import {
  createSchedulerClient,
  type SchedulerClient,
} from "@foundry/scheduling/client";
import { ScheduleStore } from "@foundry/scheduling/store";
import { Layer } from "effect";
import type { ScheduledEngine } from "~/lib/schedule";
import { registration } from "~/lib/schedule";
import { ScheduleDispatcher } from "~/lib/schedule-dispatch";
import type { Schedule } from "~/lib/triggers";

const POLL_MS = 1000;
const SETTLE_POLL_MS = 1000;

export interface ScheduleLoopOptions {
  readonly cancel?: AbortSignal;
  readonly print: (line: string) => void;
  readonly signal: AbortSignal;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runScheduler(
  engine: ScheduledEngine,
  options: ScheduleLoopOptions
): Promise<void> {
  const { print, signal } = options;
  if (signal.aborted) {
    return;
  }
  const store = await engine.triggers.schedules();
  const dispatcher = new ScheduleDispatcher(engine, {
    cancel: options.cancel ?? signal,
    print,
  });
  const stop = () => dispatcher.stop();
  signal.addEventListener("abort", stop, { once: true });
  const client = createSchedulerClient({
    dispatch: dispatcher.layer,
    settlePollMs: SETTLE_POLL_MS,
    store: Layer.succeed(ScheduleStore, store),
  });
  try {
    while (!signal.aborted) {
      await reconcile(client, engine, options);
      await sleep(POLL_MS, signal);
    }
  } finally {
    signal.removeEventListener("abort", stop);
    dispatcher.stop();
    await client
      .dispose()
      .catch((error: unknown) =>
        print(`[schedule] stopping the scheduler failed: ${String(error)}`)
      );
    await dispatcher.drain();
  }
}

async function reconcile(
  client: SchedulerClient,
  engine: ScheduledEngine,
  { print, signal }: ScheduleLoopOptions
): Promise<void> {
  let active: readonly Schedule[];
  let paused: readonly Schedule[];
  let stored: ReadonlyMap<string, StoredSchedule>;
  try {
    active = await engine.schedules();
    paused = await engine.automations.paused();
    stored = new Map(
      (await client.list()).map((schedule) => [schedule.id, schedule])
    );
  } catch (error) {
    print(`[schedule] reading schedules failed: ${String(error)}`);
    return;
  }
  const now = Date.now();
  const wanted = [
    ...active.map((schedule) => [schedule, "active"] as const),
    ...paused.map((schedule) => [schedule, "paused"] as const),
  ];
  for (const [schedule, state] of wanted) {
    if (signal.aborted) {
      return;
    }
    await keep(client, schedule, state, stored.get(schedule.key), now).catch(
      (error: unknown) =>
        print(`[schedule] ${schedule.key} failed: ${String(error)}`)
    );
  }
  const keys = new Set(wanted.map(([schedule]) => schedule.key));
  for (const id of stored.keys()) {
    if (signal.aborted) {
      return;
    }
    if (!keys.has(id)) {
      await client
        .unregister(id)
        .catch((error: unknown) =>
          print(`[schedule] removing ${id} failed: ${String(error)}`)
        );
    }
  }
}

async function keep(
  client: SchedulerClient,
  schedule: Schedule,
  state: StoredSchedule["state"],
  stored: StoredSchedule | undefined,
  now: number
): Promise<void> {
  const input = registration(schedule, stored, now);
  if (input !== undefined) {
    await client.register({ ...input, state });
    return;
  }
  if (stored !== undefined && stored.state !== state) {
    await (state === "paused"
      ? client.pause(schedule.key)
      : client.resume(schedule.key));
  }
}
