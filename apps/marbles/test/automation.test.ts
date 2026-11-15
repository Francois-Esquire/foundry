import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { monitor } from "~/authoring/triggers";
import { DatabaseAutomationStore } from "~/database/automations";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { marblesAutomations } from "~/database/tables";
import { stateDatabase } from "~/layout";
import {
  type AutomationOwner,
  AutomationService,
} from "~/lib/automation/service";
import type { AutomationStore } from "~/lib/automation/store";
import { MemoryAutomationStore } from "~/lib/automation/store";
import type { ScheduledEngine } from "~/lib/schedule";
import { runSchedules, tick } from "~/lib/schedule";
import type { TriggerStore } from "~/lib/trigger-store";
import { MemoryTriggerStore } from "~/lib/trigger-store";
import type { Schedule } from "~/lib/triggers";
import { bindMock } from "./helpers/bindings";
import { declared, startEngine } from "./helpers/engine";

const directories: string[] = [];
const owner: AutomationOwner = {
  agentId: "worker",
  sessionId: "session",
  source: { definition: "work", path: ["work"], runId: "run" },
};
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), "automation-"));
  directories.push(path);
  return path;
};
/** The Marbles database at each state root a test used, open until it ends. */
const databases = new Map<string, MarblesDatabase>();

/**
 * The automations of the test workspace in the Marbles database at
 * `state`, as an engine over it keeps them, or in memory without one.
 */
async function storeAt(state?: string): Promise<AutomationStore> {
  if (state === undefined) {
    return new MemoryAutomationStore();
  }
  let opened = databases.get(state);
  if (opened === undefined) {
    opened = await initializeDatabase(stateDatabase(state));
    databases.set(state, opened);
  }
  return new DatabaseAutomationStore({
    database: opened.database,
    scope: "test",
  });
}

/** A service over `storeAt(state)`, with a registry of its own, as another host has. */
async function serviceAt(state?: string): Promise<AutomationService> {
  return new AutomationService({
    registry: declared(),
    store: await storeAt(state),
  });
}

function loopEngine(
  schedules: () => readonly Schedule[] | Promise<readonly Schedule[]>,
  launch: (name: string) => void,
  triggers: TriggerStore = new MemoryTriggerStore()
): ScheduledEngine {
  return {
    cancel: async () => undefined,
    has: () => true,
    launch: async (name: string) => {
      launch(name);
      return { id: "run", result: Promise.resolve(undefined) };
    },
    schedules: async () => await schedules(),
    triggers,
  } as ScheduledEngine;
}

afterEach(() => {
  catalog.reset();
  for (const opened of databases.values()) {
    opened.close();
  }
  databases.clear();
  for (const path of directories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

it("persists declarative records, keeps stable ids and restores enabled state", async () => {
  const state = temp();
  step("target")
    .input(z.object({ value: z.number() }))
    .do(({ input }) => input.value);
  const service = await serviceAt(state);
  const spec = {
    at: "1h",
    input: { value: 2 },
    key: "hourly",
    workflow: "target",
  };
  const record = await service.create(spec, owner);
  expect(await service.create(spec, owner)).toEqual(record);
  await service.setEnabled(record.id, false, owner);
  catalog.reset();
  step("target").do(() => 2);
  const restored = await serviceAt(state);
  expect(await restored.list()).toEqual([{ ...record, enabled: false }]);
  expect(await restored.schedules()).toHaveLength(0);
  await restored.setEnabled(record.id, true);
  expect((await restored.schedules())[0]?.key).toBe(record.id);
  await restored.delete(record.id);
  expect(await restored.list()).toHaveLength(0);
});

it("lets two hosts creating one automation at once agree on one record", async () => {
  const state = temp();
  step("target").do(() => 1);
  const spec = { at: "1h", key: "k", workflow: "target" };
  const [first, second] = await Promise.all([
    (await serviceAt(state)).create(spec, owner),
    (await serviceAt(state)).create(spec, owner),
  ]);
  expect(second).toEqual(first);
  expect(await (await serviceAt(state)).list()).toEqual([first]);
});

it("rejects changed idempotency keys, invalid target input and foreign mutation", async () => {
  step("target")
    .input(z.object({ value: z.number() }))
    .do(() => 1);
  const service = await serviceAt();
  const spec = {
    at: "1m",
    input: { value: 1 },
    key: "job",
    workflow: "target",
  };
  const record = await service.create(spec, owner);
  await expect(
    service.create({ ...spec, input: { value: "bad" } }, owner)
  ).rejects.toThrow();
  await expect(service.create({ ...spec, at: "2m" }, owner)).rejects.toThrow(
    "different settings"
  );
  await expect(
    service.delete(record.id, { ...owner, sessionId: "other" })
  ).rejects.toThrow("another agent");
});

it("rejects a cadence too long to schedule", async () => {
  step("target").do(() => 1);
  const service = await serviceAt();
  await expect(
    service.create(
      { at: "9007199254740993d", key: "job", workflow: "target" },
      owner
    )
  ).rejects.toThrow("must be a positive interval");
});

it("constrains file sources and requires explicit HTTP permission", async () => {
  step("target").do(() => 1);
  const service = await serviceAt();
  const spec = { at: "1m", key: "job", workflow: "target" };
  await expect(
    service.create(
      { ...spec, source: { glob: "../secret", kind: "files" } },
      owner
    )
  ).rejects.toThrow("workspace-relative");
  await expect(
    service.create(
      { ...spec, source: { kind: "http", url: "https://example.com" } },
      owner
    )
  ).rejects.toThrow("not permitted");
});

it("launches a dynamically created file monitor once per change through the existing engine", async () => {
  const root = temp();
  const state = temp();
  writeFileSync(join(root, "watched.txt"), "first");
  let starts = 0;
  step("target").do(() => {
    starts += 1;
    return starts;
  });
  const bound = bindMock(() => "", { root, state });
  const engine = await startEngine({ ...bound.instances, root, state });
  const service = engine.automations;
  try {
    const record = await service.create(
      {
        at: "1s",
        key: "watch",
        source: { glob: "*.txt", kind: "files" },
        workflow: "target",
      },
      owner
    );
    const schedule = (await service.schedules()).find(
      (entry) => entry.key === record.id
    );
    expect(schedule).toBeDefined();
    if (!schedule) {
      throw new Error("Missing schedule");
    }
    await tick(engine, schedule, { print: () => undefined });
    await tick(engine, schedule, { print: () => undefined });
    expect(starts).toBe(1);
    writeFileSync(join(root, "watched.txt"), "second");
    await tick(engine, schedule, { print: () => undefined });
    expect(starts).toBe(2);
  } finally {
    await engine.stop({ cancel: true });
    await bound.dispose();
  }
});

it("waits for additions to an empty live catalogue and stops on cancellation", async () => {
  let now = 0;
  const controller = new AbortController();
  const active: Schedule[] = [];
  const calls: string[] = [];
  const engine = loopEngine(
    () => active,
    (name) => {
      calls.push(name);
      controller.abort();
    }
  );
  await runSchedules(engine, {
    now: () => now,
    print: () => undefined,
    signal: controller.signal,
    sleep: async (ms) => {
      now += ms;
      if (!active.length) {
        active.push({
          input: null,
          key: "new",
          kind: "schedule",
          label: "new",
          trigger: { kind: "interval", ms: 1000 },
          workflow: "target",
        });
      }
    },
  });
  expect(calls).toEqual(["target"]);
});

it("does not relaunch an observed change after the started target fails", async () => {
  const root = temp();
  const state = temp();
  writeFileSync(join(root, "watched.txt"), "first");
  let starts = 0;
  step("target").do(() => {
    starts += 1;
    throw new Error("target failed");
  });
  const bound = bindMock(() => "", { root, state });
  const engine = await startEngine({ ...bound.instances, root, state });
  const service = engine.automations;
  try {
    await service.create(
      {
        at: "1s",
        key: "watch",
        source: { glob: "*.txt", kind: "files" },
        workflow: "target",
      },
      owner
    );
    const [schedule] = await service.schedules();
    if (!schedule) {
      throw new Error("Missing schedule");
    }
    await expect(
      tick(engine, schedule, { print: () => undefined })
    ).rejects.toThrow("target failed");
    await tick(engine, schedule, { print: () => undefined });
    expect(starts).toBe(1);
  } finally {
    await engine.stop({ cancel: true });
    await bound.dispose();
  }
});

it("existing hosts observe persisted additions, pause, deletion and idempotent retries", async () => {
  const state = temp();
  step("target").do(() => 1);
  // Two hosts over one state dir: each has its own registry.
  const first = await serviceAt(state);
  const second = await serviceAt(state);
  const spec = { at: "1s", key: "job", workflow: "target" };
  const record = await first.create(spec, owner);
  expect(await second.list()).toEqual([record]);
  expect(await second.create(spec, owner)).toEqual(record);
  await second.setEnabled(record.id, false, owner);
  expect(await first.schedules()).toHaveLength(0);
  await first.delete(record.id, owner);
  expect(await second.list()).toHaveLength(0);
  await expect(second.setEnabled(record.id, true, owner)).rejects.toThrow(
    "missing"
  );
});

it("fails closed on invalid persisted records while exposing a host-readable error", async () => {
  const state = temp();
  step("target").do(() => 1);
  const service = await serviceAt(state);
  await databases
    .get(state)
    ?.database.insert(marblesAutomations)
    .values({
      agentId: owner.agentId,
      at: "1h",
      createdAt: new Date().toISOString(),
      enabled: true,
      id: "broken",
      input: "bad JSON",
      key: "broken",
      ownerDefinition: "work",
      ownerPath: ["work"],
      ownerRunId: "run",
      scope: "test",
      sessionId: owner.sessionId,
      version: 1,
      workflow: "target",
    });
  expect((await service.errors()).broken).toContain("input");
  expect(await service.schedules()).toHaveLength(0);
});

it("rechecks completion and live membership under the tick's claim", async () => {
  let starts = 0;
  const schedule = {
    input: null,
    key: "test",
    kind: "schedule" as const,
    label: "test",
    trigger: { kind: "interval" as const, ms: 1000 },
    workflow: "target",
  };
  const engine = loopEngine(
    () => [schedule],
    () => {
      starts += 1;
    },
    new MemoryTriggerStore()
  );
  await tick(engine, schedule, {
    now: () => 2000,
    print: () => undefined,
    scheduled: true,
  });
  await tick(engine, schedule, {
    now: () => 2000,
    print: () => undefined,
    scheduled: true,
  });
  await tick(engine, schedule, {
    canRun: () => false,
    now: () => 4000,
    print: () => undefined,
    scheduled: true,
  });
  expect(starts).toBe(1);
});

it("retries a pending monitor launch after restart when setup previously failed", async () => {
  const root = temp();
  const state = temp();
  writeFileSync(join(root, "watched.txt"), "first");
  let starts = 0;
  step("target").do(() => {
    starts += 1;
  });
  const bound = bindMock(() => "", { root, state });
  const engine = await startEngine({ ...bound.instances, root, state });
  const first = engine.automations;
  await first.create(
    {
      at: "1s",
      key: "watch",
      source: { glob: "*.txt", kind: "files" },
      workflow: "target",
    },
    owner
  );
  const [schedule] = await first.schedules();
  if (!schedule) {
    throw new Error("Missing schedule");
  }
  try {
    const failing = vi
      .spyOn(engine, "launch")
      .mockRejectedValue(new Error("setup unavailable"));
    await expect(
      tick(engine, schedule, { print: () => undefined })
    ).rejects.toThrow("setup unavailable");
    failing.mockRestore();
    expect(starts).toBe(0);
  } finally {
    await engine.stop({ cancel: true });
  }
  const restarted = await startEngine({
    ...bound.instances,
    print: () => undefined,
    root,
    state,
  });
  const restored = restarted.automations;
  try {
    const [recovered] = await restored.schedules();
    if (!recovered) {
      throw new Error("Missing restored schedule");
    }
    await tick(restarted, recovered, { print: () => undefined });
    await tick(restarted, recovered, { print: () => undefined });
    expect(starts).toBe(1);
  } finally {
    await restarted.stop({ cancel: true });
    await bound.dispose();
  }
});

it("cancels a running monitor request when the schedule loop signal aborts", async () => {
  const state = temp();
  const controller = new AbortController();
  let entered: () => void = () => undefined;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_url, init = {}) =>
      await new Promise<Response>((_resolve, reject) => {
        entered();
        init.signal?.addEventListener(
          "abort",
          () => reject(new Error("request cancelled")),
          { once: true }
        );
      })
  );
  step("target").do(() => 1);
  // An agent may poll an origin the config already watches.
  monitor("https://example.com/status").do(() => undefined);
  const bound = bindMock(() => "", { state });
  const engine = await startEngine({ ...bound.instances, state });
  const service = engine.automations;
  try {
    await service.create(
      {
        at: "1s",
        key: "watch",
        source: { kind: "http", url: "https://example.com" },
        workflow: "target",
      },
      owner
    );
    const schedule = (await service.schedules()).find(
      (candidate) => candidate.label === "watch"
    );
    if (!schedule) {
      throw new Error("Missing schedule");
    }
    const running = tick(engine, schedule, {
      print: () => undefined,
      signal: controller.signal,
    });
    const outcome = running.then(
      () => "complete",
      () => "cancelled"
    );
    await requested;
    controller.abort();
    expect(await outcome).toBe("cancelled");
  } finally {
    mockedFetch.mockRestore();
    await engine.stop({ cancel: true });
    await bound.dispose();
  }
});

it("records a visible failed tick when a restored target was removed", async () => {
  const state = temp();
  step("target").do(() => 1);
  const first = await serviceAt(state);
  const record = await first.create(
    { at: "1s", key: "job", workflow: "target" },
    owner
  );
  catalog.reset();
  const bound = bindMock(() => "", { state });
  const engine = await startEngine({ ...bound.instances, state });
  try {
    const [schedule] = await engine.automations.schedules();
    if (!schedule) {
      throw new Error("Missing restored schedule");
    }
    await expect(
      tick(engine, schedule, { print: () => undefined })
    ).rejects.toThrow();
    expect(await engine.triggers.lastTick(record.id)).toMatchObject({
      lastStatus: "failed",
    });
  } finally {
    await engine.stop({ cancel: true });
    await bound.dispose();
  }
});

it("preserves the first firing deadline when restored before any tick history exists", async () => {
  const state = temp();
  step("target").do(() => 1);
  const first = await serviceAt(state);
  const record = await first.create(
    { at: "1s", key: "job", workflow: "target" },
    owner
  );
  catalog.reset();
  step("target").do(() => 1);
  const restored = await serviceAt(state);
  expect((await restored.list())[0]?.createdAt).toBe(record.createdAt);
  expect((await restored.schedules())[0]?.registeredAt).toBe(
    Date.parse(record.createdAt)
  );
  let now = Date.parse(record.createdAt) + 400;
  const waits: number[] = [];
  const controller = new AbortController();
  const engine = loopEngine(
    () => restored.schedules(),
    () => controller.abort()
  );
  await runSchedules(engine, {
    now: () => now,
    print: () => undefined,
    signal: controller.signal,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  expect(waits).toEqual([600]);
});

it("isolates pending monitor launches and first deadlines when a deleted key is recreated", async () => {
  const root = temp();
  const state = temp();
  writeFileSync(join(root, "watched.txt"), "first");
  const launched: string[] = [];
  step("old-target").do(() => {
    launched.push("old");
  });
  step("new-target").do(() => {
    launched.push("new");
  });
  const bound = bindMock(() => "", { root, state });
  const engine = await startEngine({ ...bound.instances, root, state });
  const service = engine.automations;
  try {
    const original = await service.create(
      {
        at: "1s",
        key: "watch",
        source: { glob: "*.txt", kind: "files" },
        workflow: "old-target",
      },
      owner
    );
    const [oldSchedule] = await service.schedules();
    if (!oldSchedule) {
      throw new Error("Missing old schedule");
    }
    const failing = vi
      .spyOn(engine, "launch")
      .mockRejectedValue(new Error("setup unavailable"));
    await expect(
      tick(engine, oldSchedule, { print: () => undefined })
    ).rejects.toThrow("setup unavailable");
    failing.mockRestore();
    await service.delete(original.id, owner);
    const recreated = await service.create(
      {
        at: "1s",
        key: "watch",
        source: { glob: "*.txt", kind: "files" },
        workflow: "new-target",
      },
      owner
    );
    const [newSchedule] = await service.schedules();
    if (!newSchedule) {
      throw new Error("Missing recreated schedule");
    }
    expect(recreated.id).not.toBe(original.id);
    expect(newSchedule.key).not.toBe(oldSchedule.key);
    await tick(engine, newSchedule, { print: () => undefined });
    expect(launched).toEqual(["new"]);
  } finally {
    await engine.stop({ cancel: true });
    await bound.dispose();
  }
});

it("does not dispatch an old trigger after its owner key was recreated", async () => {
  step("target").do(() => 1);
  const service = await serviceAt();
  const original = await service.create(
    { at: "1s", key: "job", workflow: "target" },
    owner
  );
  const [selected] = await service.schedules();
  if (!selected) {
    throw new Error("Missing old generation");
  }
  await service.delete(original.id, owner);
  await service.create({ at: "1s", key: "job", workflow: "target" }, owner);
  const controller = new AbortController();
  let reads = 0;
  let starts = 0;
  const engine = loopEngine(
    () => {
      reads += 1;
      if (reads === 1) {
        return [selected];
      }
      controller.abort();
      return service.schedules();
    },
    () => {
      starts += 1;
    }
  );
  await runSchedules(engine, {
    now: () => Date.parse(original.createdAt) + 1000,
    print: () => undefined,
    signal: controller.signal,
  });
  expect(starts).toBe(0);
});

it("picks up another writer's record, and its removal, at the next read", async () => {
  const state = temp();
  step("target").do(() => 1);
  const reader = await serviceAt(state);
  expect(await reader.schedules()).toEqual([]);
  const record = await (await serviceAt(state)).create(
    { at: "1h", key: "hourly", workflow: "target" },
    owner
  );
  expect((await reader.schedules()).map((schedule) => schedule.key)).toEqual([
    record.id,
  ]);

  // Another process writes a record directly, with no service at all.
  const id = `automation-${"b".repeat(24)}`;
  const store = await storeAt(state);
  await store.put({ ...record, id, key: "by-hand" });
  expect(
    (await reader.schedules()).map((schedule) => schedule.label).sort()
  ).toEqual(["by-hand", "hourly"]);
  expect((await reader.list()).map((entry) => entry.id)).toContain(id);

  await store.remove(id);
  expect((await reader.schedules()).map((schedule) => schedule.key)).toEqual([
    record.id,
  ]);
});

it("keeps an in-memory host's records in its own store", async () => {
  step("target").do(() => 1);
  const store = new MemoryAutomationStore();
  const first = new AutomationService({ registry: declared(), store });
  const record = await first.create(
    { at: "1h", key: "hourly", workflow: "target" },
    owner
  );
  const second = new AutomationService({ registry: declared(), store });
  expect((await second.schedules()).map((schedule) => schedule.key)).toEqual([
    record.id,
  ]);
  expect(await (await serviceAt()).list()).toEqual([]);
});
