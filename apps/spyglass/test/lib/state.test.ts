import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processAlive } from "@foundry/lib/file-lock";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { WorkspaceState } from "../../src/lib/state";
import {
  lockState,
  lockStates,
  resolveCollection,
  resolveRoot,
  workspaceState,
} from "../../src/lib/state";

let directory: string;
let state: WorkspaceState;
let lock: string;

beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "spyglass-state-")));
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
    `Workspace ${state.root} is being scanned, exported, or applied by a process that is starting. Retry.`
  );
});

it("refuses a lock that names no process, and says which file to remove", () => {
  writeFileSync(lock, "garbage");
  expect(() => lockState(state)).toThrow(
    `Workspace ${state.root} is locked by an unknown process. If no scan, export, or apply is running, remove ${lock}.`
  );
});

it("refuses a lock held by another live process, and says which file to remove", () => {
  writeFileSync(lock, String(process.ppid));
  expect(() => lockState(state)).toThrow(
    `Workspace ${state.root} is being scanned, exported, or applied by process ${process.ppid}. Wait for it to finish, then retry.`
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
    `Workspace ${state.root} is locked by process ${exited}, which has exited; another scan, export, or apply is taking the lock over. Retry.`
  );
});

it("is not taken twice in one process", () => {
  const release = lockState(state);
  expect(() => lockState(state)).toThrow(
    `Workspace ${state.root} is being scanned, exported, or applied by this process.`
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

it("names a workspace path that does not exist", async () => {
  const missing = join(directory, "missing");
  await expect(resolveRoot(missing)).rejects.toThrow(
    `Workspace path does not exist: ${missing}`
  );
});

/** Directories under the test's own, created, by name. */
function workspaces(...names: string[]): string[] {
  return names.map((name) => {
    const root = join(directory, name);
    mkdirSync(root, { recursive: true });
    return root;
  });
}

/** Whether the temporary directory's file system ignores case, as macOS's does by default. */
function ignoresCase(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "spyglass-Case-"));
  try {
    return existsSync(probe.toLowerCase()) && existsSync(probe.toUpperCase());
  } finally {
    rmSync(probe, { force: true, recursive: true });
  }
}

it("resolves a collection in one order, whatever the order of its paths", async () => {
  const [product = "", platform = ""] = workspaces("product", "platform");
  const stateRoot = join(directory, "state-root");
  const collection = await resolveCollection([product, platform], stateRoot);
  expect(collection.map((workspace) => workspace.root)).toEqual([
    platform,
    product,
  ]);
  expect(collection).toEqual(
    await resolveCollection([platform, product], stateRoot)
  );
  expect(collection).toEqual([
    await workspaceState(platform, stateRoot),
    await workspaceState(product, stateRoot),
  ]);
  expect(existsSync(stateRoot)).toBe(false);
});

it("keeps a workspace given twice, or through a link, once", async () => {
  const [a = "", b = ""] = workspaces("a", "b");
  const link = join(directory, "link-to-a");
  symlinkSync(a, link);
  const collection = await resolveCollection([a, b, link, `${b}/`]);
  expect(collection.map((workspace) => workspace.root)).toEqual([a, b]);
});

it("accepts a collection of one workspace, and refuses one of none", async () => {
  const [a = ""] = workspaces("a");
  const one = await resolveCollection([a, a]);
  expect(one.map((workspace) => workspace.root)).toEqual([a]);
  await expect(resolveCollection([])).rejects.toThrow(
    "A collection needs at least one workspace."
  );
});

it.runIf(ignoresCase())(
  "keeps one workspace spelled in two cases once, in its own spelling",
  async () => {
    const [mixed = ""] = workspaces("Mixed");
    const collection = await resolveCollection([
      join(directory, "mixed"),
      join(directory, "MIXED"),
    ]);
    expect(collection.map((workspace) => workspace.root)).toEqual([mixed]);
  }
);

it("refuses workspaces that overlap, naming both", async () => {
  const [outer = "", inner = "", beside = ""] = workspaces(
    "repo",
    "repo/packages/nested",
    "repo-b"
  );
  await expect(resolveCollection([inner, beside, outer])).rejects.toThrow(
    `Workspace ${outer} holds workspace ${inner}; the workspaces of a collection cannot overlap.`
  );
  // A sibling whose name extends another's is not inside it.
  await expect(resolveCollection([outer, beside])).resolves.toHaveLength(2);
});

it("refuses a link that resolves inside another workspace", async () => {
  const [outer = "", inner = ""] = workspaces("repo", "repo/packages/nested");
  const link = join(directory, "elsewhere");
  symlinkSync(inner, link);
  await expect(resolveCollection([link, outer])).rejects.toThrow(
    `Workspace ${outer} holds workspace ${inner}; the workspaces of a collection cannot overlap.`
  );
});

it("names the first collection path that does not exist, in the order given", async () => {
  const [a = ""] = workspaces("a");
  const first = join(directory, "missing-z");
  const second = join(directory, "missing-a");
  await expect(resolveCollection([a, first, second])).rejects.toThrow(
    `Workspace path does not exist: ${first}`
  );
});

it("locks every workspace of a collection, and releases them all once", async () => {
  const collection = await resolveCollection(
    workspaces("a", "b"),
    join(directory, "state")
  );
  const locks = collection.map((workspace) =>
    join(workspace.directory, "lock")
  );
  const release = lockStates(collection);
  expect(locks.map((path) => readFileSync(path, "utf8"))).toEqual([
    String(process.pid),
    String(process.pid),
  ]);
  release();
  expect(locks.some((path) => existsSync(path))).toBe(false);
  const again = lockStates(collection);
  release();
  expect(locks.every((path) => existsSync(path))).toBe(true);
  again();
});

it("locks no workspace of a collection when one is held", async () => {
  const collection = await resolveCollection(
    workspaces("a", "b"),
    join(directory, "state")
  );
  const [first, second] = collection;
  if (first === undefined || second === undefined) {
    throw new Error("The collection should hold two workspaces.");
  }
  const held = lockState(second);
  expect(() => lockStates(collection)).toThrow(
    `Workspace ${second.root} is being scanned, exported, or applied by this process.`
  );
  expect(existsSync(join(first.directory, "lock"))).toBe(false);
  held();
});

/** Stand-in locks, failing where `failing` says, that record their releases by workspace id. */
function standIns(
  failing: (workspace: WorkspaceState) => "lock" | "release" | undefined
) {
  const released: string[] = [];
  const standInLock = (workspace: WorkspaceState) => {
    if (failing(workspace) === "lock") {
      throw new Error(`lock ${workspace.id}`);
    }
    return () => {
      released.push(workspace.id);
      if (failing(workspace) === "release") {
        throw new Error(`release ${workspace.id}`);
      }
    };
  };
  return { released, standInLock };
}

/** A collection of the named workspaces, ordered as `lockStates` takes their locks. */
async function lockOrder(...names: string[]): Promise<WorkspaceState[]> {
  const collection = await resolveCollection(
    workspaces(...names),
    join(directory, "state")
  );
  return collection.sort((a, b) => (a.directory < b.directory ? -1 : 1));
}

it("tries every release before it throws a release's failure", async () => {
  const collection = await lockOrder("a", "b", "c");
  const [, middle] = collection;
  const { released, standInLock } = standIns((workspace) =>
    workspace === middle ? "release" : undefined
  );
  // Given in reverse, taken in the order of the directories, released in reverse.
  const release = lockStates([...collection].reverse(), standInLock);
  expect(release).toThrow(`release ${middle?.id}`);
  expect(released).toEqual(
    collection.map((workspace) => workspace.id).reverse()
  );
  release();
  expect(released).toHaveLength(3);
});

it("throws every failed release together", async () => {
  const collection = await lockOrder("a", "b");
  const { standInLock } = standIns(() => "release");
  const release = lockStates(collection, standInLock);
  let thrown: unknown;
  try {
    release();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AggregateError);
  expect((thrown as AggregateError).errors).toHaveLength(2);
});

it("keeps the lock's error when releasing the locks taken fails, with that failure as its cause", async () => {
  const collection = await lockOrder("a", "b");
  const [first, second] = collection;
  const { released, standInLock } = standIns((workspace) => {
    if (workspace === second) {
      return "lock";
    }
    return workspace === first ? "release" : undefined;
  });
  let thrown: unknown;
  try {
    lockStates(collection, standInLock);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({
    cause: { message: `release ${first?.id}` },
    message: `lock ${second?.id}`,
  });
  expect(released).toEqual([first?.id]);
});
