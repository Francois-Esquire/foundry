import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directory,
  MemoryWorkspaceStore,
  WorkspaceSystem,
} from "@foundry/workspaces";
import { onTestFinished } from "vitest";
import { ArtifactManager } from "../../manager";
import { InMemoryArtifactStore } from "../../memory";
import { artifactFileSystem, blobFiles } from "../../node";
import type { EntryInputs } from "../../substrate";

export async function fixture(entries: EntryInputs = {}, files = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "artifact-directory-"))
  );
  const store = new InMemoryArtifactStore();
  const artifacts = new ArtifactManager({
    store,
    ...(files ? { files: blobFiles(join(root, ".blobs")) } : {}),
  });
  const filesystem = artifactFileSystem({ artifacts, root });
  const catalog = new MemoryWorkspaceStore();
  const system = new WorkspaceSystem({ store: catalog }).extend(
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
