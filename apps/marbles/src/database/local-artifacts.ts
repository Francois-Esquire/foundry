import { join } from "node:path";
import type { ArtifactOperations } from "@foundry/artifacts";
import { Artifacts } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { readDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";

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
    work: (artifacts: Artifacts) => Promise<T | null>
  ): Promise<T | null> =>
    (await readDatabase(stateDatabase(state), (database) =>
      work(
        new Artifacts({
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
