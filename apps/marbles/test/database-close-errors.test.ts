/**
 * A store over the workspace database (`database/managed.ts`) whose own
 * cleanup fails, then whose release closes the handle, which fails too:
 * both failures are reported, the cleanup's not lost to the close's.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  defaultWorkspaceRuns,
  defaultWorkspaceTriggers,
  openWorkspaceRecords,
  withWorkspaceDatabase,
} from "~/database/managed";
import { DatabaseRunStore } from "~/database/runs";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { DatabaseTriggerStore } from "~/database/triggers";
import { DatabaseUsageStore } from "~/database/usage";
import { testInstances } from "./helpers/engine";

/** Each handle opened closes, then fails as a failing driver would. */
vi.mock("~/database/workspaces", async (original) => {
  const actual = await original<typeof import("~/database/workspaces")>();
  return {
    ...actual,
    openHostDatabase: async (
      ...args: Parameters<typeof actual.openHostDatabase>
    ) => {
      const opened = await actual.openHostDatabase(...args);
      return {
        ...opened,
        close: () => {
          opened.close();
          throw new Error("the database failed to close");
        },
      };
    },
  };
});

const roots: string[] = [];
const restore: (() => void)[] = [];

afterEach(() => {
  for (const undo of restore.splice(0)) {
    undo();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "marbles-close-errors-"));
  roots.push(root);
  return root;
}

/** Make `owner`'s own close fail with `message` for this test. */
function failingClose(owner: { close(): Promise<void> }, message: string) {
  const { close } = owner;
  owner.close = () => Promise.reject(new Error(message));
  restore.push(() => {
    owner.close = close;
  });
}

async function failures(closing: Promise<void>): Promise<string[]> {
  const error = await closing.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  return error instanceof AggregateError
    ? error.errors.map((each: Error) => each.message)
    : [String(error)];
}

it("reports the records' cleanup and the handle's close when both fail", async () => {
  failingClose(DatabaseWorkspaceRecords.prototype, "records cleanup failed");
  const records = openWorkspaceRecords({
    state: scratch(),
    workspaceId: "records",
  });
  await records.claimDelivery();
  expect(await failures(records.close())).toEqual([
    "records cleanup failed",
    "the database failed to close",
  ]);
});

it("reports a run store's cleanup and the handle's close when both fail", async () => {
  failingClose(DatabaseRunStore.prototype, "runs cleanup failed");
  const root = scratch();
  const runs = defaultWorkspaceRuns(join(root, "state"), root, "runs");
  await runs.recorded("run-1");
  expect(await failures(runs.close())).toEqual([
    "runs cleanup failed",
    "the database failed to close",
  ]);
});

it("reports a trigger store's cleanup and the handle's close when both fail", async () => {
  failingClose(DatabaseTriggerStore.prototype, "triggers cleanup failed");
  const root = scratch();
  const triggers = defaultWorkspaceTriggers(
    join(root, "state"),
    root,
    "triggers"
  );
  await triggers.lastTick("tick");
  expect(await failures(triggers.close())).toEqual([
    "triggers cleanup failed",
    "the database failed to close",
  ]);
});

it("reports the last store's cleanup and the handle's close when the last claim goes", async () => {
  failingClose(DatabaseUsageStore.prototype, "usage cleanup failed");
  const root = scratch();
  const kept = withWorkspaceDatabase({
    ...testInstances({ root }),
    root,
    state: join(root, "state"),
    workspaceId: "last-claim",
  });
  const { options } = kept;
  await options.usageStore?.facts();
  await kept.release();
  await options.records?.close();
  await options.runs?.close();
  await options.triggers?.close();
  await options.automationStore?.close();
  await options.executionStore?.close();
  const closing = options.usageStore?.close() ?? Promise.resolve();
  expect(await failures(closing)).toEqual([
    "usage cleanup failed",
    "the database failed to close",
  ]);
});
