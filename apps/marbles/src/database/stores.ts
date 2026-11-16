import { join } from "node:path";
import type { ArtifactOperations } from "@foundry/artifacts";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import type { ContainerStore } from "@foundry/sandbox/store";
import { createSqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import type { WorkspaceStore } from "@foundry/workspaces/store";
import { SqliteWorkspaceStore } from "@foundry/workspaces/store/sqlite";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";

export interface WorkspaceStores {
  readonly artifacts: SqliteArtifactStore;
  readonly containers: ContainerStore;
  readonly workspaces: WorkspaceStore;
}

export function workspaceStores(
  database: StoreDatabase,
  scope: string
): WorkspaceStores {
  return {
    artifacts: new SqliteArtifactStore({ database, scope }),
    containers: createSqliteContainerStore({ database, scope }),
    workspaces: new SqliteWorkspaceStore({ database, scope }),
  };
}

export function artifactBlobs(dir: string, scope: string): string {
  return join(dir, "workspaces", scope, "blobs");
}

export function readArtifacts(
  state: string,
  dir: string,
  scope: string
): Pick<ArtifactOperations, "get" | "readFile"> {
  const files = blobFiles(artifactBlobs(dir, scope));
  const read = async <T>(
    work: (artifacts: ArtifactManager) => Promise<T | null>
  ): Promise<T | null> =>
    (await readDatabase(stateDatabase(state), (database) =>
      work(
        new ArtifactManager({
          files,
          store: new SqliteArtifactStore({ database, scope }),
        })
      )
    )) ?? null;
  return {
    get: (id) => read((artifacts) => artifacts.get(id)),
    readFile: (contentId, path) =>
      read((artifacts) => artifacts.readFile(contentId, path)),
  };
}
