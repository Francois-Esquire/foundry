import { describe, expect, test } from "vitest";
import { WorkspaceCatalog } from "../catalog";
import { SqliteWorkspaceStore } from "../store/sqlite";
import { fileRecord, hostWorkspace, newRoot, seed } from "../testing/records";
import { libsqlDatabases } from "./helpers/sqlite";
import { execInAnotherProcess } from "./helpers/sqlite-process";

const LOCKED = /locked|busy/i;
const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

describe.each([
  ["memory", memory],
  ["file", files],
] as const)(
  "two catalogs over one SqliteWorkspaceStore (%s)",
  (_location, databases) => {
    test("cannot both register one root", async () => {
      const store = new SqliteWorkspaceStore({
        database: await databases.open(),
        scope: "s",
      });
      const publish = () => undefined;
      const [first, second] = [
        new WorkspaceCatalog(store, publish),
        new WorkspaceCatalog(store, publish),
      ];
      const root = newRoot("contested");
      const [a, b] = [
        hostWorkspace({ path: root }),
        hostWorkspace({ path: root }),
      ];

      const results = await Promise.all([
        first.create({ entries: [], workspace: a }),
        second.create({ entries: [], workspace: b }),
      ]);

      expect(results).toEqual([
        { kind: "committed" },
        { existingId: a.id, kind: "workspace-exists" },
      ]);
      expect((await store.listWorkspaces()).items).toEqual([a]);
    });
  }
);

describe("a list against another connection to its file", () => {
  test("is one state: a commit cannot land between its count and its page", async () => {
    const database = await files.open();
    let attempted: string | undefined;
    const reader = files.connect(database, {
      onQuery: (query) => {
        if (attempted === undefined && query.includes("order by")) {
          attempted = execInAnotherProcess(files.path(database), [
            "BEGIN IMMEDIATE",
            `INSERT INTO workspaces (created_at, id, last_reconciled_at, name, scope, source_kind, source_path, source_id, updated_at)
                VALUES (0, 'b', 0, 'b', 's', 'host', '/b', NULL, 0)`,
            "COMMIT",
          ]);
        }
      },
    });
    const workspace = hostWorkspace({ path: newRoot("a") });
    await seed(new SqliteWorkspaceStore({ database, scope: "s" }), workspace);

    const page = await new SqliteWorkspaceStore({
      database: reader,
      scope: "s",
    }).listWorkspaces();

    expect(attempted).toMatch(LOCKED);
    expect(page).toEqual({ items: [workspace], total: 1 });
  });
});

describe("a transaction against another connection to its file", () => {
  test("a second client in this process is refused, and lands nothing", async () => {
    const database = await files.open();
    const store = new SqliteWorkspaceStore({ database, scope: "s" });
    const elsewhere = new SqliteWorkspaceStore({
      database: files.connect(database),
      scope: "s",
    });
    const workspace = hostWorkspace({ path: newRoot("a") });
    await seed(store, workspace);

    const outcome = await store.transaction(async (view) => {
      const refused = await elsewhere
        .commit({ workspace: { ...workspace, name: "outside" } })
        .then(
          () => "landed",
          (error: unknown) => String(error)
        );
      const after = await view.getWorkspace(workspace.id);
      await view.commit({
        putEntries: [fileRecord(workspace.id, { path: "a.md" })],
        workspace: { ...workspace, name: "inside" },
      });
      return { after, refused };
    });

    expect(outcome.refused).toContain("SQLITE_BUSY");
    expect(outcome.after).toEqual(workspace);
    expect((await elsewhere.getWorkspace(workspace.id))?.name).toBe("inside");
  });
});
