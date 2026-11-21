import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { MODULE_SOURCE_LIMITS } from "@foundry/modules/source";
import { expect, it, onTestFinished } from "vitest";
import { createModuleRecords } from "~/main/modules/library";
import {
  moduleFolder,
  openLocalModuleLibrary,
} from "~/main/modules/local-library";
import { fakeClient, openFakeVault } from "../helpers/fake-api";
import { unrecordedSaves } from "../helpers/source-saves";

it("applies the same admission at the save boundary", async () => {
  const client = fakeClient(await openFakeVault());
  await expect(
    client.modules.saveSource({
      expected: {
        artifactId: "a",
        contentId: "c",
        updatedAt: new Date().toISOString(),
      },
      id: "m",
      source: { "../escape.ts": "" },
    })
  ).rejects.toThrow();
  await expect(
    client.modules.saveSource({
      expected: {
        artifactId: "a",
        contentId: "c",
        updatedAt: new Date().toISOString(),
      },
      id: "m",
      source: { big: "x".repeat(MODULE_SOURCE_LIMITS.maxFileCodeUnits + 1) },
    })
  ).rejects.toThrow();
});

it("applies a Module's lower source limits to both editor saves and disk synchronization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "works-source-limits-"));
  onTestFinished(() => rm(root, { force: true, recursive: true }));
  let { maxFiles } = MODULE_SOURCE_LIMITS;
  const records = createModuleRecords(new InMemoryArtifactStore(), {
    sourceLimits: async () => ({ ...MODULE_SOURCE_LIMITS, maxFiles }),
  });
  const library = await openLocalModuleLibrary(root, {
    records,
    saves: unrecordedSaves,
  });
  const module = await library.create("Limited");
  const details = await library.details(module.id);
  if (!details?.binding) {
    throw new Error("missing source");
  }
  maxFiles = Object.keys(details.source).length;
  const source = { ...details.source, "extra.txt": "over the Module's limit" };
  await expect(
    library.saveSource(module.id, source, details.binding)
  ).rejects.toThrow(`the limit is ${maxFiles}`);
  expect((await records.details(module.id))?.source).toEqual(details.source);
  await writeFile(
    path.join(moduleFolder(root, module.id).source, "extra.txt"),
    source["extra.txt"]
  );
  await expect(library.details(module.id)).rejects.toThrow(
    `the limit is ${maxFiles}`
  );
  expect((await records.details(module.id))?.source).toEqual(details.source);
});
