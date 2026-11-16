import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { artifactBlobs, readArtifacts } from "~/database/stores";
import { stateDatabase } from "~/layout";
import { temporaryDirectory } from "./helpers/temporary";

/**
 * A dry run reads what real runs left through `readArtifacts`, which
 * writes nothing: a stored artifact whose blob files are gone reads as
 * missing, and nothing is made in their place.
 */

it("reads an artifact whose blobs directory is gone as missing, and makes no directory", async () => {
  const home = temporaryDirectory("marbles-read-artifacts-");
  const state = join(home, "marbles");
  const artifacts = join(home, "artifacts");
  const blobs = artifactBlobs(artifacts, "one");
  const opened = await initializeDatabase(stateDatabase(state));
  let contentId: string;
  try {
    const created = await new ArtifactManager({
      files: blobFiles(blobs),
      store: new SqliteArtifactStore({
        database: opened.database,
        scope: "one",
      }),
    }).create({
      entries: { "a.md": { bytes: "# A\n", mime: "text/markdown" } },
      name: "notes",
      type: "text/markdown",
    });
    contentId = created.contentId ?? "";
  } finally {
    opened.close();
  }
  rmSync(blobs, { force: true, recursive: true });
  const reading = readArtifacts(state, artifacts, "one");
  await expect(reading.readFile(contentId as never, "a.md")).rejects.toThrow();
  expect(existsSync(blobs)).toBe(false);
});
