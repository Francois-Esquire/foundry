import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { auditRun } from "~/main/execution/audit";
import { routeModuleLibrary } from "~/main/execution/library";
import { SourceEvidence } from "~/main/execution/source-evidence";
import { modulePersistence } from "~/main/modules/artifact-store";
import { moduleFolder } from "~/main/modules/local-library";
import { artifactSaves } from "~/shared/audit";
import { WORKS_TASKS } from "~/shared/execution";
import { startTestExecution } from "../helpers/execution";
import { FlakyJsonStateStore } from "../helpers/flaky-state";
import { buildResult } from "../helpers/module-build";
import { openTestLocalLibrary } from "../helpers/source-saves";

const APP = "packages/app/src/App.tsx";
/** Each test creates and materializes a starter Module on disk: slow under a full parallel run, not racy. */
const LOAD_BOUND = { timeout: 30_000 };
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, maxRetries: 5, recursive: true });
  }
});

/**
 * One Works process as main wires it: a durable engine whose result writes
 * can fail, and the local library with source evidence on every save path.
 */
async function open(root: string) {
  const state = new FlakyJsonStateStore(path.join(root, "engine", "state"));
  const execution = await startTestExecution({
    directory: path.join(root, "engine"),
    store: state,
  });
  const { library, store } = await openTestLocalLibrary(
    path.join(root, "modules"),
    { execution }
  );
  const modules = routeModuleLibrary(library, execution);
  const saves = () =>
    artifactSaves(execution.runs.list().map(auditRun)).filter(
      (row) => row.kind === "source"
    );
  const named = (name: string) =>
    execution.runs.list().filter((run) => run.name === name);
  return { execution, modules, named, saves, state, store };
}

async function temporary() {
  const root = await mkdtemp(path.join(tmpdir(), "works-source-evidence-"));
  roots.push(root);
  return root;
}

it(
  "blocks a Module's next save while its last save's result is unrecorded, then records it first",
  LOAD_BOUND,
  async () => {
    const root = await temporary();
    const works = await open(root);
    const module = await works.modules.create("Evidence");
    const details = await works.modules.details(module.id);
    if (!details?.binding) {
      throw new Error("binding missing");
    }

    works.state.failing = true;
    const saved = await works.modules.saveSource(
      module.id,
      { ...details.source, [APP]: "saved, unrecorded" },
      details.binding
    );
    // Committed, with its origin stamped in the same write.
    const artifact = (
      await modulePersistence(works.store).modules.moduleArtifacts()
    ).find((candidate) => candidate.metadata.moduleId === module.id);
    const [unrecorded] = works.named(WORKS_TASKS.save);
    expect(artifact?.content?.metadata.origin).toMatchObject({
      actor: "user",
      kind: "source",
      runId: unrecorded?.id,
    });
    await expect(
      works.modules.saveSource(
        module.id,
        { ...details.source, [APP]: "must wait" },
        saved
      )
    ).rejects.toThrow("could not record it yet");
    expect((await works.modules.details(module.id))?.source[APP]).toBe(
      "saved, unrecorded"
    );

    works.state.failing = false;
    await works.modules.saveSource(
      module.id,
      { ...details.source, [APP]: "after recovery" },
      saved
    );
    const [recovery] = works.named(WORKS_TASKS.sourceRecover);
    expect(recovery?.observations).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          contentId: saved.contentId,
          kind: "source",
          recoveredFrom: unrecorded?.id,
        }),
        type: "save",
      }),
    ]);
    // Artifact Saves lists each committed save once.
    expect(
      works.saves().map((row) => [row.origin, row.recoveredFrom !== undefined])
    ).toEqual([
      ["user", false],
      ["user", true],
    ]);
  }
);

it(
  "recovers an unrecorded save at startup, and holds disk edits back until it can",
  LOAD_BOUND,
  async () => {
    const root = await temporary();
    const first = await open(root);
    const module = await first.modules.create("Restarted");
    const details = await first.modules.details(module.id);
    if (!details?.binding) {
      throw new Error("binding missing");
    }
    first.state.failing = true;
    await first.modules.saveSource(
      module.id,
      { ...details.source, [APP]: "before the crash" },
      details.binding
    );
    // While blocked, disk edits wait on disk rather than being saved.
    const file = path.join(
      moduleFolder(path.join(root, "modules"), module.id).source,
      APP
    );
    await writeFile(file, "edited on disk");
    expect((await first.modules.details(module.id))?.source[APP]).toBe(
      "before the crash"
    );
    await first.execution.close();

    // The next process records the missing result before anything else saves.
    const second = await open(root);
    // (The first process's own recovery attempt could not be recorded either.)
    const recovery = second
      .named(WORKS_TASKS.sourceRecover)
      .find((run) => run.status === "complete");
    expect(recovery?.observations).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "source",
          recoveredFrom: expect.any(String),
        }),
      }),
    ]);
    // Then the held disk edits are saved as a disk sync.
    expect((await second.modules.details(module.id))?.source[APP]).toBe(
      "edited on disk"
    );
    expect(second.named(WORKS_TASKS.sourceSync)).toHaveLength(1);
    expect(second.saves().map((row) => row.origin)).toEqual(
      expect.arrayContaining(["disk", "user"])
    );
  }
);

it(
  "stamps a release's origin in its publish, attributing a build's publish to the build",
  LOAD_BOUND,
  async () => {
    const root = await temporary();
    const works = await open(root);
    const module = await works.modules.create("Released");
    const details = await works.modules.details(module.id);
    if (!details?.binding) {
      throw new Error("binding missing");
    }
    // A build's publish names the build run, as `ModuleBuilds` publishes.
    let build = "";
    const { binding, version } = await works.execution.dispatch(
      WORKS_TASKS.build,
      { correlation: { moduleId: module.id } },
      (context) => {
        build = context.run.id;
        return works.modules.publish(module.id, details.binding as never, {
          ...buildResult(details.source),
          builtBy: build,
          tag: "1.0.0",
        });
      }
    );
    const content = await modulePersistence(works.store).artifacts.getContent(
      version.contentId as never
    );
    expect(content?.metadata.origin).toMatchObject({
      actor: "build",
      kind: "release",
      parentRunId: build,
    });
    expect(binding.contentId).toBe(version.contentId);
  }
);

it("surfaces a fault while reconciling instead of asking to save again later", async () => {
  const fault = new Error("Module records are unreadable");
  const evidence = new SourceEvidence({
    execution: await startTestExecution(),
    modules: { moduleArtifacts: () => Promise.reject(fault) },
  });

  await expect(evidence.admit("module-1")).rejects.toBe(fault);
});
