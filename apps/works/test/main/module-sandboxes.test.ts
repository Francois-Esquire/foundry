import { describe, expect, it, vi } from "vitest";
import { createBuildRuntime } from "~/main/modules/builds/runtime";
import { worksCapabilityCatalog } from "~/main/modules/capabilities";
import { SandboxCapacity } from "~/main/modules/sandboxes/capacity";
import { fakeModuleSandboxes } from "../helpers/module-sandboxes";

const GIB = 1024 ** 3;
/** Beside the build's scratch directory, never inside it. */
const CATALOG_PATH = /^\/builds\/[^/]+\.catalog\.json$/u;
const CATALOG_SUFFIX = /\.catalog\.json$/u;
const SCRATCH_TMP = /^\/builds\/[^/]+\.tmp$/u;
const SOURCE = {
  "package.json": "{}",
  "packages/app/src/index.ts": "export {};",
};

async function settled(promise: Promise<unknown>) {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  return done;
}

describe("Module sandbox coordinator", () => {
  it("reuses one sandbox for repeated builds of a Module, each in its own scratch directory", async () => {
    const { runtime, sandboxes } = fakeModuleSandboxes();
    const builds = createBuildRuntime(sandboxes);
    const progress = vi.fn();
    for (const _ of [1, 2]) {
      const built = await builds.run({
        moduleId: "module-a",
        progress,
        signal: new AbortController().signal,
        source: SOURCE,
      });
      expect(Object.keys(built.outputs).sort()).toEqual([
        "packages/app/dist/index.html",
        "packages/server/dist/index.js",
      ]);
    }
    expect(runtime.instances).toHaveLength(1);
    expect(sandboxes.live()).toEqual(["module-a"]);
    const [instance] = runtime.instances;
    const directories = new Set(
      instance?.commands
        .filter(([program]) => program === "rm")
        .map((command) => command.at(-1))
    );
    expect(directories.size).toBe(2);
    // Scratch directories are gone; the sandbox stays on, idle.
    expect([...(instance?.files.keys() ?? [])]).toEqual([]);
    expect(instance?.stopped).toBe(false);
    await sandboxes.shutdown();
  });

  it("hands each build Works' Gateway catalog beside its scratch directory", async () => {
    const { executions, sandboxes } = fakeModuleSandboxes();
    const catalog = worksCapabilityCatalog();
    await createBuildRuntime(sandboxes).run({
      moduleId: "module-a",
      progress: vi.fn(),
      signal: new AbortController().signal,
      source: SOURCE,
    });
    const steps = executions.filter((step) => step.command[0] === "bun");
    expect(steps.map((step) => step.command.slice(1, 3))).toEqual([
      ["install", "--ignore-scripts"],
      ["run", "generate"],
      ["run", "typecheck"],
      ["run", "build"],
    ]);
    for (const step of steps) {
      expect(step.env.FOUNDRY_MODULE_CATALOG_PATH).toMatch(CATALOG_PATH);
      expect(JSON.parse(step.catalog ?? "null")).toEqual(catalog);
      // As root, in a directory only root may enter, with its own temp dir:
      // an authoring turn works as another user and cannot reach it.
      expect(step.user).toBe("root");
      expect(step.env.TMPDIR).toBe(
        `${step.env.FOUNDRY_MODULE_CATALOG_PATH?.replace(CATALOG_SUFFIX, "")}.tmp`
      );
    }
    expect(
      executions.find((step) => step.command.includes("scratch"))
    ).toMatchObject({
      command: [
        "sh",
        "-c",
        'mkdir -p "$1" && chmod 0700 "$1" && mkdir -m 0700 "$2"',
        "scratch",
        "/builds",
        expect.stringMatching(SCRATCH_TMP),
      ],
      user: "root",
    });
    expect(
      catalog.capabilities.map((capability) => capability.capability)
    ).toContain("works.system.theme");
    await sandboxes.shutdown();
  });

  it("starts authoring/build sandboxes with internet, Module source only, and the 2 GiB default", async () => {
    const { runtime, sandboxes } = fakeModuleSandboxes();
    const loan = await sandboxes.borrow("module-a");
    const { spec } = runtime.instances[0] ?? {};
    expect(spec).toMatchObject({
      disableNetwork: false,
      env: {},
      memoryMib: 2048,
      mounts: [],
      network: "unrestricted",
    });
    loan.release();
    await sandboxes.shutdown();
  });

  it("starts each Module's sandbox with its effective CPU and memory settings", async () => {
    const resources = vi.fn((moduleId: string) =>
      moduleId === "module-a"
        ? Promise.resolve({ cpus: 2, memoryBytes: GIB })
        : Promise.reject(new Error("Module settings cannot be met"))
    );
    const { capacity, runtime, sandboxes } = fakeModuleSandboxes(
      { memoryBytes: 8 * GIB, sandboxes: 4 },
      { resources }
    );
    const loan = await sandboxes.borrow("module-a");
    expect(runtime.instances[0]?.spec).toMatchObject({
      cpus: 2,
      memoryMib: 1024,
    });
    expect(capacity.usage()).toMatchObject({ memoryBytes: GIB, sandboxes: 1 });
    // An unmet requirement fails that start before any VM or reservation.
    await expect(sandboxes.borrow("module-b")).rejects.toThrow(
      "Module settings cannot be met"
    );
    expect(runtime.instances).toHaveLength(1);
    loan.release();
    await sandboxes.shutdown();
  });

  it("routes concurrent requests for one Module to one starting sandbox", async () => {
    const { runtime, sandboxes } = fakeModuleSandboxes();
    const loans = await Promise.all([
      sandboxes.borrow("module-a"),
      sandboxes.borrow("module-a"),
      sandboxes.borrow("module-a"),
    ]);
    expect(runtime.instances).toHaveLength(1);
    expect(new Set(loans.map((loan) => loan.container.id)).size).toBe(1);
    for (const loan of loans) {
      loan.release();
    }
    await sandboxes.shutdown();
  });

  it("makes a request beyond the live-sandbox ceiling wait, not fail, until a Module is turned off", async () => {
    const { runtime, sandboxes } = fakeModuleSandboxes({
      memoryBytes: 8 * GIB,
      sandboxes: 1,
    });
    const first = await sandboxes.borrow("module-a");
    first.release();
    const waiting = vi.fn();
    const second = sandboxes.borrow("module-b", { waiting });
    expect(await settled(second)).toBe(false);
    expect(waiting).toHaveBeenCalledOnce();
    expect(runtime.instances).toHaveLength(1);
    // An idle sandbox is not evicted to make room.
    expect(sandboxes.live()).toEqual(["module-a"]);
    await sandboxes.stop("module-a");
    const loan = await second;
    expect(loan.moduleId).toBe("module-b");
    expect(runtime.instances).toHaveLength(2);
    loan.release();
    await sandboxes.shutdown();
  });

  it("makes a request beyond the memory ceiling wait too", async () => {
    const { sandboxes } = fakeModuleSandboxes({
      memoryBytes: 4 * GIB,
      sandboxes: 4,
    });
    const first = await sandboxes.borrow("module-a");
    const second = await sandboxes.borrow("module-b");
    const third = sandboxes.borrow("module-c");
    expect(await settled(third)).toBe(false);
    // Shutdown withdraws the waiting request and waits for borrowers.
    const stopping = sandboxes.shutdown();
    await expect(third).rejects.toThrow();
    expect(await settled(stopping)).toBe(false);
    first.release();
    second.release();
    await stopping;
  });

  it("turns a Module off only after its borrowers release, with confirmed removal", async () => {
    const { runtime, sandboxes } = fakeModuleSandboxes();
    const loan = await sandboxes.borrow("module-a");
    const stopped = sandboxes.stop("module-a");
    expect(loan.signal.aborted).toBe(true);
    expect(await settled(stopped)).toBe(false);
    expect(runtime.instances[0]?.removed).toBe(false);
    loan.release();
    await stopped;
    expect(runtime.instances[0]).toMatchObject({
      removed: true,
      stopped: true,
    });
    expect(sandboxes.live()).toEqual([]);
    // The next request starts a fresh sandbox.
    (await sandboxes.borrow("module-a")).release();
    expect(runtime.instances).toHaveLength(2);
    await sandboxes.shutdown();
  });

  it("removes every sandbox at host shutdown and refuses new requests", async () => {
    const { runtime, sandboxes } = fakeModuleSandboxes();
    (await sandboxes.borrow("module-a")).release();
    (await sandboxes.borrow("module-b")).release();
    await sandboxes.shutdown();
    expect(runtime.instances.every((instance) => instance.removed)).toBe(true);
    await expect(sandboxes.borrow("module-a")).rejects.toThrow("shutting down");
  });

  it("frees nothing for a borrower that gives up while waiting", async () => {
    const { capacity, sandboxes } = fakeModuleSandboxes({
      memoryBytes: 8 * GIB,
      sandboxes: 1,
    });
    (await sandboxes.borrow("module-a")).release();
    const cancel = new AbortController();
    const waiting = sandboxes.borrow("module-b", { signal: cancel.signal });
    cancel.abort();
    await expect(waiting).rejects.toThrow();
    expect(capacity.usage()).toMatchObject({ sandboxes: 1 });
    await sandboxes.shutdown();
    expect(capacity.usage()).toEqual({
      memoryBytes: 0,
      sandboxes: 0,
      waiting: 0,
    });
  });
});

describe("Sandbox capacity", () => {
  it("admits first come first served and counts Programs and Module sandboxes together", async () => {
    const capacity = new SandboxCapacity({
      memoryBytes: 3 * GIB,
      sandboxes: 4,
    });
    const moduleSandbox = await capacity.acquire(2 * GIB);
    const program = await capacity.acquire(GIB / 2);
    const big = capacity.acquire(2 * GIB);
    // A later request that would fit does not overtake the one waiting.
    const small = capacity.acquire(GIB / 4);
    expect(await settled(big)).toBe(false);
    expect(await settled(small)).toBe(false);
    moduleSandbox.release();
    await big;
    await small;
    program.release();
    expect(capacity.usage()).toMatchObject({ waiting: 0 });
  });

  it("refuses only a request that could never fit", async () => {
    const capacity = new SandboxCapacity({
      memoryBytes: 2 * GIB,
      sandboxes: 1,
    });
    await expect(capacity.acquire(3 * GIB)).rejects.toThrow("more than");
  });
});
