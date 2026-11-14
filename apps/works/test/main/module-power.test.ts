import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ModuleOffError, ModulePower } from "~/main/modules/power";
import { WORKS_TASKS } from "~/shared/execution";
import { startTestExecution } from "../helpers/execution";
import { fakeModuleSandboxes } from "../helpers/module-sandboxes";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "works-power-"));
  directories.push(directory);
  const execution = await startTestExecution();
  const file = path.join(directory, "module-power.json");
  const stopApps = vi.fn((_moduleId: string) => Promise.resolve());
  let power: ModulePower | undefined;
  const { runtime, sandboxes } = fakeModuleSandboxes(undefined, {
    admit: (moduleId) => power?.admit(moduleId) ?? Promise.resolve(),
  });
  const open = () => {
    const opened = new ModulePower({ execution, file });
    opened.govern({ stop: stopApps });
    opened.govern({
      live: (moduleId) => sandboxes.live().includes(moduleId),
      stop: (moduleId) => sandboxes.stop(moduleId),
    });
    return opened;
  };
  power = open();
  return {
    execution,
    file,
    open: () => {
      power = open();
      return power;
    },
    power,
    runtime,
    sandboxes,
    stopApps,
  };
}

it("turns a Module off with confirmed sandbox cleanup, refuses new work, and back on", async () => {
  const { execution, file, open, power, runtime, sandboxes, stopApps } =
    await setup();
  const loan = await sandboxes.borrow("notes");
  loan.release();
  expect(await power.get("notes")).toEqual({
    moduleId: "notes",
    on: true,
    sandbox: true,
  });

  // Idle while on: the sandbox stays.
  expect(sandboxes.live()).toEqual(["notes"]);

  await expect(power.set("notes", false)).resolves.toEqual({
    moduleId: "notes",
    on: false,
    sandbox: false,
  });
  expect(stopApps).toHaveBeenCalledWith("notes");
  expect(sandboxes.live()).toEqual([]);
  expect(runtime.instances.every((instance) => instance.removed)).toBe(true);
  await expect(power.admit("notes")).rejects.toBeInstanceOf(ModuleOffError);
  await expect(power.admit("other")).resolves.toBeUndefined();
  // The coordinator refuses the Module's work instead of starting a sandbox.
  await expect(sandboxes.borrow("notes")).rejects.toBeInstanceOf(
    ModuleOffError
  );
  expect(sandboxes.live()).toEqual([]);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    format: "works.module-power/1",
    off: ["notes"],
  });

  // Off survives a restart.
  const restarted = open();
  await expect(restarted.admit("notes")).rejects.toBeInstanceOf(ModuleOffError);
  await restarted.set("notes", true);
  await expect(restarted.admit("notes")).resolves.toBeUndefined();
  (await sandboxes.borrow("notes")).release();
  expect(await restarted.get("notes")).toMatchObject({
    on: true,
    sandbox: true,
  });

  const runs = execution.runs
    .list()
    .filter((run) => run.name === WORKS_TASKS.power);
  expect(runs.map((run) => run.status)).toEqual(["complete", "complete"]);
  expect(runs[0]?.observations).toMatchObject([
    { data: { moduleId: "notes", on: false }, type: "power" },
  ]);
});
