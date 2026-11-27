import { join } from "node:path";
import { Artifacts } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { describe, expect, it } from "vitest";
import { artifactBlobs } from "~/database/local-artifacts";
import type { StoreDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { resourceAssociations } from "~/database/resources";
import { stateDatabase } from "~/layout";
import { feedPublisher } from "~/lib/feed/publish";
import { feedReader } from "~/lib/feed/read";
import { insideState } from "~/lib/state/workspace";
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
  it("shows every workspace's entries, and a shared one in each workspace it belongs to", async () => {
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
      const theirs = await post(database, artifacts, "ws2", "theirs");
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

      await resourceAssociations(database, {
        acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
      }).share({ id: theirs, kind: "artifact", owner: "ws2" }, "ws1");
      expect(await titles("ws1")).toEqual(["mine", "theirs"]);
      expect(await titles(ALL_WORKSPACES)).toEqual(["mine", "theirs"]);
      const shared = (await feed(later())).find((entry) => entry.id === theirs);
      expect(shared?.workspace.id).toBe("ws2");
      expect(shared?.workspaces).toEqual(["ws2", "ws1"]);
      await resourceAssociations(database, {
        acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
      }).unshare({ id: theirs, kind: "artifact", owner: "ws2" }, "ws1");
      expect(
        (await feed(new Date(clock + 1000))).find(
          (entry) => entry.id === theirs
        )?.workspaces
      ).toEqual(["ws2", "ws1"]);
      expect(await titles("ws1")).toEqual(["mine"]);
    } finally {
      opened.close();
    }
  });
});
