import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processAlive } from "@foundry/lib/file-lock";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { WorkspaceState } from "../../src/lib/state";
import { lockState, workspaceState } from "../../src/lib/state";

let directory: string;
let state: WorkspaceState;
let lock: string;

beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "atlas-state-")));
  const root = join(directory, "workspace");
  mkdirSync(root);
  state = await workspaceState(root, join(directory, "state"));
  lock = join(state.directory, "lock");
  mkdirSync(state.directory, { recursive: true });
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

/** A process that was running a moment ago and is not now. */
function exitedProcess(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined || processAlive(pid)) {
    throw new Error("Could not find a process that has exited.");
  }
  return pid;
}

it("refuses a lock whose holder has not written itself in yet", () => {
  writeFileSync(lock, "");
  expect(() => lockState(state)).toThrow(
    `Workspace ${state.root} is being scanned by a process that is starting. Retry.`
  );
});

it("refuses a lock that names no process, and says which file to remove", () => {
  writeFileSync(lock, "garbage");
  expect(() => lockState(state)).toThrow(
    `Workspace ${state.root} is locked by an unknown process. If no scan is running, remove ${lock}.`
  );
});

it("refuses a lock held by another live process, and says which file to remove", () => {
  writeFileSync(lock, String(process.ppid));
  expect(() => lockState(state)).toThrow(
    `Workspace ${state.root} is being scanned by process ${process.ppid}. If no scan is running, remove ${lock}.`
  );
});

it("takes over a lock whose process has exited", () => {
  writeFileSync(lock, String(exitedProcess()));
  const release = lockState(state);
  expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  release();
  expect(existsSync(lock)).toBe(false);
});

it("refuses a lock whose process has exited while another scan takes it over", () => {
  const exited = exitedProcess();
  writeFileSync(lock, String(exited));
  // The turn to break the lock, held by the scan taking it over.
  writeFileSync(`${lock}.break`, "");
  expect(() => lockState(state)).toThrow(
    `Workspace ${state.root} is locked by process ${exited}, which has exited; another scan is taking the lock over. Retry.`
  );
});

it("is not taken twice in one process", () => {
  const release = lockState(state);
  expect(() => lockState(state)).toThrow(
    `Workspace ${state.root} is being scanned by this process.`
  );
  release();
});

it("releases once, so a late second release leaves a newer lock alone", () => {
  const first = lockState(state);
  first();
  const second = lockState(state);
  first();
  expect(existsSync(lock)).toBe(true);
  second();
  expect(existsSync(lock)).toBe(false);
});
