import { basename, join } from "node:path";
import type { Artifacts } from "@foundry/artifacts";
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import type { FeedPublisher } from "~/lib/feed/publish";
import { feedPublisher } from "~/lib/feed/publish";
import type { FeedReader } from "~/lib/feed/read";
import { feedReader } from "~/lib/feed/read";

export interface FeedStore {
  /** Hand this to an engine and it publishes to, and reads, the same feed. */
  readonly artifacts: Artifacts;
  readonly publisher: FeedPublisher;
  readonly read: FeedReader;
}

/**
 * The feed as an engine builds it over an artifact system, held open for a
 * test to publish and read directly: `<root>/records.json` plus blob files,
 * or memory when `root` is undefined.
 */
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
