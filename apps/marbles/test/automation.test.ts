import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { monitor } from "~/authoring/triggers";
import { readTriggers } from "~/create";
import {
  type AutomationOwner,
  AutomationService,
} from "~/lib/automation/service";
import type { ScheduledEngine } from "~/lib/schedule";
import { runSchedules, tick } from "~/lib/schedule";
import { readJson } from "~/lib/state/json";
import type { StateStore } from "~/lib/state/store";
import { InMemoryStateStore, JsonStateStore } from "~/lib/state/store";
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
function storeAt(state?: string): StateStore {
  return state === undefined
    ? new InMemoryStateStore()
    : new JsonStateStore(state);
}

/** A host's service over what the catalog declares; each host has its own registry. */
function serviceAt(state?: string): AutomationService {
  return new AutomationService({
    registry: declared(),
    store: storeAt(state),
  });
}

/** An engine as the scheduler sees it: live triggers, a store, and a stub launch. */
function loopEngine(
  schedules: () => readonly Schedule[],
  launch: (name: string) => void,
  store: StateStore = new InMemoryStateStore()
): ScheduledEngine {
  return {
    cancel: async () => undefined,
    has: () => true,
    launch: async (name: string) => {
      launch(name);
      return { id: "run", result: Promise.resolve(undefined) };
    },
    schedules,
    store,
  } as ScheduledEngine;
}

afterEach(() => {
  catalog.reset();
  for (const path of directories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

it("persists declarative records, keeps stable ids and restores enabled state", async () => {
  const state = temp();
  step("target")
    .input(z.object({ value: z.number() }))
    .do(({ input }) => input.value);
  const service = serviceAt(state);
  const spec = {
    at: "1h",
    input: { value: 2 },
    key: "hourly",
    workflow: "target",
  };
  const record = await service.create(spec, owner);
  expect(await service.create(spec, owner)).toEqual(record);
  service.setEnabled(record.id, false, owner);
  catalog.reset();
  step("target").do(() => 2);
  const restored = serviceAt(state);
  expect(restored.list()).toEqual([{ ...record, enabled: false }]);
  expect(restored.schedules()).toHaveLength(0);
  restored.setEnabled(record.id, true);
  expect(restored.schedules()[0]?.key).toBe(record.id);
  restored.delete(record.id);
  expect(restored.list()).toHaveLength(0);
});

it("rejects changed idempotency keys, invalid target input and foreign mutation", async () => {
  step("target")
    .input(z.object({ value: z.number() }))
    .do(() => 1);
  const service = serviceAt();
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
  expect(() =>
    service.delete(record.id, { ...owner, sessionId: "other" })
  ).toThrow("another agent");
});

it("rejects a cadence too long to schedule", async () => {
  step("target").do(() => 1);
  const service = serviceAt();
  await expect(
    service.create(
      { at: "9007199254740993d", key: "job", workflow: "target" },
      owner
    )
  ).rejects.toThrow("must be a positive interval");
});

it("constrains file sources and requires explicit HTTP permission", async () => {
  step("target").do(() => 1);
  const service = serviceAt();
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
    const schedule = service
      .schedules()
      .find((entry) => entry.key === record.id);
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
    const [schedule] = service.schedules();
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
  const first = serviceAt(state);
  const second = serviceAt(state);
  const spec = { at: "1s", key: "job", workflow: "target" };
  const record = await first.create(spec, owner);
  expect(second.list()).toEqual([record]);
  expect(await second.create(spec, owner)).toEqual(record);
  second.setEnabled(record.id, false, owner);
  expect(first.schedules()).toHaveLength(0);
  first.delete(record.id, owner);
  expect(second.list()).toHaveLength(0);
  expect(() => second.setEnabled(record.id, true, owner)).toThrow("missing");
});

it("fails closed on invalid persisted sources while exposing a host-readable error", () => {
  const state = temp();
  step("target").do(() => 1);
  const service = serviceAt(state);
  mkdirSync(join(state, "automations"));
  writeFileSync(join(state, "automations", "broken.json"), "bad JSON", {
    flag: "w",
  });
  expect(service.errors().broken).toContain("SyntaxError");
  expect(service.schedules()).toHaveLength(0);
});

it("rechecks completion and live membership under the schedule lock", async () => {
  const state = temp();
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
    new JsonStateStore(state)
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
  const [schedule] = first.schedules();
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
    const [recovered] = restored.schedules();
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
    const schedule = service
      .schedules()
      .find((candidate) => candidate.label === "watch");
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
  const first = readTriggers(catalog, {
    dry: false,
    stateDir: state,
  }).automations;
  const record = await first.create(
    { at: "1s", key: "job", workflow: "target" },
    owner
  );
  catalog.reset();
  const bound = bindMock(() => "", { state });
  const engine = await startEngine({ ...bound.instances, state });
  try {
    const [schedule] = engine.automations.schedules();
    if (!schedule) {
      throw new Error("Missing restored schedule");
    }
    await expect(
      tick(engine, schedule, { print: () => undefined })
    ).rejects.toThrow();
    expect(
      readJson(join(state, "schedules", `${record.id}.json`))
    ).toMatchObject({ lastStatus: "failed" });
  } finally {
    await engine.stop({ cancel: true });
    await bound.dispose();
  }
});

it("preserves the first firing deadline when restored before any tick history exists", async () => {
  const state = temp();
  step("target").do(() => 1);
  const first = serviceAt(state);
  const record = await first.create(
    { at: "1s", key: "job", workflow: "target" },
    owner
  );
  catalog.reset();
  step("target").do(() => 1);
  const restored = serviceAt(state);
  expect(restored.list()[0]?.createdAt).toBe(record.createdAt);
  expect(restored.schedules()[0]?.registeredAt).toBe(
    Date.parse(record.createdAt)
  );
  let now = Date.parse(record.createdAt) + 400;
  const waits: number[] = [];
  const controller = new AbortController();
  const engine = loopEngine(
    () => restored.schedules(),
    () => controller.abort(),
    new JsonStateStore(state)
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
    const [oldSchedule] = service.schedules();
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
    service.delete(original.id, owner);
    const recreated = await service.create(
      {
        at: "1s",
        key: "watch",
        source: { glob: "*.txt", kind: "files" },
        workflow: "new-target",
      },
      owner
    );
    const [newSchedule] = service.schedules();
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
  const service = serviceAt();
  const original = await service.create(
    { at: "1s", key: "job", workflow: "target" },
    owner
  );
  const [selected] = service.schedules();
  if (!selected) {
    throw new Error("Missing old generation");
  }
  service.delete(original.id, owner);
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

it("re-reads the store only when it changed, and picks up another writer's record", async () => {
  const state = temp();
  step("target").do(() => 1);
  const disk = new JsonStateStore(state);
  let lists = 0;
  const counted: StateStore = {
    list: (collection) => {
      lists += 1;
      return disk.list(collection);
    },
    lock: (name) => disk.lock(name),
    read: (collection, key) => disk.read(collection, key),
    remove: (collection, key) => disk.remove(collection, key),
    revision: (collection) => disk.revision(collection),
    write: (collection, key, value) => disk.write(collection, key, value),
  };
  const reader = new AutomationService({
    registry: declared(),
    store: counted,
  });
  expect(reader.schedules()).toEqual([]);
  const settled = lists;
  // Nothing changed: the loop's once-a-second reads touch no record.
  reader.schedules();
  reader.list();
  reader.errors();
  expect(lists).toBe(settled);

  // Another host creates one through its own service.
  const record = await serviceAt(state).create(
    { at: "1h", key: "hourly", workflow: "target" },
    owner
  );
  expect(reader.schedules().map((schedule) => schedule.key)).toEqual([
    record.id,
  ]);
  expect(lists).toBe(settled + 1);
  reader.schedules();
  expect(lists).toBe(settled + 1);

  // Another process writes a record file directly, with no service at all.
  const id = `automation-${"b".repeat(24)}`;
  writeFileSync(
    join(state, "automations", `${id}.json`),
    JSON.stringify({ ...record, id, key: "by-hand" })
  );
  expect(
    reader
      .schedules()
      .map((schedule) => schedule.label)
      .sort()
  ).toEqual(["by-hand", "hourly"]);
  expect(reader.list().map((entry) => entry.id)).toContain(id);

  // And removes it again.
  rmSync(join(state, "automations", `${id}.json`));
  expect(reader.schedules().map((schedule) => schedule.key)).toEqual([
    record.id,
  ]);
});

it("keeps an in-memory host's records in its own store", async () => {
  step("target").do(() => 1);
  const store = new InMemoryStateStore();
  const first = new AutomationService({ registry: declared(), store });
  const record = await first.create(
    { at: "1h", key: "hourly", workflow: "target" },
    owner
  );
  // A second service over the same store sees it; a fresh store does not.
  const second = new AutomationService({ registry: declared(), store });
  expect(second.schedules().map((schedule) => schedule.key)).toEqual([
    record.id,
  ]);
  expect(serviceAt().list()).toEqual([]);
});
