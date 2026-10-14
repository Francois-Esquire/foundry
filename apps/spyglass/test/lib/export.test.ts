import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { exportCollection, exportViewer } from "../../src/lib/export";
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
/** Runs before each `cp` the export makes, as `beforeRename` does for `rename`. */
const beforeCopy = vi.hoisted(() => ({
  hook: undefined as ((from: string, to: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    cp: async (
      from: string,
      to: string,
      options?: Parameters<typeof actual.cp>[2]
    ) => {
      beforeCopy.hook?.(from, to);
      return actual.cp(from, to, options);
    },
    rename: async (from: string, to: string) => {
      beforeRename.hook?.(from, to);
      return actual.rename(from, to);
    },
  };
});

afterEach(() => {
  beforeRename.hook = undefined;
  beforeCopy.hook = undefined;
});

const SCAN_TIMEOUT_MS = 120_000;
const MARKER = ".spyglass-static-viewer.json";

let directory: string;
let root: string;
let state: string;
let workspace: WorkspaceState;
let saved: WorkspaceScan;
let viewer: string;

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "spyglass-export-")));
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

it("refuses a directory that holds files Spyglass did not write, and leaves it alone", async () => {
  const site = target("occupied");
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "notes.md"), "mine");
  await expect(exportViewer(root, site, { state })).rejects.toThrow(
    `${site} holds files Spyglass did not write, such as notes.md. Choose another directory.`
  );
  expect(readdirSync(site)).toEqual(["notes.md"]);
});

it("refuses a previous static viewer someone has added to, and leaves it intact", async () => {
  const site = target("published");
  await exportViewer(root, site, { state });
  mkdirSync(join(site, ".git"));
  writeFileSync(join(site, "CNAME"), "spyglass.example.com");
  const before = readdirSync(site).sort();
  await expect(exportViewer(root, site, { state })).rejects.toThrow(
    `${site} holds files Spyglass did not write, such as .git. Choose another directory.`
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
    `${copied} holds files Spyglass did not write, such as`
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
    `${link} is a symbolic link; Spyglass does not write through links. Choose another directory.`
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
  for (const site of [viewer, join(viewer, "spyglass"), dirname(viewer)]) {
    await expect(exportViewer(root, site, { state })).rejects.toThrow(
      `${site} overlaps the viewer's files in ${viewer}. Choose another directory.`
    );
  }
});

it("writes a static viewer inside the workspace, as the documentation example does", async () => {
  const site = join(root, "public", "spyglass");
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
    `No dataset found for ${fresh.root} in ${fresh.output}. Run spyglass scan to save one.`
  );
  expect(existsSync(fresh.directory)).toBe(false);
  expect(existsSync(site)).toBe(false);
});

it("holds the state directory's lock while it copies, so it fails while a scan holds it", async () => {
  const release = lockState(workspace);
  const site = target("locked");
  try {
    await expect(exportViewer(root, site, { state })).rejects.toThrow(
      `Workspace ${workspace.root} is being scanned, exported, or applied by this process.`
    );
  } finally {
    release();
  }
  expect(existsSync(site)).toBe(false);
});

describe("a collection", () => {
  let platform: WorkspaceState;
  let product: WorkspaceState;
  let roots: string[];

  beforeAll(async () => {
    roots = ["platform", "product"].map((name) => {
      const copy = join(directory, name);
      cpSync(join(import.meta.dirname, "fixtures", "collection", name), copy, {
        recursive: true,
      });
      return copy;
    });
    for (const copy of roots) {
      await scan.workspace(copy, { state });
    }
    platform = await workspaceState(roots[0] as string, state);
    product = await workspaceState(roots[1] as string, state);
  }, SCAN_TIMEOUT_MS);

  /** The entries beside `site` whose names start with its own: itself, and any staging left behind. */
  const besides = (site: string) =>
    readdirSync(dirname(site)).filter((name) =>
      name.startsWith(basename(site))
    );

  /** A previous collection export at `site`, and what it held. */
  async function previous(site: string): Promise<string[]> {
    await exportCollection(roots, site, { state });
    return readdirSync(join(site, "data")).sort();
  }

  it("writes each dataset under its id and the collection manifest, and names what it wrote", async () => {
    const site = target("collection");
    const result = await exportCollection([...roots].reverse(), site, {
      state,
    });
    expect(result.workspaces).toEqual([
      {
        dataset: join(site, "data", platform.id),
        id: platform.id,
        root: platform.root,
      },
      {
        dataset: join(site, "data", product.id),
        id: product.id,
        root: product.root,
      },
    ]);
    expect(readdirSync(join(site, "data")).sort()).toEqual(
      ["collection-manifest.json", platform.id, product.id].sort()
    );
    expect(
      JSON.parse(
        readFileSync(join(site, "data/collection-manifest.json"), "utf8")
      )
    ).toEqual(result.manifest);
    expect(result.manifest.crossings).toHaveLength(2);
  });

  it("releases the first workspace's lock and leaves the previous viewer when the second's is held", async () => {
    const site = target("collection-locked");
    const before = await previous(site);
    const held = lockState(product);
    try {
      await expect(exportCollection(roots, site, { state })).rejects.toThrow(
        `Workspace ${product.root} is being scanned, exported, or applied by this process.`
      );
    } finally {
      held();
    }
    lockState(platform)();
    expect(readdirSync(join(site, "data")).sort()).toEqual(before);
    expect(besides(site)).toEqual([basename(site)]);
  });

  it("refuses while one workspace has an unfinished apply, and releases every lock", async () => {
    const site = target("collection-apply");
    const before = await previous(site);
    const journal = join(product.directory, "apply", "journal.json");
    mkdirSync(dirname(journal), { recursive: true });
    writeFileSync(
      journal,
      JSON.stringify({
        files: [],
        phase: "verified",
        schemaVersion: 1,
        site: "packages/db/src/index.ts#Row",
        startedAt: "2026-10-10T00:00:00.000Z",
      })
    );
    try {
      await expect(exportCollection(roots, site, { state })).rejects.toThrow(
        "wrote and verified the sources, but the scan after it did not publish"
      );
    } finally {
      rmSync(dirname(journal), { force: true, recursive: true });
    }
    lockState(platform)();
    lockState(product)();
    expect(readdirSync(join(site, "data")).sort()).toEqual(before);
  });

  it("refuses a target that overlaps the second workspace's state directory", async () => {
    for (const site of [product.directory, join(product.directory, "site")]) {
      await expect(exportCollection(roots, site, { state })).rejects.toThrow(
        `${site} overlaps the state directory ${product.directory}. Choose another directory.`
      );
    }
    expect(existsSync(join(product.directory, "site"))).toBe(false);
  });

  it("leaves the previous viewer and no staging directory when a copy fails part-way", async () => {
    const site = target("collection-copy");
    const before = await previous(site);
    beforeCopy.hook = (from) => {
      if (from === product.output) {
        throw new Error("copy refused");
      }
    };
    await expect(exportCollection(roots, site, { state })).rejects.toThrow(
      "copy refused"
    );
    expect(readdirSync(join(site, "data")).sort()).toEqual(before);
    expect(besides(site)).toEqual([basename(site)]);
    lockState(platform)();
    lockState(product)();
  });
});

it("replaces an old Atlas static viewer using its marker without accepting unrelated files", async () => {
  const site = target("legacy-marker");
  await exportViewer(root, site, { state });
  renameSync(join(site, MARKER), join(site, ".atlas-static-viewer.json"));
  await exportViewer(root, site, { state });
  expect(existsSync(join(site, MARKER))).toBe(true);
  expect(existsSync(join(site, ".atlas-static-viewer.json"))).toBe(false);
  renameSync(join(site, MARKER), join(site, ".atlas-static-viewer.json"));
  writeFileSync(join(site, "personal.txt"), "Keep this");
  await expect(exportViewer(root, site, { state })).rejects.toThrow(
    "personal.txt"
  );
  expect(readFileSync(join(site, "personal.txt"), "utf8")).toBe("Keep this");
});
