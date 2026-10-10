import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  PackageInternals,
  Scan,
  ScanProgressEvent,
  WorkspaceScan,
} from "../../src/lib/scan";
import { scan } from "../../src/lib/scan";
import { encodePackageFile } from "../../src/lib/semantics";
import { workspaceState } from "../../src/lib/state";
import { commitFixture } from "../helpers/commit-fixture";

const SCAN_TIMEOUT_MS = 120_000;
const FIXTURE_PACKAGES = ["@s/a", "@s/b", "@s/c"];

let directory: string;
let root: string;
let workspace: WorkspaceScan;
let workspaceEvents: ScanProgressEvent[];
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

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "atlas-scan-")));
  root = copyFixture(directory);
  workspaceEvents = [];
  workspace = await scan.workspace(root, {
    onProgress: (event) => workspaceEvents.push(event),
    state: join(directory, "workspace-state"),
  });
  everythingEvents = [];
  everything = await scan(root, {
    onProgress: (event) => everythingEvents.push(event),
    state: join(directory, "state"),
  });
}, SCAN_TIMEOUT_MS);

afterAll(() => {
  rmSync(directory, { force: true, recursive: true });
});

it("scan.workspace saves the dataset and manifests/, without internals", () => {
  expect(workspace.output.startsWith(join(directory, "workspace-state"))).toBe(
    true
  );
  expect(workspace.manifest).toEqual(
    readJson(join(workspace.output, "manifest.json"))
  );
  expect(workspace.manifest.packages.map((pkg) => pkg.id)).toEqual(
    FIXTURE_PACKAGES
  );
  for (const id of FIXTURE_PACKAGES) {
    expect(existsSync(datasetFile(workspace.output, "manifests", id))).toBe(
      true
    );
  }
  expect(existsSync(join(workspace.output, "internals"))).toBe(false);
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

it("scan saves every complete package's internals and reports each one after the dataset", () => {
  expect(everything.manifest).toEqual(
    readJson(join(everything.output, "manifest.json"))
  );
  const complete = everything.manifest.packages
    .filter((pkg) => pkg.status === "complete")
    .map((pkg) => pkg.id);
  expect(complete.length).toBeGreaterThan(0);
  for (const id of complete) {
    expect(existsSync(datasetFile(everything.output, "internals", id))).toBe(
      true
    );
  }
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

it("scan.package returns one package's internals, as the dataset saves them", async () => {
  const internals: PackageInternals = await scan.package(root, "@s/b");
  expect(internals.topology.package.id).toBe("@s/b");
  const { timing: _timing, ...saved } = readJson(
    datasetFile(everything.output, "internals", "@s/b")
  ) as Record<string, unknown>;
  expect(internals).toEqual(saved);
  expect(existsSync(join(root, ".foundry"))).toBe(false);
  // Read-only: resolving the default state directory creates nothing.
  expect(existsSync((await workspaceState(root)).output)).toBe(false);
});

it("scan.package rejects a name with no package under the workspace's roots", async () => {
  // `libraries/` is not one of the default roots.
  await expect(scan.package(root, "@s/lib")).rejects.toThrow("@s/lib");
});

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
    expect(events.at(-1)?.kind).toBe("history");
  },
  SCAN_TIMEOUT_MS
);
