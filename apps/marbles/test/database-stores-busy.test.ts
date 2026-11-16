import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceId } from "@foundry/workspaces";
import { afterEach, expect, it } from "vitest";
import { DatabaseBusyError } from "~/database/client";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase, openDatabase } from "~/database/open";
import { workspaceStores } from "~/database/stores";
import { holdWriteLock } from "./helpers/busy";

const roots: string[] = [];
const children: ChildProcess[] = [];
const handles: MarblesDatabase[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

async function impatientHost(): Promise<{
  readonly file: string;
  readonly host: MarblesDatabase;
}> {
  const root = mkdtempSync(join(tmpdir(), "marbles-stores-busy-"));
  roots.push(root);
  const file = join(root, "marbles.db");
  (await initializeDatabase(file)).close();
  const host = await openDatabase(file, { busyTimeout: 50 });
  if (host === undefined) {
    throw new Error("the database was not made");
  }
  handles.push(host);
  return { file, host };
}

it("surfaces a lock held too long as a DatabaseBusyError from each store, and works once it is free", async () => {
  const { file, host } = await impatientHost();
  const stores = workspaceStores(host.database, "ws");
  const holder = await holdWriteLock(file, children);

  await expect(
    stores.workspaces.commit({ removeWorkspace: "gone" as WorkspaceId })
  ).rejects.toBeInstanceOf(DatabaseBusyError);
  await expect(
    stores.artifacts.transaction(() => Promise.resolve())
  ).rejects.toBeInstanceOf(DatabaseBusyError);
  await expect(
    stores.containers.commit({ deleteContainers: ["gone"] })
  ).rejects.toBeInstanceOf(DatabaseBusyError);

  await holder.release();
  await stores.containers.commit({ deleteContainers: ["gone"] });
  expect(await stores.containers.list()).toEqual([]);
});
