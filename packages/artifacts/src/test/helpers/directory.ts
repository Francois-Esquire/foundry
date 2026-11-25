import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directory, Workspaces } from "@foundry/workspaces";
import { MemoryWorkspaceStore } from "@foundry/workspaces/store/memory";
import { onTestFinished } from "vitest";
import { ArtifactManager } from "../../manager";
import {
  type ArtifactFileSystemOptions,
  artifactFileSystem,
  blobFiles,
} from "../../node";
import type { EntryInputs } from "../../substrate";
import { openStore, type StoreKind } from "./stores";

export async function fixture(
  entries: EntryInputs = {},
  files = false,
  options: Omit<ArtifactFileSystemOptions, "artifacts" | "root"> = {},
  kind: StoreKind = "memory"
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "artifact-directory-"))
  );
  const store = await openStore(kind);
  const artifacts = new ArtifactManager({
    store,
    ...(files ? { files: blobFiles(join(root, ".blobs")) } : {}),
  });
  const filesystem = artifactFileSystem({ artifacts, root, ...options });
  const catalog = new MemoryWorkspaceStore();
  const system = new Workspaces({ store: catalog }).extend(
    directory({ filesystem, source: "artifact" })
  );
  onTestFinished(async () => {
    await system.closeAll();
    await filesystem.close();
    await rm(root, { force: true, recursive: true });
  });
  const artifact = await artifacts.create({
    entries,
    name: "Fixture",
    type: "text/plain",
  });
  return {
    artifact,
    artifacts,
    catalog,
    filesystem,
    load: () => system.load({ artifactId: artifact.id }),
    root,
    store,
    system,
  };
}

export async function publishedFiles(root: string): Promise<string[]> {
  return (await readdir(join(root, ".blobs"))).filter(
    (name) => name !== ".staging"
  );
}
