import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactManager, artifactIdSchema } from "@foundry/artifacts";
import { describeArtifactStore } from "@foundry/artifacts/testing/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Touched } from "~/database/artifact-links";
import { followingCommits, keepingLinks } from "~/database/artifact-links";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { workspaceStores } from "~/database/stores";

/**
 * The store Marbles hands its engine's artifacts keeps the store contract,
 * and follows every write that lands, however deep in transactions it was
 * made, and none that did not.
 */

/** One migrated database for the suite; each opening gets scopes of its own, so its storage starts empty. */
let shared: Promise<{ readonly dir: string; readonly opened: MarblesDatabase }>;
let openings = 0;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-artifact-commits-"));
  shared = initializeDatabase(join(dir, "marbles.db")).then((opened) => ({
    dir,
    opened,
  }));
});

afterAll(async () => {
  const { dir, opened } = await shared;
  opened.close();
  rmSync(dir, { force: true, recursive: true });
});

describeArtifactStore("Marbles' link-keeping", async () => {
  const { dir, opened } = await shared;
  openings += 1;
  const opening = String(openings);
  const scopes = new Map<string, ReturnType<typeof keepingLinks>>();
  return (scope: string) => {
    const owner = `${opening}-${scope}`;
    const store =
      scopes.get(scope) ??
      keepingLinks(workspaceStores(opened.database, owner).artifacts, {
        artifacts: join(dir, "artifacts"),
        database: opened.database,
        owner,
        report: () => undefined,
        state: dir,
      });
    scopes.set(scope, store);
    return store;
  };
});

describe("a store that follows its commits", () => {
  async function followed() {
    const { opened } = await shared;
    openings += 1;
    const landed: Touched[] = [];
    const store = followingCommits(
      workspaceStores(opened.database, `followed-${String(openings)}`)
        .artifacts,
      (touched) => landed.push(touched)
    );
    return { landed, store };
  }

  it("follows a write made in a transaction nested in another, once the outer one lands", async () => {
    const { landed, store } = await followed();
    const id = artifactIdSchema.parse("nested");
    await store.transaction(async (outer) => {
      await outer.transaction?.(async (inner) => {
        await new ArtifactManager({ store: inner }).create({
          entries: { "a.txt": { bytes: "hello", mime: "text/plain" } },
          id,
          name: "nested",
          type: "text/plain",
        });
      });
      // Not yet: the outer transaction has not landed.
      expect(landed).toEqual([]);
    });
    expect(landed.flatMap((touched) => touched.artifacts)).toContain(id);
  });

  it("follows no write of a transaction that rolled back", async () => {
    const { landed, store } = await followed();
    await expect(
      store.transaction(async (view) => {
        await new ArtifactManager({ store: view }).create({
          entries: { "a.txt": { bytes: "gone", mime: "text/plain" } },
          name: "gone",
          type: "text/plain",
        });
        throw new Error("rolled back");
      })
    ).rejects.toThrow("rolled back");
    expect(landed).toEqual([]);
  });

  it("follows a plain commit once it resolves, and none that is refused", async () => {
    const { landed, store } = await followed();
    await new ArtifactManager({ store }).create({
      entries: { "a.txt": { bytes: "plain", mime: "text/plain" } },
      name: "plain",
      type: "text/plain",
    });
    expect(landed).toHaveLength(1);
    await expect(
      store.commit({ putArtifacts: [{ id: 1 } as never] })
    ).rejects.toThrow();
    expect(landed).toHaveLength(1);
  });
});
