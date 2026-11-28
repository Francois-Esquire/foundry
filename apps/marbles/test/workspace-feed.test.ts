import { join } from "node:path";
import { Artifacts } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { describe, expect, it } from "vitest";
import { artifactBlobs } from "~/database/local-artifacts";
import type { StoreDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import { feedPublisher } from "~/lib/feed/publish";
import { feedReader } from "~/lib/feed/read";
import { ALL_WORKSPACES, scopedFeed } from "~/tui/state/feed-model";
import { workspaceFeed } from "~/workspace/feed";
import { seedWorkspace } from "./helpers/registry";
import { temporaryDirectory } from "./helpers/temporary";

const SEEN = "2026-11-01T00:00:00.000Z";
const SOURCE = { definition: "d", path: ["d"], runId: "rn-1" };

function manager(database: StoreDatabase, artifacts: string, scope: string) {
  return new Artifacts({
    files: blobFiles(artifactBlobs(artifacts, scope)),
    store: new SqliteArtifactStore({ database, scope }),
  });
}

async function post(
  database: StoreDatabase,
  artifacts: string,
  workspace: string,
  title: string
): Promise<string> {
  return await feedPublisher(manager(database, artifacts, workspace), {
    id: workspace,
    name: workspace,
    root: `/repo/${workspace}`,
  }).publish(
    { body: title, key: title, kind: "milestone", media: [], title },
    SOURCE
  );
}

describe("the workspace feed", () => {
  it("shows every workspace's entries", async () => {
    const home = temporaryDirectory("marbles-feed-");
    const state = join(home, "marbles");
    const artifacts = join(home, "artifacts");
    for (const id of ["ws1", "ws2"]) {
      await seedWorkspace(state, {
        config: null,
        firstSeen: SEEN,
        hosted: false,
        id,
        lastSeen: SEEN,
        root: `/repo/${id}`,
      });
    }
    const opened = await initializeDatabase(stateDatabase(state));
    try {
      const { database } = opened;
      await post(database, artifacts, "ws1", "mine");
      await post(database, artifacts, "ws2", "theirs");
      const feed = workspaceFeed({
        artifacts,
        database,
        own: feedReader(manager(database, artifacts, "ws1")),
        state,
        workspace: "ws1",
      });
      let clock = Date.now();
      const later = () => {
        clock += 5000;
        return new Date(clock);
      };
      const titles = async (scope: string) =>
        scopedFeed(await feed(later()), scope)
          .map((entry) => entry.title)
          .sort();
      expect(await titles(ALL_WORKSPACES)).toEqual(["mine", "theirs"]);
      expect(await titles("ws1")).toEqual(["mine"]);
      expect(await titles("ws2")).toEqual(["theirs"]);
    } finally {
      opened.close();
    }
  });
});
