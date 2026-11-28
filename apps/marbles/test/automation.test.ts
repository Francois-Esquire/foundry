import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import type { CollectInput } from "~/authoring/catalog";
import { monitor } from "~/authoring/triggers";
import { DatabaseAutomationStore } from "~/database/automations";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { marblesAutomations } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { type AutomationOwner, AutomationService } from "~/lib/automation";
import type { AutomationStore } from "~/lib/automation/store";
import { MemoryAutomationStore } from "~/lib/automation/store";
import type { ScheduledEngine } from "~/lib/schedule";
import { registration, rollSchedule } from "~/lib/schedule";
import { MemoryTriggerStore } from "~/lib/schedule/store";
import type { Schedule } from "~/lib/schedule/triggers";
import { bindMock } from "./helpers/bindings";
import { declared, startEngine } from "./helpers/engine";
import { occurrencesOf, startScheduler } from "./helpers/schedules";

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
const databases = new Map<string, MarblesDatabase>();

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

async function serviceAt(
  state?: string,
  declarations: CollectInput = []
): Promise<AutomationService> {
  return new AutomationService({
    registry: declared(declarations),
    store: await storeAt(state),
  });
}

function loopEngine(
  schedules: () => readonly Schedule[] | Promise<readonly Schedule[]>,
  launch: (name: string, triggerId: string) => void
): ScheduledEngine {
  return {
    automations: { paused: async () => [] },
    cancel: async () => undefined,
    executions: { peek: async () => undefined },
    has: () => true,
    launch: async (name: string, _input: unknown, triggerId: string) => {
      launch(name, triggerId);
      return { id: "rn-loop", result: Promise.resolve(undefined) };
    },
    schedules: async () => await schedules(),
    triggers: new MemoryTriggerStore(),
  } as unknown as ScheduledEngine;
}

afterEach(() => {
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
  const target = step("target")
    .input(z.object({ value: z.number() }))
    .do(({ input }) => input.value);
  const service = await serviceAt(state, [target]);
  const spec = {
    at: "1h",
    input: { value: 2 },
    key: "hourly",
    workflow: "target",
  };
  const record = await service.create(spec, owner);
  expect(await service.create(spec, owner)).toEqual(record);
  await service.setEnabled(record.id, false, owner);
  const nextTarget = step("target").do(() => 2);
  const restored = await serviceAt(state, [nextTarget]);
  expect(await restored.list()).toEqual([{ ...record, enabled: false }]);
  expect(await restored.schedules()).toHaveLength(0);
  await restored.setEnabled(record.id, true);
  expect((await restored.schedules())[0]?.key).toBe(record.id);
  await restored.delete(record.id);
  expect(await restored.list()).toHaveLength(0);
});

it("lets two hosts creating one automation at once agree on one record", async () => {
  const state = temp();
  const target = step("target").do(() => 1);
  const spec = { at: "1h", key: "k", workflow: "target" };
  const [first, second] = await Promise.all([
    (await serviceAt(state, [target])).create(spec, owner),
    (await serviceAt(state, [target])).create(spec, owner),
  ]);
  expect(second).toEqual(first);
  expect(await (await serviceAt(state, [target])).list()).toEqual([first]);
});

it("rejects changed idempotency keys, invalid target input and foreign mutation", async () => {
  const target = step("target")
    .input(z.object({ value: z.number() }))
    .do(() => 1);
  const service = await serviceAt(undefined, [target]);
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
  const target = step("target").do(() => 1);
  const service = await serviceAt(undefined, [target]);
  await expect(
    service.create(
      { at: "9007199254740993d", key: "job", workflow: "target" },
      owner
    )
  ).rejects.toThrow("must be a positive interval");
});

it("constrains file sources and requires explicit HTTP permission", async () => {
  const target = step("target").do(() => 1);
  const service = await serviceAt(undefined, [target]);
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
  const target = step("target").do(() => {
    starts += 1;
    return starts;
  });
  const bound = bindMock(() => "", { root, state });
  const engine = await startEngine({
    ...bound.instances,
    collect: [target],
    root,
    state,
  });
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
    await rollSchedule(engine, schedule, { print: () => undefined });
    await rollSchedule(engine, schedule, { print: () => undefined });
    expect(starts).toBe(1);
    writeFileSync(join(root, "watched.txt"), "second");
    await rollSchedule(engine, schedule, { print: () => undefined });
    expect(starts).toBe(2);
  } finally {
    await engine.stop({ cancel: true });
    await bound.dispose();
  }
});

it("waits for additions to an empty live catalogue", async () => {
  const active: Schedule[] = [];
  const calls: string[] = [];
  const engine = loopEngine(
    () => active,
    (name) => {
      calls.push(name);
    }
  );
  const scheduler = startScheduler(engine);
  await new Promise((resolve) => setTimeout(resolve, 200));
  active.push({
    input: null,
    key: "new",
    kind: "schedule",
    label: "new",
    trigger: { kind: "interval", ms: 50 },
    workflow: "target",
  });
  await vi.waitFor(() => expect(calls).toEqual(["target"]), {
    interval: 50,
    timeout: 10_000,
  });
  await scheduler.stop();
}, 20_000);

it("does not relaunch an observed change after the started target fails", async () => {
  const root = temp();
  const state = temp();
  writeFileSync(join(root, "watched.txt"), "first");
  let starts = 0;
  const target = step("target").do(() => {
    starts += 1;
    throw new Error("target failed");
  });
  const bound = bindMock(() => "", { root, state });
  const engine = await startEngine({
    ...bound.instances,
    collect: [target],
    root,
    state,
  });
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
      rollSchedule(engine, schedule, { print: () => undefined })
    ).rejects.toThrow("target failed");
    await rollSchedule(engine, schedule, { print: () => undefined });
    expect(starts).toBe(1);
  } finally {
    await engine.stop({ cancel: true });
    await bound.dispose();
  }
});

it("existing hosts observe persisted additions, pause, deletion and idempotent retries", async () => {
  const state = temp();
  const target = step("target").do(() => 1);
  const first = await serviceAt(state, [target]);
  const second = await serviceAt(state, [target]);
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
  const target = step("target").do(() => 1);
  const service = await serviceAt(state, [target]);
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

it("retries a pending monitor launch after restart when setup previously failed", async () => {
  const root = temp();
  const state = temp();
  writeFileSync(join(root, "watched.txt"), "first");
  let starts = 0;
  const target = step("target").do(() => {
    starts += 1;
  });
  const bound = bindMock(() => "", { root, state });
  const engine = await startEngine({
    ...bound.instances,
    collect: [target],
    root,
    state,
  });
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
      rollSchedule(engine, schedule, { print: () => undefined })
    ).rejects.toThrow("setup unavailable");
    failing.mockRestore();
    expect(starts).toBe(0);
  } finally {
    await engine.stop({ cancel: true });
  }
  const restarted = await startEngine({
    ...bound.instances,
    collect: [target],
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
    await rollSchedule(restarted, recovered, { print: () => undefined });
    await rollSchedule(restarted, recovered, { print: () => undefined });
    expect(starts).toBe(1);
  } finally {
    await restarted.stop({ cancel: true });
    await bound.dispose();
  }
});

it("cancels a running monitor request when the schedule loop stops", async () => {
  const state = temp();
  let cancelled = false;
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
          () => {
            cancelled = true;
            reject(new Error("request cancelled"));
          },
          { once: true }
        );
      })
  );
  const target = step("target").do(() => 1);
  const statusMonitor = monitor("https://example.com/status").do(
    () => undefined
  );
  const bound = bindMock(() => "", { state });
  const engine = await startEngine({
    ...bound.instances,
    collect: [target, statusMonitor],
    state,
  });
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
    const scheduler = startScheduler(engine);
    await requested;
    await scheduler.stop();
    expect(cancelled).toBe(true);
  } finally {
    mockedFetch.mockRestore();
    await engine.stop({ cancel: true });
    await bound.dispose();
  }
}, 20_000);

it("records a visible failed occurrence when a restored target was removed", async () => {
  const state = temp();
  const target = step("target").do(() => 1);
  const first = await serviceAt(state, [target]);
  const record = await first.create(
    { at: "1s", key: "job", workflow: "target" },
    owner
  );
  const bound = bindMock(() => "", { state });
  const engine = await startEngine({ ...bound.instances, state });
  try {
    const [schedule] = await engine.automations.schedules();
    if (!schedule) {
      throw new Error("Missing restored schedule");
    }
    await expect(
      rollSchedule(engine, schedule, { print: () => undefined })
    ).rejects.toThrow();
    const scheduler = startScheduler(engine);
    await vi.waitFor(
      async () =>
        expect(
          (await occurrencesOf(engine, record.id)).map((each) => each.state)
        ).toContainEqual(
          expect.objectContaining({ kind: "settled", outcome: "failed" })
        ),
      { interval: 100, timeout: 10_000 }
    );
    await scheduler.stop();
  } finally {
    await engine.stop({ cancel: true });
    await bound.dispose();
  }
}, 20_000);

it("preserves the first deadline when restored before it was ever dispatched", async () => {
  const state = temp();
  const target = step("target").do(() => 1);
  const first = await serviceAt(state, [target]);
  const record = await first.create(
    { at: "1s", key: "job", workflow: "target" },
    owner
  );
  const restored = await serviceAt(state, [step("target").do(() => 1)]);
  expect((await restored.list())[0]?.createdAt).toBe(record.createdAt);
  expect((await restored.schedules())[0]?.registeredAt).toBe(
    Date.parse(record.createdAt)
  );
  const [restoredSchedule] = await restored.schedules();
  if (!restoredSchedule) {
    throw new Error("Missing restored schedule");
  }
  expect(
    registration(
      restoredSchedule,
      undefined,
      Date.parse(record.createdAt) + 400
    )?.cadence
  ).toEqual({ afterSettleMs: 1000, initialDelayMs: 600, kind: "delay" });
});

it("isolates pending monitor launches and first deadlines when a deleted key is recreated", async () => {
  const root = temp();
  const state = temp();
  writeFileSync(join(root, "watched.txt"), "first");
  const launched: string[] = [];
  const oldTarget = step("old-target").do(() => {
    launched.push("old");
  });
  const newTarget = step("new-target").do(() => {
    launched.push("new");
  });
  const bound = bindMock(() => "", { root, state });
  const engine = await startEngine({
    ...bound.instances,
    collect: [oldTarget, newTarget],
    root,
    state,
  });
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
      rollSchedule(engine, oldSchedule, { print: () => undefined })
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
    await rollSchedule(engine, newSchedule, { print: () => undefined });
    expect(launched).toEqual(["new"]);
  } finally {
    await engine.stop({ cancel: true });
    await bound.dispose();
  }
});

it("does not dispatch an old trigger after its owner key was recreated", async () => {
  const target = step("target").do(() => 1);
  const service = await serviceAt(undefined, [target]);
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
  let reads = 0;
  const dispatched: string[] = [];
  const engine = loopEngine(
    () => {
      reads += 1;
      return reads === 1 ? [selected] : service.schedules();
    },
    (_name, triggerId) => {
      dispatched.push(triggerId);
    }
  );
  const scheduler = startScheduler(engine);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await scheduler.stop();
  expect(dispatched).not.toContain(original.id);
}, 20_000);
