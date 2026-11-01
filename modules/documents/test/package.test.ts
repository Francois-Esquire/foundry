import { readFile } from "node:fs/promises";
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { importModulePackage } from "@foundry/modules/package";
import { createArtifactModuleStore } from "@foundry/modules/store/artifact";
import { expect, it } from "vitest";
import { DOCUMENTS_PACKAGE_PATH } from "../src";

/** The package `bun run build` wrote (the test task runs after the build). */
it("imports as a strict release registering a Markdown write editor", async () => {
  const artifacts = new ArtifactManager({ store: new InMemoryArtifactStore() });
  const version = await importModulePackage({
    artifacts,
    encoded: await readFile(DOCUMENTS_PACKAGE_PATH, "utf8"),
    modules: createArtifactModuleStore(artifacts),
  });
  expect(version).toMatchObject({
    manifest: {
      editors: [
        { mimeTypes: ["text/markdown"], mode: "write", view: "editor" },
      ],
      format: "foundry.module-manifest/1",
      program: { entry: "outputs/program.js" },
    },
    moduleId: "markdown-fixture",
    tag: "1.0.0",
  });
  const content = await artifacts.getContent(version.contentId);
  expect(
    Object.entries(content?.tree ?? {})
      .filter(([, node]) => node.type === "file")
      .map(([path]) => path)
      .sort()
  ).toEqual([
    "outputs/program.js",
    "outputs/sdk.js",
    "outputs/view.html",
    "outputs/view.js",
    "outputs/workflows.html",
    "outputs/workflows.js",
  ]);
});
