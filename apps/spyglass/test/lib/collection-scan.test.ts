import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DatasetNotFoundError } from "../../src/lib/dataset";
import { savedCollection, savedDataset } from "../../src/lib/dataset-files";
import type {
  CollectionProgressEvent,
  CollectionScan,
} from "../../src/lib/scan";
import { scan } from "../../src/lib/scan";
import { lockState, workspaceState } from "../../src/lib/state";

const SCAN_TIMEOUT_MS = 120_000;

let directory: string;
let platform: string;
let product: string;
let state: string;
let scanned: CollectionScan;
let events: CollectionProgressEvent[];

/** A copy of one of the collection fixtures, resolved. */
function copyFixture(name: string): string {
  const target = join(directory, name);
  cpSync(join(import.meta.dirname, "fixtures", "collection", name), target, {
    recursive: true,
  });
  return realpathSync(target);
}

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "spyglass-collection-")));
  platform = copyFixture("platform");
  product = copyFixture("product");
  state = join(directory, "state");
  events = [];
  // Given out of order: the collection scans by resolved root.
  scanned = await scan.collection([product, platform], {
    onProgress: (event) => events.push(event),
    state,
  });
}, SCAN_TIMEOUT_MS);

afterAll(() => {
  rmSync(directory, { force: true, recursive: true });
});

it("scans each workspace in the collection's order and returns their scans and the collection manifest", async () => {
  const [platformState, productState] = await Promise.all(
    [platform, product].map((root) => workspaceState(root, state))
  );
  expect(scanned.workspaces.map((saved) => saved.output)).toEqual([
    platformState?.output,
    productState?.output,
  ]);
  expect(scanned.manifest.crossings.map(({ from, to }) => [from, to])).toEqual([
    [`${productState?.id}:@p/app`, `${platformState?.id}:@k/db`],
    [`${productState?.id}:@p/web`, `${platformState?.id}:@k/db`],
  ]);
  // Each workspace's scan is a full scan, with its accessors.
  const [first] = scanned.workspaces;
  expect((await first?.internals("@k/db"))?.topology.package.id).toBe("@k/db");
  expect(Object.keys(JSON.parse(JSON.stringify(scanned)))).toEqual([
    "manifest",
    "workspaces",
  ]);
});

it("derives the same collection manifest from the saved datasets", async () => {
  const saved = await savedCollection([platform, product], state);
  expect(await saved.manifest()).toEqual(scanned.manifest);
  expect([...saved.datasets.values()]).toEqual(
    scanned.workspaces.map((workspace) => workspace.output)
  );
});

it("wraps each workspace's progress with its id and root, one workspace after the other", async () => {
  expect(events.every((event) => event.kind === "workspace")).toBe(true);
  const roots = events.map((event) => event.root);
  expect(roots.indexOf(product)).toBeGreaterThan(roots.lastIndexOf(platform));
  const { id } = await workspaceState(platform, state);
  expect(events[0]).toMatchObject({ id, root: platform });
  expect(events.map((event) => event.event.kind)).toContain("phase");
});

it(
  "keeps the datasets saved before a workspace fails, and names the root that failed",
  async () => {
    const failing = join(directory, "failing-state");
    const held = lockState(await workspaceState(product, failing));
    try {
      const failure = scan.collection([platform, product], { state: failing });
      await expect(failure).rejects.toThrow(
        `Spyglass could not scan ${product}: Workspace ${product} is being scanned, exported, or applied by this process.`
      );
      await expect(failure).rejects.toMatchObject({
        cause: { message: expect.stringContaining("by this process") },
      });
      // The scans that succeeded come with the rejection.
      const rejection: unknown = await failure.catch((error: unknown) => error);
      const { scanned: kept } = rejection as { scanned: { output: string }[] };
      expect(kept.map((workspace) => workspace.output)).toEqual([
        (await workspaceState(platform, failing)).output,
      ]);
    } finally {
      held();
    }
    const saved = await savedDataset(platform, failing);
    expect(saved.workspace.root).toBe(platform);
    await expect(savedDataset(product, failing)).rejects.toThrow(
      DatasetNotFoundError
    );
    await expect(savedCollection([platform, product], failing)).rejects.toThrow(
      `No dataset found for ${product}`
    );
  },
  SCAN_TIMEOUT_MS
);

it("names the workspace whose dataset another Spyglass saved, when the collection starts", async () => {
  const older = join(directory, "older-state");
  cpSync(state, older, { recursive: true });
  const { output } = await workspaceState(product, older);
  const manifest = join(output, "manifest.json");
  const saved = JSON.parse(readFileSync(manifest, "utf8")) as object;
  writeFileSync(manifest, JSON.stringify({ ...saved, schemaVersion: 4 }));
  await expect(savedCollection([platform, product], older)).rejects.toThrow(
    `Workspace ${product}: Spyglass reads dataset schema version 5; this dataset has version 4. Run spyglass scan to save it again.`
  );
});
