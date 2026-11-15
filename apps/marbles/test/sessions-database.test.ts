/**
 * A workspace's agent sessions in the Marbles database: the session store
 * Marbles builds over the host's handle and the one an engine opens for
 * itself are each held to the package's suite, list exactly the sessions
 * they hold with a stamp that moves with every change, and leave the JSON
 * session files an earlier Marbles wrote alone.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionRecord } from "@foundry/agents/schema";
import { Sessions } from "@foundry/agents/session";
import type { SessionStoreWrite } from "@foundry/agents/store";
import { describeSessionStore } from "@foundry/agents/testing/store";
import { afterAll, describe, expect, it } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { fileIdentity, queuedFiles } from "~/database/client";
import type { WorkspaceDatabase } from "~/database/managed";
import { openWorkspaceDatabase } from "~/database/managed";
import { DatabaseSessionStore, readSessions } from "~/database/sessions";
import { stateDatabase } from "~/layout";
import { workspaceState } from "~/lib/state/workspace";
import type { ListedSessionStore } from "~/lib/usage-evidence";
import { listsSessions } from "~/lib/usage-evidence";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";
import { temporaryDirectory } from "./helpers/temporary";

const machines: TestMachine[] = [];
const opened: WorkspaceDatabase[] = [];

afterAll(async () => {
  await Promise.all(opened.splice(0).map((database) => database.close()));
  for (const machine of machines.splice(0)) {
    machine.close();
  }
});

/** One store per scope, from `make`, so the suite's two scopes share storage. */
function perScope<T>(make: (scope: string) => T): (scope: string) => T {
  const stores = new Map<string, T>();
  return (scope) => {
    let found = stores.get(scope);
    if (found === undefined) {
      found = make(scope);
      stores.set(scope, found);
    }
    return found;
  };
}

/** Fresh storage of each kind Marbles builds, a store per scope over it. */
const KINDS: readonly {
  readonly name: string;
  readonly open: () => Promise<(scope: string) => ListedSessionStore>;
}[] = [
  {
    name: "DatabaseSessionStore",
    async open() {
      const machine = await testMachine();
      machines.push(machine);
      return perScope(
        (scope) =>
          new DatabaseSessionStore({
            database: machine.database.database,
            scope,
          })
      );
    },
  },
  {
    name: "openWorkspaceDatabase",
    open() {
      const state = temporaryDirectory("marbles-sessions-managed-");
      return Promise.resolve(
        perScope((workspaceId) => {
          const database = openWorkspaceDatabase({ state, workspaceId });
          opened.push(database);
          return database.sessions;
        })
      );
    },
  },
];

for (const kind of KINDS) {
  describeSessionStore(kind.name, kind.open);
}

function session(id: string, title: string | null = null): SessionRecord {
  return {
    createdAt: 1,
    id,
    parentMessageId: null,
    parentSessionId: null,
    status: "active",
    title,
    updatedAt: 1,
  };
}

const stampsOf = async (store: ListedSessionStore) =>
  new Map((await store.stamps()).map(({ id, stamp }) => [id, stamp]));

for (const kind of KINDS) {
  describe(`${kind.name}'s listing`, () => {
    it("lists every session it holds, each stamp moving only when the session changes", async () => {
      const store = (await kind.open())("ws");
      expect(listsSessions(store)).toBe(true);
      await expect(store.stamps()).resolves.toEqual([]);
      const sessions = new Sessions({ store });
      await sessions.createSession({ id: "a" });
      await sessions.createSession({ id: "b" });
      const before = await stampsOf(store);
      expect([...before.keys()]).toEqual(["a", "b"]);

      const message = await sessions.appendMessage({
        parts: [{ text: "hi", type: "text" }],
        role: "user",
        sessionId: "a",
      });
      const appended = await stampsOf(store);
      expect(appended.get("a")).not.toBe(before.get("a"));
      expect(appended.get("b")).toBe(before.get("b"));

      // A change in the same millisecond still moves it.
      await sessions.updateMessage(message.id, { status: "error" });
      const updated = await stampsOf(store);
      expect(updated.get("a")).not.toBe(appended.get("a"));
      expect(updated.get("b")).toBe(before.get("b"));
    });

    it("keeps no stamp of a commit that rolled back", async () => {
      const store = (await kind.open())("ws");
      await store.commit({ putSessions: [session("kept")] });
      const before = await stampsOf(store);
      await expect(
        store.transaction?.(async (view) => {
          await view.commit({
            putSessions: [session("kept", "changed"), session("dropped")],
          });
          throw new Error("rolled back");
        })
      ).rejects.toThrow("rolled back");
      expect(await stampsOf(store)).toEqual(before);
    });

    it("never lists another workspace's sessions", async () => {
      const storage = await kind.open();
      await storage("one").commit({ putSessions: [session("mine")] });
      await storage("two").commit({ putSessions: [session("theirs")] });
      expect([...(await stampsOf(storage("one"))).keys()]).toEqual(["mine"]);
      expect([...(await stampsOf(storage("two"))).keys()]).toEqual(["theirs"]);
    });
  });
}

describe("the sessions of an engine that opens its own database", () => {
  it("owns a write from the call, though the database is still to open", async () => {
    const state = temporaryDirectory("marbles-sessions-owned-");
    const database = openWorkspaceDatabase({ state, workspaceId: "ws" });
    opened.push(database);
    const write: { putSessions: SessionRecord[] } & SessionStoreWrite = {
      putSessions: [session("owned", "as called")],
    };
    const committed = database.sessions.commit(write);
    const [put] = write.putSessions;
    if (put !== undefined) {
      put.title = "changed after";
    }
    write.putSessions.push(session("added after"));
    await committed;
    await expect(database.sessions.getSession("owned")).resolves.toEqual(
      session("owned", "as called")
    );
    await expect(
      database.sessions.getSession("added after")
    ).resolves.toBeNull();
  });

  it("keeps the handle for a session written after its records close, and closes it with the rest", async () => {
    const state = temporaryDirectory("marbles-sessions-order-");
    const database = openWorkspaceDatabase({ state, workspaceId: "ws" });
    await database.records.taskStore.snapshot();
    await database.records.close();
    await database.sessions.commit({ putSessions: [session("late")] });
    const identity = fileIdentity(stateDatabase(state));
    expect(queuedFiles()).toContain(identity);
    await database.close();
    expect(queuedFiles()).not.toContain(identity);
    await expect(database.sessions.getSession("late")).rejects.toThrow(
      "closed"
    );
  });
});

describe("an engine Marbles creates over a workspace's state", () => {
  function engineOver(stateRoot: string, root: string) {
    const workspace = workspaceState(stateRoot, root);
    mkdirSync(workspace.dir, { recursive: true });
    return {
      engine: createEngine({
        catalog: new Catalog(),
        dry: false,
        print: () => undefined,
        root: workspace.root,
        stateDir: workspace.dir,
        stateRoot,
        workspaceId: workspace.id,
      }),
      workspace,
    };
  }

  it("keeps its sessions in the state root's database, ignoring session files an earlier Marbles left", async () => {
    const stateRoot = temporaryDirectory("marbles-sessions-state-");
    const root = temporaryDirectory("marbles-sessions-root-");
    const { engine: first, workspace } = engineOver(stateRoot, root);
    const left = join(workspace.dir, "sessions", "old.json");
    mkdirSync(join(workspace.dir, "sessions"));
    writeFileSync(left, JSON.stringify({ session: session("old") }));
    try {
      await new Sessions({ store: first.sessions }).createSession({
        id: "new",
      });
      await expect(first.sessions.getSession("old")).resolves.toBeNull();
    } finally {
      await first.dispose();
    }
    const identity = fileIdentity(stateDatabase(stateRoot));
    expect(queuedFiles()).not.toContain(identity);

    const { engine: second } = engineOver(stateRoot, root);
    try {
      await expect(second.sessions.getSession("new")).resolves.toMatchObject({
        id: "new",
      });
    } finally {
      await second.dispose();
    }
    expect(readFileSync(left, "utf8")).toContain('"old"');
    expect(existsSync(stateDatabase(workspace.dir))).toBe(false);
    const listed = await readSessions(stateRoot, workspace.id, (store) =>
      store.stamps()
    );
    expect(listed?.map(({ id }) => id)).toEqual(["new"]);
  });

  it("reads no sessions, and makes no database, where none was made", async () => {
    const stateRoot = temporaryDirectory("marbles-sessions-none-");
    await expect(
      readSessions(stateRoot, "ws", (store) => store.stamps())
    ).resolves.toBeUndefined();
    expect(existsSync(stateDatabase(stateRoot))).toBe(false);
  });
});
