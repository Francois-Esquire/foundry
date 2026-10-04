import { basename, join } from "node:path";
import type { Artifacts } from "@foundry/artifacts";
import { ArtifactSystem, InMemoryArtifactStore } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";

import type { FeedPublisher } from "~/lib/feed/publish";
import { feedPublisher } from "~/lib/feed/publish";
import type { FeedReader } from "~/lib/feed/read";
import { feedReader } from "~/lib/feed/read";

export interface FeedStore {
  /** The shared store; declared artifacts live in it beside feed entries. */
  readonly artifacts: Artifacts;
  readonly publisher: FeedPublisher;
  readonly read: FeedReader;
}

/**
 * The feed over the shared Artifact store: `<root>/records.json` plus blob
 * files in `<root>/blobs/`. One store serves every workspace; entries carry
 * their workspace so the dashboard can show all or one. `root` undefined
 * keeps everything in memory, which `--dry` always does.
 */
export function openFeed(
  root: string | undefined,
  workspace: { readonly id: string; readonly root: string }
): FeedStore {
  const artifacts: Artifacts =
    root === undefined
      ? new ArtifactSystem({ store: new InMemoryArtifactStore() })
      : new ArtifactSystem({
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
