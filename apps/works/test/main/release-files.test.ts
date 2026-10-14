import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import type { ModuleVersion } from "@foundry/modules/domain";
import { afterEach, expect, it, vi } from "vitest";
import { modulePersistence } from "~/main/modules/artifact-store";
import { moduleFolder } from "~/main/modules/local-library";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import { createModuleReleaseFiles } from "~/main/modules/runtime/release-files";
import { WORKS_TASKS } from "~/shared/execution";
import { startTestExecution } from "../helpers/execution";
import { installedProcess } from "../helpers/installed-programs";
import { buildResult, TEST_BUILD_RUN } from "../helpers/module-build";
import { DISK_TEST_TIMEOUT_MS } from "../helpers/timeouts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "works-release-files-"));
  directories.push(directory);
  const execution = await startTestExecution();
  /** A Works process over the library file; a second call is a restart. */
  const restart = () => {
    const store = new JsonArtifactStore({
      path: path.join(directory, ".library", "artifacts.json"),
    });
    modulePersistence(store, {
      files: blobFiles(path.join(directory, ".library", "blobs")),
    });
    return installedProcess(store, execution, directory);
  };
  const first = restart();
  const module = await first.library.create("Released");
  return {
    directory,
    execution,
    first,
    folder: moduleFolder(directory, module.id),
    module,
    restart,
  };
}

type Process = ReturnType<typeof installedProcess>;

/** A release whose server output names its tag, so Versions differ on disk. */
async function publish(process: Process, moduleId: string, tag: string) {
  const details = await process.library.details(moduleId);
  if (!details?.binding) {
    throw new Error("Source missing");
  }
  const built = buildResult(details.source);
  const published = await process.library.publish(moduleId, details.binding, {
    ...built,
    builtBy: TEST_BUILD_RUN,
    outputs: {
      ...built.outputs,
      "packages/server/dist/index.js": new TextEncoder().encode(
        `export const tag = "${tag}";`
      ),
    },
    tag,
  });
  return published.version;
}

async function open(process: Process, version: ModuleVersion) {
  await (
    await process.runtime.start(version, new AbortController().signal)
  ).close();
}

/** Every file under `directory`, by relative path. */
async function filesIn(directory: string, prefix = "") {
  const found: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(found, await filesIn(target, `${relative}/`));
    } else {
      found[relative] = await readFile(target, "utf8");
    }
  }
  return found;
}

const outputsOf = (tag: string) => ({
  "outputs/packages/app/dist/index.html": "<!doctype html><h1>Built</h1>",
  "outputs/packages/server/dist/index.js": `export const tag = "${tag}";`,
});

it("projects exactly the selected Version's outputs into a read-only artifact/", {
  timeout: DISK_TEST_TIMEOUT_MS,
}, async () => {
  const { execution, first, folder, module } = await setup();
  const v1 = await publish(first, module.id, "0.1.0");
  const v2 = await publish(first, module.id, "0.2.0");

  await open(first, v1);
  expect(await filesIn(folder.artifact)).toEqual(outputsOf("0.1.0"));
  const file = path.join(
    folder.artifact,
    "outputs/packages/server/dist/index.js"
  );
  // biome-ignore lint/suspicious/noBitwiseOperators: Mode bits are a bitmask.
  expect((await stat(file)).mode & 0o222).toBe(0);
  expect(first.mounted.at(-1)).toBe(folder.artifact);

  await open(first, v2);
  expect(await filesIn(folder.artifact)).toEqual(outputsOf("0.2.0"));
  const selections = execution.runs
    .list()
    .filter((run) => run.name === WORKS_TASKS.select);
  expect(selections).toHaveLength(1);
  expect(selections[0]).toMatchObject({
    correlation: { contentId: v2.contentId, moduleId: module.id },
    observations: [
      {
        data: { contentId: v2.contentId, tag: "0.2.0" },
        kind: "result",
        type: "select",
      },
    ],
    queue: "system",
    status: "complete",
  });

  // The older release is projected again from retained Artifact storage.
  await open(first, v1);
  expect(await filesIn(folder.artifact)).toEqual(outputsOf("0.1.0"));
  expect(
    (await first.modules.loadGatewayContext(moduleInstallationId(module.id)))
      ?.installation.contentId
  ).toBe(v1.contentId);
  expect(
    (await readdir(folder.root)).filter((name) => name.startsWith("."))
  ).toEqual([]);
});

it("keeps the previous selection and its files when a switch fails", {
  timeout: DISK_TEST_TIMEOUT_MS,
}, async () => {
  const { execution, first, folder, module } = await setup();
  const v1 = await publish(first, module.id, "0.1.0");
  const v2 = await publish(first, module.id, "0.2.0");
  await open(first, v1);

  await expect(
    first.releases.select(v2, () =>
      Promise.reject(new Error("selection failed"))
    )
  ).rejects.toThrow("selection failed");
  expect(await filesIn(folder.artifact)).toEqual(outputsOf("0.1.0"));

  vi.spyOn(first.programs, "selectVersion").mockRejectedValueOnce(
    new Error("store unavailable")
  );
  await expect(open(first, v2)).rejects.toThrow("store unavailable");
  expect(await filesIn(folder.artifact)).toEqual(outputsOf("0.1.0"));
  expect(
    (await first.modules.loadGatewayContext(moduleInstallationId(module.id)))
      ?.installation.contentId
  ).toBe(v1.contentId);
  expect(
    execution.runs
      .list()
      .filter((run) => run.name === WORKS_TASKS.select)
      .map((run) => run.status)
  ).toEqual(["failed"]);
  expect(
    (await readdir(folder.root)).filter((name) => name.startsWith("."))
  ).toEqual([]);

  await open(first, v2);
  expect(await filesIn(folder.artifact)).toEqual(outputsOf("0.2.0"));
});

it("reconciles an interrupted switch from the recorded selection on restart", {
  timeout: DISK_TEST_TIMEOUT_MS,
}, async () => {
  const { directory, first, folder, module, restart } = await setup();
  const v1 = await publish(first, module.id, "0.1.0");
  const v2 = await publish(first, module.id, "0.2.0");
  await open(first, v1);

  // Stopped after v2's files were swapped in, before the selection was recorded.
  const elsewhere = path.join(directory, "elsewhere");
  const other = createModuleReleaseFiles({
    artifacts: first.artifacts,
    root: elsewhere,
  });
  const staged = (await other.ensure({ version: v2 })).hostPath;
  await rename(folder.artifact, path.join(folder.root, ".artifact-aside"));
  await rename(staged, folder.artifact);
  await mkdir(path.join(folder.root, ".artifact-staging"));
  const second = restart();
  await open(second, v1);
  expect(await filesIn(folder.artifact)).toEqual(outputsOf("0.1.0"));
  expect(
    (await readdir(folder.root)).filter((name) => name.startsWith("."))
  ).toEqual([]);

  // Stopped between moving the old files aside and placing the new ones.
  await rename(folder.artifact, path.join(folder.root, ".artifact-aside"));
  await open(restart(), v1);
  expect(await filesIn(folder.artifact)).toEqual(outputsOf("0.1.0"));

  // Files changed on disk are replaced by the release's own.
  const server = path.join(
    folder.artifact,
    "outputs/packages/server/dist/index.js"
  );
  await chmod(server, 0o644);
  await writeFile(server, "tampered");
  await open(restart(), v1);
  expect(await filesIn(folder.artifact)).toEqual(outputsOf("0.1.0"));
});
