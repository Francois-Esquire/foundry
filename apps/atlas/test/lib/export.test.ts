import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { exportViewer } from "../../src/lib/export";
import type { WorkspaceScan } from "../../src/lib/scan";
import { scan } from "../../src/lib/scan";
import { viewerRoot } from "../../src/lib/serve";
import type { WorkspaceState } from "../../src/lib/state";
import { lockState, workspaceState } from "../../src/lib/state";

/**
 * Runs before each `rename` the export makes, so a test can make one fail.
 * Unset, `rename` behaves as it does without the mock.
 */
const beforeRename = vi.hoisted(() => ({
  hook: undefined as ((from: string, to: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      beforeRename.hook?.(from, to);
      return actual.rename(from, to);
    },
  };
});

afterEach(() => {
  beforeRename.hook = undefined;
});

const SCAN_TIMEOUT_MS = 120_000;
const MARKER = ".atlas-static-viewer.json";

let directory: string;
let root: string;
let state: string;
let workspace: WorkspaceState;
let saved: WorkspaceScan;
let viewer: string;

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "atlas-export-")));
  root = join(directory, "workspace");
  cpSync(join(import.meta.dirname, "fixtures", "semantics"), root, {
    recursive: true,
  });
  state = join(directory, "state");
  saved = await scan.workspace(root, { state });
  workspace = await workspaceState(root, state);
  viewer = await viewerRoot();
}, SCAN_TIMEOUT_MS);

afterAll(() => {
  rmSync(directory, { force: true, recursive: true });
});

function target(name: string): string {
  return join(directory, "exports", name);
}

it("writes the viewer at the root and the saved dataset under data/", async () => {
  const site = target("fresh");
  const result = await exportViewer(root, site, { state });
  expect(JSON.parse(JSON.stringify(result))).toEqual({
    directory: site,
    manifest: saved.manifest,
  });
  expect(readFileSync(join(site, "index.html"), "utf8")).toBe(
    readFileSync(join(viewer, "index.html"), "utf8")
  );
  expect(readFileSync(join(site, "data/manifest.json"), "utf8")).toBe(
    readFileSync(join(workspace.output, "manifest.json"), "utf8")
  );
  expect(readFileSync(join(site, "data/workspace.json"), "utf8")).toBe(
    readFileSync(join(workspace.output, "workspace.json"), "utf8")
  );
  expect(JSON.parse(readFileSync(join(site, MARKER), "utf8"))).toEqual({
    entries: readdirSync(site)
      .filter((entry) => entry !== MARKER)
      .sort(),
  });
  expect(readdirSync(site)).toContain("data");
  expect(existsSync(join(workspace.directory, "lock"))).toBe(false);
});

it("replaces a clean previous static viewer, entries an older viewer wrote included, and leaves no staging directory", async () => {
  const site = target("again");
  await exportViewer(root, site, { state });
  // An entry an older viewer wrote and this one does not.
  writeFileSync(join(site, "old-viewer.js"), "from the last export");
  const marker = JSON.parse(readFileSync(join(site, MARKER), "utf8")) as {
    entries: string[];
  };
  writeFileSync(
    join(site, MARKER),
    JSON.stringify({ entries: [...marker.entries, "old-viewer.js"] })
  );
  await exportViewer(root, site, { state });
  expect(existsSync(join(site, "old-viewer.js"))).toBe(false);
  expect(existsSync(join(site, "data/manifest.json"))).toBe(true);
  expect(
    readdirSync(dirname(site)).filter((name) => name.startsWith("again"))
  ).toEqual(["again"]);
});

it("writes into an empty directory", async () => {
  const site = target("empty");
  mkdirSync(site, { recursive: true });
  await exportViewer(root, site, { state });
  expect(existsSync(join(site, "index.html"))).toBe(true);
});

it("refuses a directory that holds files Atlas did not write, and leaves it alone", async () => {
  const site = target("occupied");
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "notes.md"), "mine");
  await expect(exportViewer(root, site, { state })).rejects.toThrow(
    `${site} holds files Atlas did not write, such as notes.md. Choose another directory.`
  );
  expect(readdirSync(site)).toEqual(["notes.md"]);
});

it("refuses a previous static viewer someone has added to, and leaves it intact", async () => {
  const site = target("published");
  await exportViewer(root, site, { state });
  mkdirSync(join(site, ".git"));
  writeFileSync(join(site, "CNAME"), "atlas.example.com");
  const before = readdirSync(site).sort();
  await expect(exportViewer(root, site, { state })).rejects.toThrow(
    `${site} holds files Atlas did not write, such as .git. Choose another directory.`
  );
  expect(readdirSync(site).sort()).toEqual(before);
});

it("treats an empty directory's Finder file as empty, and a viewer copied without its marker as someone's files", async () => {
  const finder = target("finder");
  mkdirSync(finder, { recursive: true });
  writeFileSync(join(finder, ".DS_Store"), "");
  await exportViewer(root, finder, { state });
  expect(existsSync(join(finder, "index.html"))).toBe(true);
  const copied = target("copied");
  cpSync(finder, copied, { recursive: true });
  rmSync(join(copied, MARKER));
  await expect(exportViewer(root, copied, { state })).rejects.toThrow(
    `${copied} holds files Atlas did not write, such as`
  );
});

it("refuses a file and a symbolic link", async () => {
  const file = target("file.txt");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "a file");
  await expect(exportViewer(root, file, { state })).rejects.toThrow(
    `${file} is not a directory. Choose another directory.`
  );
  const real = target("real");
  mkdirSync(real);
  const link = target("link");
  symlinkSync(real, link);
  await expect(exportViewer(root, link, { state })).rejects.toThrow(
    `${link} is a symbolic link; Atlas does not write through links. Choose another directory.`
  );
  expect(readdirSync(real)).toEqual([]);
});

it("leaves the previous static viewer and no staging directory when it cannot be moved aside", async () => {
  const site = target("stuck");
  await exportViewer(root, site, { state });
  const before = readdirSync(site).sort();
  beforeRename.hook = (_from, to) => {
    if (to.includes(".previous-")) {
      throw new Error("rename refused");
    }
  };
  await expect(exportViewer(root, site, { state })).rejects.toThrow(
    "rename refused"
  );
  expect(readdirSync(site).sort()).toEqual(before);
  expect(
    readdirSync(dirname(site)).filter((name) => name.startsWith("stuck"))
  ).toEqual(["stuck"]);
});

it("puts the previous static viewer back when the new one cannot be swapped in", async () => {
  const site = target("swap");
  await exportViewer(root, site, { state });
  const before = readdirSync(site).sort();
  beforeRename.hook = (from) => {
    if (from.includes(".export-")) {
      throw new Error("swap refused");
    }
  };
  await expect(exportViewer(root, site, { state })).rejects.toThrow(
    "swap refused"
  );
  expect(readdirSync(site).sort()).toEqual(before);
  expect(
    readdirSync(dirname(site)).filter((name) => name.startsWith("swap"))
  ).toEqual(["swap"]);
});

it("refuses to write over the workspace, the state directory, or the viewer", async () => {
  for (const site of [root, directory, dirname(directory)]) {
    await expect(exportViewer(root, site, { state })).rejects.toThrow(
      `${site} holds the workspace ${root}. Choose another directory.`
    );
  }
  for (const site of [
    workspace.directory,
    state,
    join(workspace.directory, "export"),
    join(workspace.output, "data"),
  ]) {
    await expect(exportViewer(root, site, { state })).rejects.toThrow(
      `${site} overlaps the state directory ${workspace.directory}. Choose another directory.`
    );
  }
  for (const site of [viewer, join(viewer, "atlas"), dirname(viewer)]) {
    await expect(exportViewer(root, site, { state })).rejects.toThrow(
      `${site} overlaps the viewer's files in ${viewer}. Choose another directory.`
    );
  }
});

it("writes a static viewer inside the workspace, as the documentation example does", async () => {
  const site = join(root, "public", "atlas");
  await exportViewer(root, site, { state });
  expect(existsSync(join(site, "data/manifest.json"))).toBe(true);
  rmSync(join(root, "public"), { force: true, recursive: true });
});

it("fails for a workspace never scanned, before it creates a state directory", async () => {
  const other = join(directory, "never-scanned");
  mkdirSync(other);
  const fresh = await workspaceState(other, state);
  const site = target("never");
  await expect(exportViewer(other, site, { state })).rejects.toThrow(
    `No dataset found for ${fresh.root} in ${fresh.output}. Run atlas scan to save one.`
  );
  expect(existsSync(fresh.directory)).toBe(false);
  expect(existsSync(site)).toBe(false);
});

it("holds the state directory's lock while it copies, so it fails while a scan holds it", async () => {
  const release = lockState(workspace);
  const site = target("locked");
  try {
    await expect(exportViewer(root, site, { state })).rejects.toThrow(
      `Workspace ${workspace.root} is being scanned or exported by this process.`
    );
  } finally {
    release();
  }
  expect(existsSync(site)).toBe(false);
});
