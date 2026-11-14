import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { moduleQueue, type WorksExecution } from "~/main/execution/contract";
import { moduleFolder } from "~/main/modules/local-library";
import { WORKS_TASKS } from "~/shared/execution";
import { COMPOSED_WORKS_TIMEOUT_MS, composeTestWorks } from "../helpers/works";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** The starter's Manifest in the strict format, asking for `concurrency` workflow runs. */
function manifestWith(legacy: string | undefined, concurrency: number) {
  return JSON.stringify({
    ...(JSON.parse(legacy ?? "{}") as object),
    format: "foundry.module-manifest/1",
    persistence: { files: "installation" },
    settings: { "queues.workflows.concurrency": { default: concurrency } },
  });
}

it("applies a Module's queue settings when it is created and whenever its Manifest changes", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, async () => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "works-composed-"))
  );
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const { works } = await composeTestWorks(directory);
  cleanups.push(() => works.close());
  const module = await works.rpc.modules.create("Queued");
  const concurrency = () =>
    works.testing.execution.runs
      .queues()
      .find((queue) => queue.name === moduleQueue(module.id, "workflows"))
      ?.concurrency;
  // Created after startup: its queues already follow its settings.
  expect(concurrency()).toBe(1);

  // A source save that asks for more takes effect at once.
  const details = await works.rpc.modules.details(module.id);
  if (!details?.binding) {
    throw new Error("Starter binding missing");
  }
  const legacy = details.source["foundry.module.json"];
  await works.rpc.modules.saveSource(
    module.id,
    { ...details.source, "foundry.module.json": manifestWith(legacy, 3) },
    details.binding
  );
  expect(concurrency()).toBe(3);

  // So does a disk edit, once Works picks it up.
  await writeFile(
    path.join(
      moduleFolder(path.join(directory, "modules"), module.id).source,
      "foundry.module.json"
    ),
    manifestWith(legacy, 2)
  );
  await works.rpc.modules.details(module.id);
  expect(concurrency()).toBe(2);
});

it("closes the engine and what else had opened when startup fails partway", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, async () => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "works-composed-"))
  );
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  let execution: Pick<WorksExecution, "dispatch"> | undefined;
  await expect(
    composeTestWorks(directory, {
      programs(runtime) {
        ({ execution } = runtime);
        return Promise.reject(new Error("No Program runtime here"));
      },
    })
  ).rejects.toThrow("No Program runtime here");
  // The engine started before the failure, and was stopped by it.
  expect(execution).toBeDefined();
  await expect(
    execution?.dispatch(WORKS_TASKS.power, {}, () => Promise.resolve())
  ).rejects.toThrow();
  // So the same directory composes again.
  const { works } = await composeTestWorks(directory);
  await works.close();
});
