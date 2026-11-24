import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tasks } from "@foundry/tasks";
import { afterEach, expect, it, vi } from "vitest";
import { fileIdentity, queuedFiles } from "~/database/client";
import { Engine } from "~/entries/engine";
import { stateDatabase } from "~/layout";
import { testInstances } from "./helpers/engine";

const opened = vi.hoisted(() => ({ count: 0 }));

vi.mock("~/database/workspaces", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("~/database/workspaces")>();
  return {
    ...original,
    openHostDatabase: (
      ...args: Parameters<typeof original.openHostDatabase>
    ) => {
      opened.count += 1;
      return original.openHostDatabase(...args);
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it("opens one database handle for every store it keeps there, and closes it on dispose", async () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-handle-"));
  roots.push(root);
  const state = join(root, "state");
  const engine = new Engine({
    ...testInstances({ root }),
    root,
    state,
    workspaceId: "one-handle",
  });
  engine.task({ name: "save", run: () => "saved" });
  engine.define({ fn: () => "ran", kind: "step", name: "flow" });
  await engine.start();
  await new Tasks({ store: engine.taskStore }).create({ title: "Open" });
  const saved = await engine.launch<string>("save", {});
  await saved.result;
  const flow = await engine.launch<string>("flow", {});
  await flow.result;
  await engine.schedules();
  await engine.readUsage();
  await engine.triggers.monitorState("none");
  expect(opened.count).toBe(1);

  const identity = fileIdentity(stateDatabase(state));
  expect(queuedFiles()).toContain(identity);
  await engine.dispose();
  expect(queuedFiles()).not.toContain(identity);
});
