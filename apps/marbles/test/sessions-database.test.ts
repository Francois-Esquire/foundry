import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SessionChangeEvent,
  SessionMessage,
  SessionRecord,
} from "@foundry/agents/session";
import { Sessions } from "@foundry/agents/session";
import type { SessionStoreWrite } from "@foundry/agents/store";
import { SqliteSessionStore } from "@foundry/agents/store/sqlite";
import type { RecordingSessionStorage } from "@foundry/agents/testing/store";
import { describeSessionStore } from "@foundry/agents/testing/store";
import { afterAll, describe, expect, it } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { ChangeRecorder } from "~/database/changes";
import { fileIdentity, queuedFiles } from "~/database/client";
import type { WorkspaceDatabase } from "~/database/managed";
import { openWorkspaceDatabase } from "~/database/managed";

import { readResourceView } from "~/database/open";
import { DatabaseSessionStore } from "~/database/sessions";
import { stateDatabase } from "~/layout";
import type { ListedSessionStore } from "~/lib/usage/evidence";
import { listsSessions } from "~/lib/usage/evidence";
import { workspaceState } from "~/state/workspace";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";
import { temporaryDirectory } from "./helpers/temporary";

async function sessionCount(state: string, scope: string): Promise<number> {
  const sessions = await readResourceView(state, { workspace: scope }, (view) =>
    view.sessions()
  );
  return sessions?.length ?? 0;
}

const machines: TestMachine[] = [];
const opened: WorkspaceDatabase[] = [];

afterAll(async () => {
  await Promise.all(opened.splice(0).map((database) => database.close()));
  for (const machine of machines.splice(0)) {
    machine.close();
  }
});

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

const KINDS: readonly {
  readonly name: string;
  readonly storage: () => Promise<{
    readonly state: string;
    readonly stores: (scope: string) => ListedSessionStore;
  }>;
}[] = [
  {
    name: "DatabaseSessionStore",
    async storage() {
      const machine = await testMachine();
      machines.push(machine);
      return {
        state: machine.root,
        stores: perScope(
          (scope) =>
            new DatabaseSessionStore({
              database: machine.database.database,
              scope,
            })
        ),
      };
    },
  },
  {
    name: "openWorkspaceDatabase",
    storage() {
      const state = temporaryDirectory("marbles-sessions-managed-");
      return Promise.resolve({
        state,
        stores: perScope((workspaceId) => {
          const database = openWorkspaceDatabase({ state, workspaceId });
          opened.push(database);
          return database.sessions;
        }),
      });
    },
  },
];

async function recordingSessions(): Promise<RecordingSessionStorage> {
  const machine = await testMachine();
  machines.push(machine);
  const fail: { next: boolean } = { next: false };
  class FailingRecorder extends ChangeRecorder {
    override async record(
      ...args: Parameters<ChangeRecorder["record"]>
    ): Promise<void> {
      await super.record(...args);
      if (fail.next) {
        fail.next = false;
        throw new Error("the host refused the commit");
      }
    }
  }
  return {
    failNextCommit: () => {
      fail.next = true;
    },
    recorded: async () =>
      (await machine.changes(join(machine.root, "scope"), "sessions")).map(
        (change) => change.payload as unknown as SessionChangeEvent
      ),
    storage: perScope(
      (scope) =>
        new DatabaseSessionStore({
          changes: new FailingRecorder(scope),
          database: machine.database.database,
          scope,
        })
    ),
  };
}

for (const kind of KINDS) {
  describeSessionStore(kind.name, async () => (await kind.storage()).stores, {
    hooked: true,
    recording: recordingSessions,
  });
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

function filed(id: string, sessionId: string): SessionMessage {
  return {
    createdAt: 1,
    id,
    parts: [{ text: "hello", type: "text" }],
    role: "assistant",
    sessionId,
    status: "complete",
    updatedAt: 1,
  };
}

const WRITERS: readonly {
  readonly commit: (
    store: ListedSessionStore,
    write: SessionStoreWrite,
    after?: () => void
  ) => Promise<void>;
  readonly name: string;
}[] = [
  {
    commit: async (store, write, after) => {
      const committed = store.commit(write);
      after?.();
      await committed;
    },
    name: "a commit",
  },
  {
    commit: async (store, write, after) => {
      await store.transaction?.(async (view) => {
        const committed = view.commit(write);
        after?.();
        await committed;
      });
    },
    name: "a transaction's view",
  },
];

class Point {
  readonly x = 1;
}

function holdingPoint(id: string): SessionMessage {
  return {
    ...filed(id, "a"),
    parts: [
      { input: new Point(), name: "tool", toolCallId: "c", type: "tool_call" },
    ],
  };
}

async function packageRefusal(write: SessionStoreWrite): Promise<unknown> {
  const machine = await testMachine();
  machines.push(machine);
  return await new SqliteSessionStore({
    database: machine.database.database,
    scope: "package",
  })
    .commit(write)
    .then(
      () => undefined,
      (error: unknown) => error
    );
}

const stampsOf = async (store: ListedSessionStore) =>
  new Map((await store.stamps()).map(({ id, stamp }) => [id, stamp]));

for (const kind of KINDS) {
  const open = async () => (await kind.storage()).stores;
  describe(`${kind.name}'s listing`, () => {
    it("lists every session it holds, each stamp moving only when the session changes", async () => {
      const store = (await open())("ws");
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

      await sessions.updateMessage(message.id, { status: "error" });
      const updated = await stampsOf(store);
      expect(updated.get("a")).not.toBe(appended.get("a"));
      expect(updated.get("b")).toBe(before.get("b"));
    });

    it("keeps no stamp of a commit that rolled back", async () => {
      const store = (await open())("ws");
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
      const storage = await open();
      await storage("one").commit({ putSessions: [session("mine")] });
      await storage("two").commit({ putSessions: [session("theirs")] });
      expect([...(await stampsOf(storage("one"))).keys()]).toEqual(["mine"]);
      expect([...(await stampsOf(storage("two"))).keys()]).toEqual(["theirs"]);
    });

    for (const through of WRITERS) {
      it(`raises the session a message leaves as well as the one it joins, through ${through.name}`, async () => {
        const store = (await open())("ws");
        await store.commit({
          putMessages: [filed("m", "a")],
          putSessions: [session("a"), session("b"), session("c")],
        });
        const before = await stampsOf(store);
        await through.commit(store, { putMessages: [filed("m", "b")] });
        const after = await stampsOf(store);
        await expect(store.listMessages("a")).resolves.toEqual([]);
        expect(after.get("a")).not.toBe(before.get("a"));
        expect(after.get("b")).not.toBe(before.get("b"));
        expect(after.get("c")).toBe(before.get("c"));
      });

      it(`raises the session a message leaves for a write holding a property no copy keeps, through ${through.name}`, async () => {
        const store = (await open())("ws");
        await store.commit({
          putMessages: [filed("m", "a")],
          putSessions: [session("a"), session("b")],
        });
        const before = await stampsOf(store);
        const write = {
          annotation: () => undefined,
          putMessages: [filed("m", "b")],
        };
        await through.commit(store, write);
        await expect(store.listMessages("a")).resolves.toEqual([]);
        await expect(store.getMessage("m")).resolves.toEqual(filed("m", "b"));
        const after = await stampsOf(store);
        expect(after.get("a")).not.toBe(before.get("a"));
        expect(after.get("b")).not.toBe(before.get("b"));
      });

      it(`refuses a class instance in a message as the package store does, and keeps nothing, through ${through.name}`, async () => {
        const store = (await open())("ws");
        await store.commit({ putSessions: [session("a")] });
        const before = await stampsOf(store);
        const expected = await packageRefusal({
          putMessages: [holdingPoint("p")],
        });
        expect(expected).toBeInstanceOf(RangeError);
        const refused = await through
          .commit(store, { putMessages: [holdingPoint("p")] })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect(refused).toBeInstanceOf(RangeError);
        expect((refused as Error).message).toBe((expected as Error).message);
        await expect(store.getMessage("p")).resolves.toBeNull();
        expect(await stampsOf(store)).toEqual(before);
      });

      it(`lands a write as it stood when commit was called, whatever the caller changes after, through ${through.name}`, async () => {
        const store = (await open())("ws");
        await store.commit({
          putMessages: [filed("m", "a")],
          putSessions: [session("a"), session("b"), session("c")],
        });
        const before = await stampsOf(store);
        const moved = filed("m", "b");
        const write = { annotation: () => undefined, putMessages: [moved] };
        await through.commit(store, write, () => {
          moved.sessionId = "c";
          moved.parts = [{ text: "changed", type: "text" }];
          write.putMessages.push(filed("x", "c"));
        });
        await expect(store.getMessage("m")).resolves.toEqual(filed("m", "b"));
        await expect(store.getMessage("x")).resolves.toBeNull();
        const after = await stampsOf(store);
        expect(after.get("a")).not.toBe(before.get("a"));
        expect(after.get("b")).not.toBe(before.get("b"));
        expect(after.get("c")).toBe(before.get("c"));
      });

      it(`lists no session for messages written without one, and lists it once it is put, through ${through.name}`, async () => {
        const { state, stores } = await kind.storage();
        const store = stores("ws");
        await through.commit(store, { putMessages: [filed("m", "later")] });
        await expect(store.getSession("later")).resolves.toBeNull();
        await expect(store.stamps()).resolves.toEqual([]);
        expect(await sessionCount(state, "ws")).toBe(0);

        await through.commit(store, { putSessions: [session("later")] });
        const put = await stampsOf(store);
        expect([...put.keys()]).toEqual(["later"]);
        expect(await sessionCount(state, "ws")).toBe(1);
        await through.commit(store, {
          putMessages: [{ ...filed("m", "later"), status: "error" }],
        });
        expect((await stampsOf(store)).get("later")).not.toBe(put.get("later"));

        await through.commit(store, {
          putMessages: [filed("n", "together")],
          putSessions: [session("together")],
        });
        expect([...(await stampsOf(store)).keys()]).toEqual([
          "later",
          "together",
        ]);
        expect(await sessionCount(state, "ws")).toBe(2);
      });
    }
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
    const listed = await readResourceView(
      stateRoot,
      { workspace: workspace.id },
      (view) => view.sessions()
    );
    expect(listed?.map(({ ref }) => ref.id)).toEqual(["new"]);
  });

  it("reads no sessions, and makes no database, where none was made", async () => {
    const stateRoot = temporaryDirectory("marbles-sessions-none-");
    await expect(
      readResourceView(stateRoot, { workspace: "ws" }, (view) =>
        view.sessions()
      )
    ).resolves.toBeUndefined();
    expect(existsSync(stateDatabase(stateRoot))).toBe(false);
  });
});

describe("a program hosting a workspace itself", () => {
  it("keeps the sessions its engine writes in the state root's database, after it closes", () => {
    const root = temporaryDirectory("marbles-sessions-host-");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "marbles.ts"), "");
    const state = join(root, "state");
    const script = join(root, "host.ts");
    const src = resolve("src");
    const agentsSessions = fileURLToPath(
      import.meta.resolve("@foundry/agents/session")
    );
    writeFileSync(
      script,
      `import { Sessions } from ${JSON.stringify(agentsSessions)};
import { hostWorkspace } from ${JSON.stringify(join(src, "workspace/host.ts"))};
let sessions;
const host = await hostWorkspace({
  artifacts: ${JSON.stringify(join(root, "artifacts"))},
  prepare: (engine) => {
    sessions = engine.sessions;
  },
  source: ${JSON.stringify(join(workspace, "marbles.ts"))},
  state: ${JSON.stringify(state)},
});
const written = new Sessions({ store: sessions });
await written.createSession({ id: "hosted" });
await written.appendMessage({ parts: [{ text: "hi", type: "text" }], role: "user", sessionId: "hosted" });
await host.close();
`
    );
    const hosted = spawnSync("bun", ["--no-env-file", script], {
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(hosted.status, hosted.stderr).toBe(0);
    const { dir, id } = workspaceState(state, workspace);
    return readResourceView(state, { workspace: id }, async (view) => {
      const sessions = await view.sessions();
      const [kept] = sessions;
      return {
        messages:
          kept === undefined
            ? 0
            : ((await view.messageTallies([kept.ref])).get(kept.ref)
                ?.messages ?? 0),
        stamps: sessions.map(({ ref }) => ref.id),
      };
    }).then((read) => {
      expect(read).toEqual({ messages: 1, stamps: ["hosted"] });
      expect(existsSync(join(dir, "sessions"))).toBe(false);
    });
  }, 60_000);
});
