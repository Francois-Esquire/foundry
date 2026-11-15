import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";

import type { ArtifactEvent } from "../index";
import { ArtifactManager } from "../manager";
import { artifactEventSchema } from "../schema";
import type { ArtifactDatabaseTransaction } from "../store/sqlite";
import { SqliteArtifactStore } from "../store/sqlite";
import { required } from "./helpers/required";
import { libsqlDatabases } from "./helpers/sqlite";

const memory = libsqlDatabases("memory");

/** A host's record of events, written on the commit's own transaction. */
const recorded = sqliteTable("recorded_events", {
  event: text("event", { mode: "json" }).notNull(),
});

/**
 * A manager over a SQLite store whose `onCommit` writes each event of a write
 * as a row on the transaction it is handed, as a host's outbox would.
 * `commits` holds the events of each call, in order; `rows` reads what
 * landed.
 */
async function hosted() {
  const database = await memory.open();
  await database.run(
    sql`CREATE TABLE "recorded_events" ("event" text NOT NULL)`
  );
  const commits: (readonly ArtifactEvent[])[] = [];
  const store = new SqliteArtifactStore({
    database,
    onCommit: async (transaction: ArtifactDatabaseTransaction, write) => {
      commits.push(write.events ?? []);
      for (const item of write.events ?? []) {
        await transaction.insert(recorded).values({ event: item });
      }
    },
    scope: "host",
  });
  const rows = async (): Promise<ArtifactEvent[]> =>
    (await database.select().from(recorded)).map(
      (row) => row.event as ArtifactEvent
    );
  /** The event types each commit `run` makes carries, one list per commit. */
  const typesOf = async (run: () => Promise<unknown>) => {
    const from = commits.length;
    await run();
    return commits.slice(from).map((events) => events.map((item) => item.type));
  };
  return {
    commits,
    manager: new ArtifactManager({ store }),
    rows,
    store,
    typesOf,
  };
}

const TEXT = { name: "A", type: "text/plain" } as const;

describe("ArtifactManager change events", () => {
  test("each event is plain JSON with its own id and an ISO time", async () => {
    const { manager, rows } = await hosted();
    const created = await manager.create(TEXT);
    await manager.rename(created.id, "B");

    const events = await rows();
    expect(events).toStrictEqual([
      {
        artifactId: created.id,
        at: expect.any(String),
        id: expect.any(String),
        type: "artifact.created",
      },
      {
        artifactId: created.id,
        at: expect.any(String),
        id: expect.any(String),
        name: "B",
        type: "artifact.renamed",
      },
    ]);
    for (const item of events) {
      expect(artifactEventSchema.parse(item)).toStrictEqual(item);
      expect(new Date(item.at).toISOString()).toBe(item.at);
    }
    expect(new Set(events.map((item) => item.id)).size).toBe(events.length);
  });

  test("an operation that performs others carries their events after its own, in one write", async () => {
    const { manager, typesOf } = await hosted();
    expect(
      await typesOf(() =>
        manager.create({
          ...TEXT,
          entries: { "a.txt": { bytes: "a" } },
          freeze: { metadata: { title: "one" }, tag: "v1" },
        })
      )
    ).toStrictEqual([
      [
        "artifact.created",
        "artifact.written",
        "artifact.tagged",
        "artifact.updated",
        "artifact.frozen",
      ],
    ]);
  });

  test("versions: written in place, revised, selected, and frozen", async () => {
    const { manager, rows, typesOf } = await hosted();
    const created = await manager.create({
      ...TEXT,
      entries: { "a.txt": { bytes: "a" } },
    });
    const first = required(created.content);

    expect(
      await typesOf(() =>
        manager.write({
          artifactId: created.id,
          changes: { put: { "a.txt": { bytes: "b" } } },
        })
      )
    ).toStrictEqual([["artifact.written"]]);
    const written = required(await manager.getContent(first.id));
    const revised = await manager.revise({
      artifactId: created.id,
      contentId: first.id,
      expectedUpdatedAt: written.updatedAt,
    });
    expect((await rows()).at(-1)).toMatchObject({
      artifactId: created.id,
      contentId: revised.id,
      sourceContentId: first.id,
      type: "artifact.revised",
    });
    expect(
      await typesOf(() =>
        manager.select({ artifactId: created.id, contentId: first.id })
      )
    ).toStrictEqual([["artifact.selected"]]);
    // Selecting what is selected already changes nothing: no commit.
    expect(
      await typesOf(() =>
        manager.select({ artifactId: created.id, contentId: first.id })
      )
    ).toStrictEqual([]);
    expect(await typesOf(() => manager.freeze(revised.id))).toStrictEqual([
      ["artifact.frozen"],
    ]);
    // Frozen already: the write stands, with no event.
    expect(await typesOf(() => manager.freeze(revised.id))).toStrictEqual([]);
  });

  test("an Artifact's own changes, and none for one that changes nothing", async () => {
    const { manager, rows, typesOf } = await hosted();
    const { id } = await manager.create(TEXT);

    expect(
      await typesOf(async () => {
        await manager.rename(id, "B");
        await manager.rename(id, "B");
        await manager.patchArtifactMetadata(id, { pinned: true });
        await manager.patchArtifactMetadata(id, {});
        await manager.archive(id);
        await manager.archive(id);
        await manager.unarchive(id);
        await manager.unarchive(id);
      })
    ).toStrictEqual([
      ["artifact.renamed"],
      [],
      ["artifact.updated"],
      [],
      ["artifact.archived"],
      [],
      ["artifact.unarchived"],
      [],
    ]);
    expect(
      (await rows()).find((item) => item.type === "artifact.updated")
    ).toMatchObject({ artifactId: id, contentId: null });
  });

  test("a Content's tag and metadata, and none for the tag it has", async () => {
    const { manager, rows, typesOf } = await hosted();
    const created = await manager.create({
      ...TEXT,
      entries: { "a.txt": { bytes: "a" } },
    });
    const contentId = required(created.contentId);

    expect(
      await typesOf(async () => {
        await manager.tag(contentId, "v1");
        await manager.tag(contentId, "v1");
        await manager.tag(contentId, null);
        await manager.setMetadata(contentId, { title: "t" });
      })
    ).toStrictEqual([
      ["artifact.tagged"],
      [],
      ["artifact.tagged"],
      ["artifact.updated"],
    ]);
    const tagged = (await rows()).filter(
      (item) => item.type === "artifact.tagged"
    );
    expect(tagged.map((item) => "tag" in item && item.tag)).toStrictEqual([
      "v1",
      null,
    ]);
    expect((await rows()).at(-1)).toMatchObject({
      artifactId: created.id,
      contentId,
      type: "artifact.updated",
    });
  });

  test("a fork is one event naming its source, not also a creation", async () => {
    const { manager, rows, typesOf } = await hosted();
    const source = await manager.create({
      ...TEXT,
      entries: { "a.txt": { bytes: "a" } },
    });
    const sourceContentId = required(source.contentId);
    let forked = source;

    expect(
      await typesOf(async () => {
        forked = await manager.fork({ contentId: sourceContentId });
      })
    ).toStrictEqual([["artifact.forked"]]);
    expect((await rows()).at(-1)).toMatchObject({
      artifactId: forked.id,
      contentId: required(forked.contentId),
      sourceArtifactId: source.id,
      sourceContentId,
    });
  });

  test("Contents discarded and an Artifact removed; none when nothing is", async () => {
    const { manager, typesOf } = await hosted();
    const created = await manager.create({
      ...TEXT,
      entries: { "a.txt": { bytes: "a" } },
    });
    const first = required(created.content);
    const second = await manager.revise({
      artifactId: created.id,
      contentId: first.id,
      expectedUpdatedAt: first.updatedAt,
    });

    expect(
      await typesOf(() =>
        manager.deleteContent({
          contentId: second.id,
          replacementContentId: first.id,
        })
      )
    ).toStrictEqual([["artifact.selected", "artifact.discarded"]]);
    expect(await typesOf(() => manager.delete(created.id))).toStrictEqual([
      ["artifact.removed"],
    ]);
    expect(await typesOf(() => manager.delete(created.id))).toStrictEqual([]);
  });

  test("a sweep discards each Content it deletes", async () => {
    const { manager, rows, typesOf } = await hosted();
    const created = await manager.create({
      ...TEXT,
      entries: { "a.txt": { bytes: "a" } },
    });
    const first = required(created.content);
    await manager.write({
      artifactId: created.id,
      changes: { put: { "b.txt": { bytes: "b" } } },
    });
    const draft = await manager.revise({
      artifactId: created.id,
      contentId: first.id,
      expectedUpdatedAt: required(await manager.getContent(first.id)).updatedAt,
    });
    await manager.select({ artifactId: created.id, contentId: first.id });

    expect(
      await typesOf(() =>
        manager.sweep({ olderThan: new Date(Date.now() + 60_000) })
      )
    ).toStrictEqual([["artifact.discarded"]]);
    expect((await rows()).at(-1)).toMatchObject({ contentId: draft.id });
  });

  test("a failed Content cleared from its Artifact says so", async () => {
    const { manager, rows, store, typesOf } = await hosted();
    const created = await manager.create({
      ...TEXT,
      entries: { "a.txt": { bytes: "a" } },
    });
    const content = required(created.content);
    // The store enforces nothing: a host marks the Content failed directly.
    await store.commit({ putContents: [{ ...content, state: "failed" }] });

    expect(
      await typesOf(() =>
        manager.clearFailedContent({
          artifactId: created.id,
          expectedContentId: content.id,
        })
      )
    ).toStrictEqual([["artifact.cleared"]]);
    expect((await rows()).at(-1)).toMatchObject({
      artifactId: created.id,
      contentId: content.id,
    });
  });

  test("a transaction carries every operation's events in one write, in call order", async () => {
    const { manager, typesOf } = await hosted();
    const { id } = await manager.create(TEXT);

    expect(
      await typesOf(() =>
        manager.transaction(async (artifacts) => {
          await artifacts.archive(id);
          await artifacts.rename(id, "B");
          await manager.patchArtifactMetadata(id, { joined: true });
        })
      )
    ).toStrictEqual([
      ["artifact.archived", "artifact.renamed", "artifact.updated"],
    ]);
  });

  test("events of a change that does not commit never land", async () => {
    const { commits, manager, rows } = await hosted();
    const { id } = await manager.create(TEXT);

    await expect(
      manager.transaction(async (artifacts) => {
        await artifacts.rename(id, "B");
        throw new Error("gave up");
      })
    ).rejects.toThrow("gave up");
    // Refused by the store before its transaction: text SQLite would not keep.
    await expect(manager.rename(id, "B\u0000")).rejects.toThrow();

    expect((await rows()).map((item) => item.type)).toStrictEqual([
      "artifact.created",
    ]);
    expect(commits).toHaveLength(1);
  });

  test("events committed inside a store transaction whose work throws roll back with it", async () => {
    const { commits, rows, store } = await hosted();
    const event: ArtifactEvent = {
      artifactId: "a" as ArtifactEvent["artifactId"],
      at: "2026-11-15T00:00:00.000Z",
      id: "e-1",
      type: "artifact.created",
    };

    await expect(
      store.transaction(async (view) => {
        await view.commit({ events: [event] });
        throw new Error("host gave up");
      })
    ).rejects.toThrow("host gave up");

    // onCommit ran inside the transaction; its rows went with it.
    expect(commits).toStrictEqual([[event]]);
    expect(await rows()).toStrictEqual([]);
  });

  test("a check that refuses records nothing", async () => {
    const { manager, rows } = await hosted();
    const { id } = await manager.create(TEXT);

    await expect(
      manager.write({
        artifactId: id,
        changes: { put: { "../escape": { bytes: "x" } } },
      })
    ).rejects.toThrow();

    expect((await rows()).map((item) => item.type)).toStrictEqual([
      "artifact.created",
    ]);
  });
});
