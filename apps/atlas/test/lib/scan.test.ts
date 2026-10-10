import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DatasetReplacedError, datasetReader } from "../../src/lib/dataset";
import { fileTransport } from "../../src/lib/dataset-files";
import { encodePackageFile } from "../../src/lib/dataset-layout";
import type {
  PackageInternals,
  PackageReport,
  Scan,
  ScanProgressEvent,
  WorkspaceScan,
} from "../../src/lib/scan";
import { scan } from "../../src/lib/scan";
import { workspaceState } from "../../src/lib/state";
import { readCodexSource } from "../../src/web/codex/source";
import { viewerDataset } from "../../src/web/dataset";
import { commitFixture } from "../helpers/commit-fixture";
import { listedFiles } from "../helpers/dataset-files";
import { recordReads, stubFetch } from "../helpers/dataset-transport";

/**
 * Called after each file the scan's accessors read from disk, so a test can
 * stand in for a scan that saves over the dataset mid-read. Unset, the file
 * transport behaves as it does without the mock.
 */
const afterFileRead = vi.hoisted(() => ({
  hook: undefined as ((output: string, path: string) => void) | undefined,
}));

vi.mock("../../src/lib/dataset-files", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/dataset-files")>();
  return {
    fileTransport: (output: string) => {
      const read = actual.fileTransport(output);
      return async (path: string) => {
        const value = await read(path);
        afterFileRead.hook?.(output, path);
        return value;
      };
    },
  };
});

const SCAN_TIMEOUT_MS = 120_000;
const FIXTURE_PACKAGES = ["@s/a", "@s/b", "@s/c"];

let directory: string;
let root: string;
let workspace: WorkspaceScan;
let workspaceEvents: ScanProgressEvent[];
let workspaceStarted: number;
let workspaceFinished: number;
let everything: Scan;
let everythingEvents: ScanProgressEvent[];

function copyFixture(into: string): string {
  const target = join(into, "workspace");
  cpSync(join(import.meta.dirname, "fixtures", "semantics"), target, {
    recursive: true,
  });
  return realpathSync(target);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function datasetFile(output: string, folder: string, id: string): string {
  return join(output, folder, `${encodePackageFile(id)}.json`);
}

/** Every file under `dir`, relative, posix. */
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const file = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? filesUnder(dir, file) : [file];
    }
  );
}

/** Files under the dataset that it does not name. */
function unlistedFiles(output: string): string[] {
  const listed = new Set(listedFiles(output));
  return filesUnder(output).filter((file) => !listed.has(file));
}

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "atlas-scan-")));
  root = copyFixture(directory);
  workspaceEvents = [];
  workspaceStarted = Date.now();
  workspace = await scan.workspace(root, {
    onProgress: (event) => workspaceEvents.push(event),
    state: join(directory, "workspace-state"),
  });
  workspaceFinished = Date.now();
  everythingEvents = [];
  everything = await scan(root, {
    onProgress: (event) => everythingEvents.push(event),
    state: join(directory, "state"),
  });
}, SCAN_TIMEOUT_MS);

afterAll(() => {
  rmSync(directory, { force: true, recursive: true });
});

it("scan.workspace saves the dataset without internals, every file listed in its manifest", () => {
  expect(workspace.output.startsWith(join(directory, "workspace-state"))).toBe(
    true
  );
  expect(workspace.manifest).toEqual(
    readJson(join(workspace.output, "manifest.json"))
  );
  expect(workspace.manifest.packages.map((pkg) => pkg.id)).toEqual(
    FIXTURE_PACKAGES
  );
  expect(unlistedFiles(workspace.output)).toEqual([]);
  expect(
    workspace.manifest.packages.map((pkg) => [pkg.id, pkg.internals])
  ).toEqual(FIXTURE_PACKAGES.map((id) => [id, undefined]));
  expect(
    workspace.manifest.packages.find((pkg) => pkg.id === "@s/a")
      ?.declaredDependencies
  ).toEqual({ dependencies: { "@s/b": "workspace:*" } });
  expect(existsSync(join(workspace.output, "internals"))).toBe(false);
  expect(existsSync(join(workspace.output, "manifests"))).toBe(false);
  expect(workspace.history).toBeUndefined();
  const phases = workspaceEvents.flatMap((event) =>
    event.kind === "phase" ? [event.phase] : []
  );
  expect(phases[0]).toBe("discover");
  expect(phases.at(-1)).toBe("write");
  expect(workspaceEvents.some((event) => event.kind === "internals")).toBe(
    false
  );
});

it("scan.workspace records the workspace and when it was scanned in its state directory", async () => {
  const state = await workspaceState(root, join(directory, "workspace-state"));
  const { version } = readJson(
    join(import.meta.dirname, "..", "..", "package.json")
  ) as { version: string };
  const record = readJson(join(state.directory, "workspace.json")) as {
    lastScannedAt: string;
  };
  expect(record).toEqual({
    atlasVersion: version,
    id: state.id,
    lastScannedAt: expect.any(String),
    root,
    schemaVersion: 1,
  });
  expect(new Date(record.lastScannedAt).toISOString()).toBe(
    record.lastScannedAt
  );
  const scannedAt = Date.parse(record.lastScannedAt);
  expect(scannedAt).toBeGreaterThanOrEqual(workspaceStarted);
  expect(scannedAt).toBeLessThanOrEqual(workspaceFinished);
});

it(
  "a second scan of a workspace that is being scanned fails, and the first saves its dataset",
  async () => {
    const options = { state: join(directory, "concurrent-state") };
    const state = await workspaceState(root, options.state);
    let second: Promise<unknown> | undefined;
    let recordWhileScanning: unknown;
    const first = await scan.workspace(root, {
      ...options,
      // The first event comes from inside the scan, with the lock held.
      onProgress: () => {
        if (second === undefined) {
          recordWhileScanning = readJson(
            join(state.directory, "workspace.json")
          );
          second = scan.workspace(root, options).then(
            () => undefined,
            (error: unknown) => error
          );
        }
      },
    });
    const refused = await second;
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe(
      `Workspace ${root} is being scanned or exported by this process.`
    );
    // Written as soon as the lock is held, before the dataset is saved.
    expect(recordWhileScanning).toEqual({
      id: state.id,
      root,
      schemaVersion: 1,
    });
    expect(first.manifest).toEqual(
      readJson(join(first.output, "manifest.json"))
    );
    expect(first.manifest.packages.map((pkg) => pkg.id)).toEqual(
      FIXTURE_PACKAGES
    );
    expect(existsSync(join(state.directory, "lock"))).toBe(false);
    expect(existsSync(join(state.directory, "lock.break"))).toBe(false);
  },
  SCAN_TIMEOUT_MS
);

it("a scan refuses a lock held by another live process and writes no record", async () => {
  const options = { state: join(directory, "held-state") };
  const state = await workspaceState(root, options.state);
  mkdirSync(state.directory, { recursive: true });
  writeFileSync(join(state.directory, "lock"), String(process.ppid));
  await expect(scan.workspace(root, options)).rejects.toThrow(
    `Workspace ${root} is being scanned or exported by process ${process.ppid}.`
  );
  expect(existsSync(join(state.directory, "workspace.json"))).toBe(false);
});

it(
  "a scan that fails after saving its dataset leaves the lock released and the save recorded",
  async () => {
    // The fixture copy is not a Git repository, so history fails after the
    // dataset is saved.
    const options = { history: true, state: join(directory, "failed-state") };
    const state = await workspaceState(root, options.state);
    const record = join(state.directory, "workspace.json");
    const savedAt = (): number =>
      Date.parse((readJson(record) as { lastScannedAt: string }).lastScannedAt);

    await expect(scan.workspace(root, options)).rejects.toThrow();
    expect(existsSync(join(state.directory, "lock"))).toBe(false);
    expect(existsSync(join(state.directory, "lock.break"))).toBe(false);
    expect(readJson(record)).toMatchObject({
      atlasVersion: expect.any(String),
      id: state.id,
      lastScannedAt: expect.any(String),
      root,
    });
    expect(existsSync(join(state.output, "manifest.json"))).toBe(true);
    const first = savedAt();

    // The second run saves a dataset again before failing, so the record
    // moves with it.
    await expect(scan.workspace(root, options)).rejects.toThrow();
    expect(savedAt()).toBeGreaterThan(first);
  },
  SCAN_TIMEOUT_MS
);

it("scan saves every complete package's internals in the dataset it publishes, reporting each one", () => {
  expect(everything.manifest).toEqual(
    readJson(join(everything.output, "manifest.json"))
  );
  const complete = everything.manifest.packages
    .filter((pkg) => pkg.status === "complete")
    .map((pkg) => pkg.id);
  expect(complete).toEqual(FIXTURE_PACKAGES);
  expect(
    everything.manifest.packages.map((pkg) => [pkg.id, pkg.internals])
  ).toEqual([
    ["@s/a", "internals/@s__a.json"],
    ["@s/b", "internals/@s__b.json"],
    ["@s/c", "internals/@s__c.json"],
  ]);
  expect(unlistedFiles(everything.output)).toEqual([]);
  const lastPhase = everythingEvents.findLastIndex(
    (event) => event.kind === "phase"
  );
  expect(everythingEvents.slice(lastPhase + 1)).toEqual(
    complete.map((id, index) => ({
      index: index + 1,
      kind: "internals",
      package: id,
      total: complete.length,
    }))
  );
  expect(everything.history).toBeUndefined();
});

it("scan reads back each package's report and internals from the dataset it saved", async () => {
  const report: PackageReport = await everything.packageReport("@s/b");
  expect(report).toEqual(
    readJson(datasetFile(everything.output, "packages", "@s/b"))
  );
  await expect(everything.internals("@s/b")).resolves.toEqual(
    readJson(datasetFile(everything.output, "internals", "@s/b"))
  );
  await expect(everything.workspaceReport()).resolves.toEqual(
    readJson(join(everything.output, "workspace.json"))
  );
});

it("one package's results read the manifest and one file, not every shard", async () => {
  const report = recordReads(fileTransport(everything.output));
  await datasetReader(report.read).packageReport("@s/b");
  expect(report.reads).toEqual(["manifest.json", "packages/@s__b.json"]);
  const internals = recordReads(fileTransport(everything.output));
  await datasetReader(internals.read).internals("@s/b");
  expect(internals.reads).toEqual(["manifest.json", "internals/@s__b.json"]);
});

it("scan.workspace reads back its reports and has no internals to read", async () => {
  await expect(workspace.workspaceReport()).resolves.toEqual(
    readJson(join(workspace.output, "workspace.json"))
  );
  await expect(workspace.packageReport("@s/a")).resolves.toEqual(
    readJson(datasetFile(workspace.output, "packages", "@s/a"))
  );
  expect("internals" in workspace).toBe(false);
  await expect(
    datasetReader(fileTransport(workspace.output)).internals("@s/a")
  ).rejects.toThrow(
    "The dataset was saved without internals for @s/a. Run atlas scan to include them."
  );
});

it("a scan's result is JSON without its accessors", () => {
  expect(JSON.parse(JSON.stringify(everything))).toEqual({
    manifest: everything.manifest,
    output: everything.output,
  });
});

// A web import in a lib test, so this check reuses the scan above instead
// of running another.
it("the viewer and the library read the saved dataset through one reader", async () => {
  stubFetch(fileTransport(everything.output));
  try {
    const served = await readCodexSource(viewerDataset());
    expect(served).toEqual(
      await readCodexSource(datasetReader(fileTransport(everything.output)))
    );
    expect(served.packages.map((pkg) => pkg.id).sort()).toEqual(
      FIXTURE_PACKAGES
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it("scan.package returns one package's internals, as the dataset saves them", async () => {
  const internals: PackageInternals = await scan.package(root, "@s/b");
  expect(internals.topology.package.id).toBe("@s/b");
  expect(internals).toEqual(
    readJson(datasetFile(everything.output, "internals", "@s/b"))
  );
  expect(existsSync(join(root, ".foundry"))).toBe(false);
  // Read-only: resolving the default state directory creates nothing, and
  // scan.package writes no record there.
  const state = await workspaceState(root);
  expect(existsSync(state.output)).toBe(false);
  expect(existsSync(join(state.directory, "workspace.json"))).toBe(false);
});

it("scan.package rejects a name with no package the workspace declares", async () => {
  // No package pattern matches `libraries/`.
  await expect(scan.package(root, "@s/lib")).rejects.toThrow(
    `Workspace ${root} has no package named @s/lib.`
  );
});

it("scan.package refuses a workspace that declares no packages", async () => {
  const undeclared = join(directory, "undeclared");
  cpSync(root, undeclared, { recursive: true });
  writeFileSync(
    join(undeclared, "package.json"),
    JSON.stringify({ name: "solo" })
  );
  await expect(scan.package(undeclared, "@s/b")).rejects.toThrow(
    `Workspace ${undeclared} declares no packages. Atlas reads them from pnpm-workspace.yaml or package.json#workspaces.`
  );
});

it(
  "a scan follows the workspace's configuration directory",
  async () => {
    const configured = join(directory, "configured");
    cpSync(root, configured, { recursive: true });
    mkdirSync(join(configured, ".foundry", "atlas"), { recursive: true });
    writeFileSync(
      join(configured, ".foundry", "atlas", "index.ts"),
      'export default { exclude: ["tooling/c", "tooling/gone"] };\n'
    );
    const saved = await scan.workspace(configured, {
      state: join(directory, "configured-state"),
    });
    expect(saved.manifest.packages.map((pkg) => pkg.id)).toEqual([
      "@s/a",
      "@s/b",
    ]);
    expect(saved.manifest.discovery.unitsSkipped).toContainEqual({
      path: "tooling/c",
      reason: "excluded",
    });
    expect(saved.manifest.discovery.excludeUnmatched).toEqual(["tooling/gone"]);
    await expect(scan.package(configured, "@s/c")).rejects.toThrow(
      "no package named @s/c"
    );
  },
  SCAN_TIMEOUT_MS
);

it(
  "scan with history saves the checkpoints into the dataset",
  async () => {
    const historyRoot = copyFixture(
      realpathSync(mkdtempSync(join(directory, "history-")))
    );
    commitFixture(historyRoot);
    const events: ScanProgressEvent[] = [];
    const past = await scan(historyRoot, {
      history: true,
      onProgress: (event) => events.push(event),
      state: join(directory, "history-state"),
    });
    expect(past.history?.manifest.generation.failedSnapshots).toBe(0);
    expect(
      past.history?.manifest.generation.successfulSnapshots
    ).toBeGreaterThan(0);
    expect(past.history?.manifest).toEqual(
      readJson(join(past.output, "history", "manifest.json"))
    );
    expect(existsSync(datasetFile(past.output, "internals", "@s/a"))).toBe(
      true
    );
    expect(unlistedFiles(past.output)).toEqual([]);
    expect(events.at(-1)?.kind).toBe("history");
  },
  SCAN_TIMEOUT_MS
);

it.each([
  [
    "packageReport",
    "packages/@s__b.json",
    () => everything.packageReport("@s/b"),
  ],
  ["internals", "internals/@s__b.json", () => everything.internals("@s/b")],
  ["workspaceReport", "workspace.json", () => everything.workspaceReport()],
] as const)(
  "%s refuses a dataset that a scan replaced while it read",
  async (_accessor, target, read) => {
    const manifest = join(everything.output, "manifest.json");
    const saved = readFileSync(manifest);
    afterFileRead.hook = (output, path) => {
      if (output === everything.output && path === target) {
        writeFileSync(
          manifest,
          JSON.stringify({
            ...everything.manifest,
            generatedAt: "2099-01-01T00:00:00.000Z",
          })
        );
      }
    };
    try {
      await expect(read()).rejects.toBeInstanceOf(DatasetReplacedError);
    } finally {
      afterFileRead.hook = undefined;
      writeFileSync(manifest, saved);
    }
  }
);

// Last, since it rewrites the workspace scan's saved manifest; it puts the
// bytes back.
it("a scan's accessors refuse a dataset that a later scan replaced", async () => {
  const manifest = join(workspace.output, "manifest.json");
  const saved = readFileSync(manifest);
  writeFileSync(
    manifest,
    JSON.stringify({
      ...workspace.manifest,
      generatedAt: "2099-01-01T00:00:00.000Z",
    })
  );
  try {
    await expect(workspace.packageReport("@s/a")).rejects.toBeInstanceOf(
      DatasetReplacedError
    );
    await expect(workspace.workspaceReport()).rejects.toThrow(
      "A later scan replaced this dataset. Scan again to read the new one."
    );
  } finally {
    writeFileSync(manifest, saved);
  }
});
