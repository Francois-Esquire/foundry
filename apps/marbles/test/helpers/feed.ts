import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ArtifactSubstrate } from "@foundry/artifacts";
import { Artifacts } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import type { FeedPublisher } from "~/lib/feed/publish";
import { feedPublisher } from "~/lib/feed/publish";
import type { FeedReader } from "~/lib/feed/read";
import { feedReader } from "~/lib/feed/read";

export interface FeedStore {
  readonly artifacts: ArtifactSubstrate;
  readonly publisher: FeedPublisher;
  readonly read: FeedReader;
}

export function openFeed(
  root: string | undefined,
  workspace: { readonly id: string; readonly root: string }
): FeedStore {
  const artifacts: ArtifactSubstrate =
    root === undefined
      ? new Artifacts({ store: new MemoryArtifactStore() })
      : new Artifacts({
          files: blobFiles(join(root, "blobs")),
          store: new JsonArtifactStore({ path: join(root, "records.json") }),
        });
  return {
    artifacts,
    publisher: feedPublisher(
      artifacts,
      {
        id: workspace.id,
        name: basename(workspace.root),
        root: workspace.root,
      },
      { readMedia: (path) => readFile(path) }
    ),
    read: feedReader(artifacts),
  };
}
