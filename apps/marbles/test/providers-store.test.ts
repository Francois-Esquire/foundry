import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase, readDatabase } from "~/database/open";
import { DatabaseProviderStore, stateProviders } from "~/database/providers";
import { marblesProviderConfigurations } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { ProviderStore, ProvidersFile } from "~/lib/providers/store";
import { MemoryProviderStore, readOnlyProviders } from "~/lib/providers/store";

const dirs: string[] = [];
const handles: MarblesDatabase[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "marbles-providers-"));
  dirs.push(dir);
  return dir;
}

async function database(state = scratch()): Promise<MarblesDatabase> {
  const opened = await initializeDatabase(stateDatabase(state));
  handles.push(opened);
  return opened;
}

const entry = (id: string) => ({ enabled: true, id, plugin: "codex" });
const file = (...ids: string[]): ProvidersFile => ({
  providers: ids.map(entry),
  version: 1,
});
const idsOf = (kept: ProvidersFile | undefined) =>
  kept?.providers.map((each) => each.id);

function describeProviderStore(
  name: string,
  open: () => Promise<ProviderStore>
): void {
  describe(name, () => {
    it("keeps nothing at first, and makes no identity key until asked to", async () => {
      const store = await open();
      const kept = await store.read();
      expect(kept.machine).toBeUndefined();
      expect(kept.workspaces).toEqual([]);
      expect(kept.workspace("ws")).toBeUndefined();
      expect(await store.revision()).toBe(0);
      expect(await store.identityKey(false)).toBeUndefined();
      const key = await store.identityKey(true);
      expect(key).toHaveLength(32);
      expect(await store.identityKey(true)).toEqual(key);
      expect(await store.identityKey(false)).toEqual(key);
    });

    it("writes the machine's and a workspace's in one edit, and raises the revision", async () => {
      const store = await open();
      const landed = await store.update("ws", () => ({
        machine: file("a"),
        workspace: file("b"),
      }));
      expect(idsOf(landed.machine)).toEqual(["a"]);
      expect(idsOf(landed.workspace("ws"))).toEqual(["b"]);
      const first = await store.revision();
      expect(first).toBeGreaterThan(0);
      await store.update("other", (current) => {
        expect(idsOf(current.workspace("ws"))).toEqual(["b"]);
        return { workspace: file("c") };
      });
      expect(await store.revision()).toBeGreaterThan(first);
      const kept = await store.read();
      expect(kept.workspaces.toSorted()).toEqual(["other", "ws"]);
      expect(idsOf(kept.workspace("other"))).toEqual(["c"]);
      expect(idsOf(kept.machine)).toEqual(["a"]);
    });

    it("writes nothing for an edit that refuses or leaves every scope as it is", async () => {
      const store = await open();
      await store.update(undefined, () => ({ machine: file("a") }));
      const revision = await store.revision();
      await expect(
        store.update(undefined, () => {
          throw new Error("refused");
        })
      ).rejects.toThrow("refused");
      await store.update(undefined, () => ({}));
      expect(await store.revision()).toBe(revision);
      expect(idsOf((await store.read()).machine)).toEqual(["a"]);
    });

    it("re-reads before each edit, so overlapping edits keep each other's", async () => {
      const store = await open();
      await Promise.all(
        ["a", "b", "c"].map((id) =>
          store.update(undefined, (current) => ({
            machine: {
              providers: [...(current.machine?.providers ?? []), entry(id)],
              version: 1,
            },
          }))
        )
      );
      expect(idsOf((await store.read()).machine)?.toSorted()).toEqual([
        "a",
        "b",
        "c",
      ]);
    });

    it("refuses a workspace scope to an edit for no workspace", async () => {
      const store = await open();
      await expect(
        store.update(undefined, () => ({ workspace: file("a") }))
      ).rejects.toMatchObject({ code: "PROVIDER_ENTRY_INVALID" });
    });
  });
}

describeProviderStore("the memory provider store", () =>
  Promise.resolve(new MemoryProviderStore())
);
describeProviderStore("the database provider store", async () => {
  const opened = await database();
  return new DatabaseProviderStore({ database: opened.database });
});
describeProviderStore(
  "the provider store a process without a handle uses",
  () => Promise.resolve(stateProviders(scratch()))
);

describe("provider configuration in the Marbles database", () => {
  it("refuses a scope that does not read, saying where and why but never what it holds", async () => {
    const opened = await database();
    const store = new DatabaseProviderStore({ database: opened.database });
    await store.update("ws", () => ({
      machine: file("a"),
      workspace: file("b"),
    }));
    await opened.database
      .update(marblesProviderConfigurations)
      .set({ configuration: '{ "apiKey": "sk-secret-value' });
    // Found where the machine's is read, with the revision still known.
    const kept = await store.read();
    expect(kept.revision).toBeGreaterThan(0);
    const refusal = await Promise.resolve()
      .then(() => kept.machine)
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "CONFIGURATION_UNREADABLE" });
    expect(String(refusal)).toContain("machine");
    expect(String(refusal)).not.toContain("sk-secret-value");
    expect((refusal as Error).cause).toBeUndefined();
  });

  it("reads past a workspace's that does not read until that one is asked for", async () => {
    const opened = await database();
    const store = new DatabaseProviderStore({ database: opened.database });
    await store.update("ws", () => ({
      machine: file("a"),
      workspace: file("b"),
    }));
    await opened.database
      .update(marblesProviderConfigurations)
      .set({ configuration: JSON.stringify({ providers: "no", version: 1 }) })
      .where(eq(marblesProviderConfigurations.scope, "ws"));
    const kept = await store.read();
    expect(idsOf(kept.machine)).toEqual(["a"]);
    expect(() => kept.workspace("ws")).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_UNREADABLE" })
    );
  });

  it("reports a failed write by its SQLite code alone, never with the settings it was writing", async () => {
    const state = scratch();
    (await database(state)).close();
    handles.length = 0;
    const refusal = await readDatabase(stateDatabase(state), (read) =>
      new DatabaseProviderStore({ database: read })
        .update(undefined, () => ({
          machine: {
            providers: [
              {
                enabled: true,
                id: "gw",
                plugin: "gateway",
                settings: { apiKey: "sk-secret-value" },
              },
            ],
            version: 1,
          },
        }))
        .catch((error: unknown) => error)
    );
    expect(refusal).toMatchObject({ code: "CONFIGURATION_UNREADABLE" });
    expect(String(refusal)).toContain("SQLITE_READONLY");
    expect(String(refusal)).not.toContain("sk-secret-value");
    expect((refusal as Error).cause).toBeUndefined();
  });

  it("keeps a dry run's edits to itself, and makes no identity key for it", async () => {
    const opened = await database();
    const real = new DatabaseProviderStore({ database: opened.database });
    await real.update(undefined, () => ({ machine: file("a") }));
    const dry = readOnlyProviders(real);
    const before = await dry.revision();
    await dry.update("ws", () => ({
      machine: file("a", "b"),
      workspace: file("c"),
    }));
    expect(idsOf((await dry.read()).machine)).toEqual(["a", "b"]);
    expect(idsOf((await dry.read()).workspace("ws"))).toEqual(["c"]);
    expect(await dry.revision()).toBeGreaterThan(before);
    expect(idsOf((await real.read()).machine)).toEqual(["a"]);
    expect((await real.read()).workspaces).toEqual([]);
    expect(await dry.identityKey(true)).toBeUndefined();
    expect(await real.identityKey(false)).toBeUndefined();
  });
});
