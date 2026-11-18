import { basename, join } from "node:path";
import type { Artifacts } from "@foundry/artifacts";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import { InMemoryArtifactStore } from "@foundry/artifacts/store/memory";
import type { FeedPublisher } from "~/lib/feed/publish";
import { feedPublisher } from "~/lib/feed/publish";
import type { FeedReader } from "~/lib/feed/read";
import { feedReader } from "~/lib/feed/read";

export interface FeedStore {
  readonly artifacts: Artifacts;
  readonly publisher: FeedPublisher;
  readonly read: FeedReader;
}

export function openFeed(
  root: string | undefined,
  workspace: { readonly id: string; readonly root: string }
): FeedStore {
  const artifacts: Artifacts =
    root === undefined
      ? new ArtifactManager({ store: new InMemoryArtifactStore() })
      : new ArtifactManager({
          files: blobFiles(join(root, "blobs")),
          store: new JsonArtifactStore({ path: join(root, "records.json") }),
        });
  return {
    artifacts,
    publisher: feedPublisher(artifacts, {
      id: workspace.id,
      name: basename(workspace.root),
      root: workspace.root,
    }),
    read: feedReader(artifacts),
  };
}
