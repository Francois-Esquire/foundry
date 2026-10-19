import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import type { CheckResult } from "../src/lib/check";
import type { ApplyResult, PlanSiteResult } from "../src/lib/codemod-types";
import type { PackageInternals } from "../src/lib/internal-analysis-types";
import type { Domains } from "../src/lib/lenses/domains-types";
import type { FileRoles } from "../src/lib/lenses/file-roles-types";
import type { Nesting } from "../src/lib/lenses/nesting-types";
import { rootRelativeFolder } from "../src/lib/lenses/package-internals";
import type { Placements } from "../src/lib/lenses/placement-types";
import type { Proximity } from "../src/lib/lenses/proximity-types";
import type { ResponsibilityGroups } from "../src/lib/lenses/responsibility-groups-types";
import type { Rule } from "../src/lib/rule-declaration";
import { ruleFingerprint } from "../src/lib/rules";
import { scan } from "../src/lib/scan";
import type { HistoryManifest } from "../src/lib/semantics-history-types";
import type { DatasetManifest } from "../src/lib/semantics-types";
import { serve } from "../src/lib/serve";
import { loadConfiguration } from "../src/lib/spyglass-config";
import type { WorkspaceState } from "../src/lib/state";
import { workspaceState } from "../src/lib/state";
import { startServer } from "../src/server/server";
import { archipelagoRims } from "../src/web/layout/archipelago";
import { crossingPairs } from "../src/web/layout/crossings";
import { frameSea } from "../src/web/layout/geography";
import { loadInternals } from "../src/web/layout/load-internals";
import {
  loadImports,
  loadLateReadings,
  loadSpyglass,
} from "../src/web/layout/load-spyglass";
import { CLI, spawnCli, spawnDetached } from "./helpers/cli";
import { commitFixture } from "./helpers/commit-fixture";

const directories: string[] = [];
const DEV_SERVER_URL = /http:\/\/127\.0\.0\.1:\d+\//;
const SERVER_URL = /Spyglass: (http:\/\/\S+)/;
const BUNDLED_ASSET = /(?:src|href)="([^"]+\.(?:js|css))"/g;
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "spyglass-test-"));
  directories.push(directory);
  const root = join(directory, "workspace");
  await mkdir(root);
  const workspace = await workspaceState(root, join(directory, "state"));
  return { directory, workspace };
}

test("workspace identity resolves symlinks and isolates separate checkouts", async () => {
  const { directory, workspace } = await fixture();
  const alias = join(directory, "alias");
  await symlink(workspace.root, alias);
  expect(await workspaceState(alias, join(directory, "state"))).toEqual(
    workspace
  );
  const other = join(directory, "other");
  await mkdir(other);
  expect(
    (await workspaceState(other, join(directory, "state"))).output
  ).not.toBe(workspace.output);
});

test("the workspace id, the first 12 hex digits of the root's SHA-256, names the state directory", async () => {
  const { directory } = await fixture();
  const state = join(directory, "state");
  // sha256("/") is 8a5edab282632443219e051e4ade2d1d5bbc671c781051bf1437897cbdfea0f1.
  const workspace = await workspaceState("/", state);
  expect(workspace.id).toBe("8a5edab28263");
  expect(workspace.directory).toBe(join(state, "8a5edab28263"));
  expect(workspace.output).toBe(join(workspace.directory, "output"));
  expect(workspace.cache).toBe(join(workspace.directory, "cache"));
});

test("server preserves generated file bytes and serves public assets without exposing caches", async () => {
  const { workspace, directory } = await fixture();
  const viewer = resolve(import.meta.dirname, "../dist/web");
  await mkdir(workspace.output, { recursive: true });
  await mkdir(workspace.cache);
  await writeFile(join(workspace.cache, "private.json"), "private");
  const manifest =
    '{\n  "schemaVersion": 3, "packages": [], "extra": {"value": null}\n}\n';
  await writeFile(join(workspace.output, "manifest.json"), manifest);
  await mkdir(join(workspace.output, "evidence"));
  const evidence = new Uint8Array([0, 1, 128, 255]);
  await writeFile(join(workspace.output, "evidence", "raw.bin"), evidence);
  const secret = join(directory, "secret.txt");
  await writeFile(secret, "secret");
  await symlink(secret, join(workspace.output, "escape.txt"));
  const server = startServer({ output: workspace.output, port: 0, viewer });
  const request = (path: string, init?: RequestInit) =>
    fetch(new URL(path, server.url), init);
  try {
    const page = await request("/");
    expect(page.status).toBe(200);
    const assets = [...(await page.text()).matchAll(BUNDLED_ASSET)];
    expect(assets).toHaveLength(2);
    for (const [, asset] of assets) {
      if (!asset) {
        throw new Error("Missing bundled asset path.");
      }
      const response = await request(asset);
      expect(response.status).toBe(200);
      expect(await response.bytes()).toEqual(
        new Uint8Array(await readFile(join(viewer, asset)))
      );
    }
    expect(
      await (await request("/spyglass/two-masted-brig.glb")).bytes()
    ).toEqual(
      new Uint8Array(
        await readFile(join(viewer, "spyglass/two-masted-brig.glb"))
      )
    );
    expect(
      (await request("/spyglass.svg")).headers.get("content-type")
    ).toContain("image/svg+xml");
    expect((await request("/api/view")).status).toBe(404);
    const response = await request("/data/manifest.json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(manifest);
    expect(
      new Uint8Array(
        await (await request("/data/evidence/raw.bin")).arrayBuffer()
      )
    ).toEqual(evidence);
    expect((await request("/data/escape.txt")).status).toBe(404);
    expect((await request("/data/%2e%2e%2fcache/private.json")).status).toBe(
      404
    );
    expect((await request("/api/missing")).status).toBe(404);
    expect((await request("/cache/private.json")).status).toBe(404);
    expect((await request("/", { method: "POST" })).status).toBe(405);
    expect(await (await request("/", { method: "HEAD" })).text()).toBe("");
    await writeFile(join(workspace.output, "manifest.json"), "[1,2,3]\n");
    expect(await (await request("/data/manifest.json")).text()).toBe(
      "[1,2,3]\n"
    );
  } finally {
    server.stop(true);
  }
});

test("serve(root) serves the saved dataset and the viewer, frees its port on stop, and stops twice", async () => {
  const { directory, workspace } = await fixture();
  const state = join(directory, "state");
  await mkdir(workspace.output, { recursive: true });
  const manifest = '{ "schemaVersion": 5, "packages": [] }\n';
  await writeFile(join(workspace.output, "manifest.json"), manifest);
  const root = join(directory, "workspace");
  const server = await serve(root, { port: 0, state });
  const port = Number(server.url.port);
  try {
    expect(server.root).toBe(await realpath(root));
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<html");
    expect(
      await (await fetch(new URL("data/manifest.json", server.url))).text()
    ).toBe(manifest);
  } finally {
    await server.stop();
  }
  await server.stop();
  const again = await serve(root, { port, state });
  try {
    expect(Number(again.url.port)).toBe(port);
  } finally {
    await again.stop();
  }
});

test("serve(root) refuses an invalid port, and a workspace with no saved dataset or an outdated one", async () => {
  const { directory, workspace } = await fixture();
  const state = join(directory, "state");
  for (const port of [-1, 1.5, 65_536]) {
    await expect(serve(workspace.root, { port, state })).rejects.toThrow(
      "Port must be an integer between 0 and 65535."
    );
  }
  await expect(serve(workspace.root, { port: 0, state })).rejects.toThrow(
    `No dataset found for ${workspace.root} in ${workspace.output}. Run spyglass scan to save one.`
  );
  await mkdir(workspace.output, { recursive: true });
  await writeFile(
    join(workspace.output, "manifest.json"),
    '{ "schemaVersion": 3 }\n'
  );
  await expect(serve(workspace.root, { port: 0, state })).rejects.toThrow(
    "Spyglass reads dataset schema version 5; this dataset has version 3. Run spyglass scan to save it again."
  );
});

/** A hand-written schema 5 manifest that holds what the collection manifest reads. */
function collectionFixtureManifest(
  generatedAt: string,
  packages: {
    declaredDependencies?: Record<string, Record<string, string>>;
    id: string;
  }[]
): string {
  return JSON.stringify({
    discovery: { unitsSkipped: [] },
    generatedAt,
    packages: packages.map((entry) => ({
      declaredDependencies: {},
      modules: { count: 0 },
      path: entry.id,
      status: "complete",
      ...entry,
    })),
    schemaVersion: 5,
    workspace: { root: "fixture" },
  });
}

test("serve.collection derives the collection manifest per request and serves each dataset under its id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spyglass-test-"));
  directories.push(directory);
  const state = join(directory, "state");
  const roots = ["platform", "product"].map((name) => join(directory, name));
  const [platform, product] = await Promise.all(
    roots.map(async (root) => {
      await mkdir(root);
      return workspaceState(root, state);
    })
  );
  if (platform === undefined || product === undefined) {
    throw new Error("The collection should hold two workspaces.");
  }
  const platformManifest = collectionFixtureManifest(
    "2026-10-10T00:00:00.000Z",
    [{ id: "@k/db" }]
  );
  const write = async (workspace: WorkspaceState, text: string) => {
    await mkdir(workspace.output, { recursive: true });
    await writeFile(join(workspace.output, "manifest.json"), text);
  };
  await write(platform, platformManifest);
  // The second workspace has no dataset yet, and is named.
  await expect(serve.collection(roots, { port: 0, state })).rejects.toThrow(
    `No dataset found for ${product.root} in ${product.output}. Run spyglass scan to save one.`
  );
  await write(
    product,
    collectionFixtureManifest("2026-10-10T00:00:01.000Z", [
      {
        declaredDependencies: { dependencies: { "@k/db": "^1.0.0" } },
        id: "@p/app",
      },
    ])
  );
  // Given out of order, served in the collection's.
  const server = await serve.collection([...roots].reverse(), {
    port: 0,
    state,
  });
  const data = (path: string) => fetch(new URL(`data/${path}`, server.url));
  try {
    expect(server.roots).toEqual([platform.root, product.root]);
    expect((await fetch(server.url)).status).toBe(200);
    const served = await data("collection-manifest.json");
    expect(served.headers.get("Cache-Control")).toBe("no-store");
    expect(served.headers.get("Content-Type")).toStartWith("application/json");
    const manifest = await served.json();
    expect(manifest.crossings).toEqual([
      {
        from: `${product.id}:@p/app`,
        kind: "dependencies",
        range: "^1.0.0",
        to: `${platform.id}:@k/db`,
      },
    ]);
    expect(
      manifest.workspaces.map((entry: { dataset: string }) => entry.dataset)
    ).toEqual([`${platform.id}/`, `${product.id}/`]);
    expect(await (await data(`${platform.id}/manifest.json`)).text()).toBe(
      platformManifest
    );
    for (const missing of [
      "manifest.json",
      `${"0".repeat(12)}/manifest.json`,
      platform.id,
      `${platform.id}/absent.json`,
    ]) {
      expect((await data(missing)).status).toBe(404);
    }
    // A later scan of one workspace is seen at the next request.
    await write(
      product,
      collectionFixtureManifest("2026-10-11T00:00:00.000Z", [{ id: "@p/app" }])
    );
    const again = await (await data("collection-manifest.json")).json();
    expect(again.crossings).toEqual([]);
    expect(again.workspaces[1].generatedAt).toBe("2026-10-11T00:00:00.000Z");
    // HEAD answers as GET does, without the body.
    const head = await fetch(
      new URL("data/collection-manifest.json", server.url),
      {
        method: "HEAD",
      }
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toStartWith("application/json");
    expect(await head.text()).toBe("");
    // An encoded slash is decoded before the path is split, and no path
    // leaves the dataset it names, through `..` or a link.
    await symlink(
      join(platform.directory, "workspace.json"),
      join(platform.output, "record.json")
    );
    await writeFile(join(platform.directory, "workspace.json"), "{}");
    for (const outside of [
      `${platform.id}%2F..%2F${product.id}/manifest.json`,
      `${platform.id}/..%2Fworkspace.json`,
      `${platform.id}/..%2F..%2F${product.id}%2Foutput%2Fmanifest.json`,
      `${platform.id}/record.json`,
    ]) {
      expect((await data(outside)).status).toBe(404);
    }
    // A workspace whose dataset is gone, as mid-swap, makes the manifest
    // unavailable for now, naming it.
    await rm(join(product.output, "manifest.json"));
    const unavailable = await data("collection-manifest.json");
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("Retry-After")).toBe("1");
    expect(await unavailable.text()).toBe(
      `No dataset found for ${product.root} in ${product.output}. Run spyglass scan to save one.`
    );
    await write(product, '{ "schemaVersion": 3 }');
    expect(await (await data("collection-manifest.json")).text()).toBe(
      `Workspace ${product.root}: Spyglass reads dataset schema version 5; this dataset has version 3. Run spyglass scan to save it again.`
    );
  } finally {
    await server.stop();
  }
});

test("built CLI scans an external workspace and the web loaders read its saved dataset through the reader, over the real server", async () => {
  const { workspace, directory } = await fixture();
  const help = spawnCli(["--help"], workspace.root);
  expect(await help.exited).toBe(0);
  expect(await new Response(help.stdout).text()).toContain("spyglass scan");
  await cp(
    resolve(import.meta.dirname, "lib/fixtures/semantics"),
    workspace.root,
    { recursive: true }
  );
  // A domain across two packages; the analyses never read it.
  await mkdir(join(workspace.root, ".foundry/spyglass"), { recursive: true });
  await writeFile(
    join(workspace.root, ".foundry/spyglass/domains.ts"),
    'export default { domains: [{ facets: ["apps/a", "packages/b", "apps/a/src/old.ts"], name: "shapes" }] };\n'
  );
  const runScan = async () => {
    const child = spawnCli(
      ["scan", "--state", join(directory, "state")],
      workspace.root
    );
    const [code, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).toBe(`Dataset saved to ${workspace.output}\n`);
    // Progress is the CLI's formatting of the library's events.
    const lines = stderr.trimEnd().split("\n");
    expect(lines[0]).toBe("discover");
    expect(lines.slice(lines.indexOf("write"))).toEqual([
      "write",
      "internals: @s/a",
      "internals: @s/b",
      "internals: @s/c",
      "lenses",
      "visualization",
    ]);
    return JSON.parse(
      await readFile(join(workspace.output, "manifest.json"), "utf8")
    ) as DatasetManifest;
  };
  const first = await runScan();
  expect(first.schemaVersion).toBe(5);
  expect(first.generation.packageFailures).toBe(0);
  expect(first.generation.packagesAnalyzed).toBeGreaterThan(0);
  const second = await runScan();
  expect(second.generation.packagesAnalyzed).toBe(0);
  expect(second.generation.packagesReused).toBe(
    first.generation.packagesAnalyzed
  );
  const pkg = second.packages.find(
    (candidate) => candidate.status === "complete"
  );
  if (!pkg) {
    throw new Error("The fixture did not produce a complete package.");
  }
  const filename = `${pkg.id.replaceAll("/", "__")}.json`;
  expect(pkg.internals).toBe(`internals/${filename}`);
  const roles = JSON.parse(
    await readFile(join(workspace.output, "lenses/file-roles.json"), "utf8")
  ) as FileRoles;
  const plain = (module: string, fanIn = 0) => ({
    fanIn,
    highFanIn: false,
    module,
  });
  expect(roles).toEqual({
    missing: [],
    packages: [
      {
        // No source module of @s/a has a dependent, so the topology saved no cutoff.
        highFanInCutoff: 0,
        id: "@s/a",
        modules: [
          plain("apps/a/src/index.test.ts"),
          { ...plain("apps/a/src/index.ts"), role: "unknown" },
        ],
      },
      {
        highFanInCutoff: 3,
        id: "@s/b",
        modules: [
          plain("packages/b/src/index.ts"),
          { ...plain("packages/b/src/shape.ts", 1), role: "unknown" },
        ],
      },
      {
        highFanInCutoff: 3,
        id: "@s/c",
        modules: [
          { ...plain("tooling/c/src/index.ts"), role: "unknown" },
          plain("tooling/c/src/pad.ts", 1),
          { ...plain("tooling/c/src/unit.ts", 2), role: "mixed" },
        ],
      },
    ],
  });
  const groups = JSON.parse(
    await readFile(
      join(workspace.output, "lenses/responsibility-groups.json"),
      "utf8"
    )
  ) as ResponsibilityGroups;
  // @s/c's two responsibilities join, anchored on pad.ts; one import edge
  // and one symbol each way between them give 4 · log1p(1).
  const pad = "responsibility:6912c01d6d10";
  const unit = "responsibility:91296e76ff97";
  const [weight] = groups.packages.flatMap((saved) =>
    saved.groups.map((group) => group.anchorWeight)
  );
  if (weight === undefined) {
    throw new Error("The fixture formed no responsibility group.");
  }
  expect(weight).toBeCloseTo(4 * Math.log1p(1));
  expect(groups).toEqual({
    missing: [],
    packages: [
      { groups: [], id: "@s/a", independent: ["responsibility:a2a171449d86"] },
      { groups: [], id: "@s/b", independent: ["responsibility:8fdd26292eea"] },
      {
        groups: [
          {
            anchor: pad,
            anchorModule: "tooling/c/src/pad.ts",
            anchorWeight: weight,
            // SHA-256 of the two ids, one per line, first 12 hex digits.
            id: "responsibility-group:154ae5bf7ebf",
            label: "src/pad.ts",
            // Both responsibilities' modules, each once, sorted.
            modules: [
              "tooling/c/src/index.ts",
              "tooling/c/src/pad.ts",
              "tooling/c/src/unit.ts",
            ],
            responsibilities: [pad, unit],
          },
        ],
        id: "@s/c",
        independent: [],
      },
    ],
  });
  const placements = JSON.parse(
    await readFile(join(workspace.output, "lenses/placement.json"), "utf8")
  ) as Placements;
  // @s/b's symbols are used only in other packages: each departs toward its
  // one consuming source file, or is spread over two. @s/a's test file is
  // no consumer, so perimeter departs toward @s/c alone.
  const away = (pkgId: string, modules: string[]) => ({
    modules,
    package: pkgId,
  });
  const twoWays = [
    away("@s/a", ["apps/a/src/index.ts"]),
    away("@s/c", ["tooling/c/src/index.ts"]),
  ];
  type Row = Placements["places"][number];
  const fromB = (
    level: Row["level"],
    place: string,
    rest: Pick<Row, "away"> &
      ({ label: "spread" } | { label: "departs"; toward: string })
  ): Row => ({
    home: { modules: [] },
    level,
    package: "@s/b",
    place,
    unindexed: 0,
    ...rest,
  });
  expect(placements.missing).toEqual([]);
  expect(placements.places).toEqual([
    fromB("package", "packages/b", { away: twoWays, label: "spread" }),
    fromB("file", "packages/b/src/shape.ts", {
      away: twoWays,
      label: "spread",
    }),
    fromB("symbol", "packages/b/src/shape.ts#Shape", {
      away: twoWays,
      label: "spread",
    }),
    fromB("symbol", "packages/b/src/shape.ts#area", {
      away: [away("@s/a", ["apps/a/src/index.ts"])],
      label: "departs",
      toward: "@s/a",
    }),
    fromB("symbol", "packages/b/src/shape.ts#perimeter", {
      away: [away("@s/c", ["tooling/c/src/index.ts"])],
      label: "departs",
      toward: "@s/c",
    }),
  ]);
  // apps/a shares the shapes domain with packages/b and tooling/c does not:
  // area, used only from apps/a, shares a domain; perimeter, used only from
  // tooling/c, is a domain departure; a place used from both stays spread.
  const domains = JSON.parse(
    await readFile(join(workspace.output, "lenses/domains.json"), "utf8")
  ) as Domains;
  expect(domains.domains).toEqual([
    {
      name: "shapes",
      parents: [],
      places: [
        { kind: "package", place: "apps/a" },
        { kind: "package", place: "packages/b" },
      ],
      unmatched: ["apps/a/src/old.ts"],
    },
  ]);
  expect(
    domains.placements.map((placement) => [
      placement.place,
      placement.placementLabel,
      placement.domainLabel,
      placement.away,
    ])
  ).toEqual([
    ["packages/b", "spread", "spread", { shared: 1, total: 2, unindexed: 0 }],
    [
      "packages/b/src/shape.ts",
      "spread",
      "spread",
      { shared: 1, total: 2, unindexed: 0 },
    ],
    [
      "packages/b/src/shape.ts#Shape",
      "spread",
      "spread",
      { shared: 1, total: 2, unindexed: 0 },
    ],
    [
      "packages/b/src/shape.ts#area",
      "departs",
      "shares-domain",
      { shared: 1, total: 1, unindexed: 0 },
    ],
    [
      "packages/b/src/shape.ts#perimeter",
      "departs",
      "departs",
      { shared: 0, total: 1, unindexed: 0 },
    ],
  ]);
  const none = { departs: 0, fits: 0, spread: 0, unconsumed: 0 };
  expect(
    Object.fromEntries(
      placements.packages.map((saved) => [saved.id, saved.counts])
    )
  ).toEqual({
    // `src` is each package's technical root, so none has a folder place.
    "@s/a": {
      file: { ...none, unconsumed: 1 },
      folder: none,
      package: { ...none, unconsumed: 1 },
      symbol: { ...none, unconsumed: 2 },
    },
    "@s/b": {
      file: { ...none, spread: 1, unconsumed: 1 },
      folder: none,
      package: { ...none, spread: 1 },
      symbol: { ...none, departs: 2, spread: 1 },
    },
    // Used only at home: pad.ts, unit.ts, and their symbols fit.
    "@s/c": {
      file: { ...none, fits: 2, unconsumed: 1 },
      folder: none,
      package: { ...none, unconsumed: 1 },
      symbol: { ...none, fits: 3, unconsumed: 1 },
    },
  });
  const nesting = JSON.parse(
    await readFile(join(workspace.output, "lenses/nesting.json"), "utf8")
  ) as Nesting;
  // Each package of the fixture is one path region, `.`, with `src` a
  // technical root; no region imports another, so there are no seams.
  expect(nesting.missing).toEqual([]);
  expect(nesting.seams).toEqual([]);
  expect(nesting.pathRegions).toEqual([
    { files: 2, id: ".", package: "@s/a", primaryFiles: 1 },
    { files: 2, id: ".", package: "@s/b", primaryFiles: 2 },
    { files: 3, id: ".", package: "@s/c", primaryFiles: 3 },
  ]);
  // Nesting's tree comes from the module index, placement's folders from
  // each topology's directories: every directory is a folder of the tree
  // under the same id, in the same path region. The index may hold more,
  // such as a folder of JSON files only, which then has no path region.
  for (const saved of second.packages) {
    const { topology } = JSON.parse(
      await readFile(join(workspace.output, saved.internals ?? ""), "utf8")
    ) as PackageInternals;
    const folders = new Map(
      nesting.folders
        .filter((folder) => folder.package === saved.id)
        .map((folder) => [folder.id, folder.pathRegion])
    );
    for (const topologyDirectory of topology.directories) {
      const id = rootRelativeFolder(
        topology.package.root,
        topologyDirectory.id
      );
      expect([id, folders.get(id)]).toEqual([id, topologyDirectory.region]);
    }
    // The fixture holds TypeScript files only, so here the two agree exactly.
    expect(folders.size).toBe(topology.directories.length);
  }
  expect(nesting.folders.map((folder) => folder.id)).toEqual([
    "apps",
    "apps/a",
    "apps/a/src",
    "packages",
    "packages/b",
    "packages/b/src",
    "tooling",
    "tooling/c",
    "tooling/c/src",
  ]);
  // @s/c's two responsibilities share tooling/c/src and import each other,
  // so they are one group: nothing sits close unrelated. Every file is in
  // its responsibility's folder, and the fixture has no Git history.
  expect(
    JSON.parse(
      await readFile(join(workspace.output, "lenses/proximity.json"), "utf8")
    ) as Proximity
  ).toEqual({
    apart: { coChanges: [], files: [] },
    close: [],
    missing: [],
    packages: [
      { id: "@s/a", unresolved: 0 },
      { id: "@s/b", unresolved: 0 },
      { id: "@s/c", unresolved: 0 },
    ],
  });
  const { dependencies } = JSON.parse(
    await readFile(join(workspace.root, pkg.path, "package.json"), "utf8")
  ) as { dependencies?: Record<string, string> };
  expect(pkg.declaredDependencies).toEqual(
    dependencies === undefined ? {} : { dependencies }
  );
  await expect(
    readFile(join(workspace.output, "manifests", filename))
  ).rejects.toThrow("ENOENT");
  // The viewer's loaders read through the same reader as the library, here
  // over fetch from the real server. Rendering uses the saved output even
  // after the source workspace is removed.
  await rm(workspace.root, { recursive: true });
  const server = startServer({ output: workspace.output, port: 0 });
  const nativeFetch = globalThis.fetch;
  const fetchFromServer: typeof fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      nativeFetch(
        typeof input === "string" ? new URL(input, server.url) : input,
        init
      ),
    { preconnect: nativeFetch.preconnect }
  );
  globalThis.fetch = fetchFromServer;
  try {
    performance.clearMarks();
    const spyglass = await loadSpyglass();
    // The load marks its three points, in order, for the capture script.
    expect(
      performance.getEntriesByType("mark").map((entry) => entry.name)
    ).toEqual([
      "spyglass:data-requested",
      "spyglass:data-loaded",
      "spyglass:layout-settled",
    ]);
    const territory = spyglass.territories.find((item) => item.id === pkg.id);
    if (!territory) {
      throw new Error(`The map has no island for ${pkg.id}.`);
    }
    // The map keeps the lens's entry from load and binds it on entering the island.
    const { fileRoles } = territory;
    expect(fileRoles?.modules).toEqual(
      roles.packages.find((saved) => saved.id === pkg.id)?.modules
    );
    // The layout keeps each island's folder cells for drawing its folders.
    expect(Object.keys(spyglass.folderCells).sort()).toEqual(
      spyglass.territories.map((item) => item.id).sort()
    );
    expect(spyglass.folderCells[pkg.id]?.sites).toHaveLength(
      territory.files.length
    );
    // The nesting and proximity lenses come after the layout, pinned to its
    // dataset, and mark their arrival.
    // A single workspace is one frame, at the data root, pinned to its manifest.
    const [frame] = spyglass.frames;
    expect(spyglass.frames).toHaveLength(1);
    expect(frame?.dataset).toEqual({
      generatedAt: second.generatedAt,
      root: "",
    });
    expect(frame?.territories).toEqual(
      spyglass.territories.map((item) => item.id)
    );
    expect(frame?.readings.nesting.folders).toEqual([]);
    expect(frame?.readings.proximity.labelled).toEqual([]);
    const late = (await loadLateReadings(spyglass))[frame?.id ?? ""];
    expect(late?.nesting.folders.length).toBeGreaterThan(0);
    expect(late?.proximity.labelled).toContain(pkg.id);
    expect(
      performance.getEntriesByName("spyglass:readings-loaded")
    ).toHaveLength(1);
    // No edge shard is read at load: each file's counts come from the module
    // index, and the edges themselves from a trace.
    expect(spyglass.fileEdges).toEqual([]);
    const edges = await loadImports(spyglass);
    const files = spyglass.territories.flatMap((item) => item.files);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges).toHaveLength(
      files.reduce((sum, file) => sum + file.outgoing, 0)
    );
    for (const file of files) {
      expect(edges.filter((edge) => edge.target === file.id)).toHaveLength(
        file.incoming
      );
    }
    const grouped = groups.packages.find((entry) => entry.id === pkg.id);
    expect(territory.responsibilityGroups).toEqual(
      grouped && { groups: grouped.groups, independent: grouped.independent }
    );
    const { signal } = new AbortController();
    const request = {
      dataset: { generatedAt: second.generatedAt, root: "" },
      files: territory.files,
      package: pkg.id,
      roles: fileRoles,
      signal,
    };
    const evidence = await loadInternals(request);
    expect(evidence.architecture?.review).toBeDefined();
    // Roles reach the island from the lens, by file id, which is the module id here.
    expect(evidence.fileRoles).toEqual(
      Object.fromEntries(
        (
          roles.packages.find((saved) => saved.id === pkg.id)?.modules ?? []
        ).flatMap((module) =>
          module.role ? [[module.module, module.role]] : []
        )
      )
    );
    await expect(
      loadInternals({
        ...request,
        dataset: { generatedAt: "2000-01-01T00:00:00.000Z", root: "" },
      })
    ).rejects.toThrow("A later scan replaced this dataset. Reload to see it.");
    await rm(join(workspace.output, "internals", filename));
    await expect(loadInternals(request)).rejects.toThrow(
      `The dataset is missing internals/${filename}. Run spyglass scan again.`
    );
    await rm(join(workspace.output, "manifest.json"));
    await expect(loadSpyglass()).rejects.toThrow(
      "No dataset found. Run spyglass scan to save one."
    );
  } finally {
    globalThis.fetch = nativeFetch;
    server.stop(true);
  }
}, 60_000);

/** Runs the built CLI to completion. */
async function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env
) {
  const child = spawnCli(args, cwd, env);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stderr, stdout };
}

/** Starts the built CLI, hands its first line of stdout to `use`, then stops it. */
async function withFirstLine(
  args: string[],
  cwd: string,
  use: (line: string) => Promise<void>
): Promise<void> {
  const child = spawnCli(args, cwd);
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(await new Response(child.stderr).text());
      }
      text += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
    await use(text.slice(0, text.indexOf("\n")));
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
}

describe("built CLI commands", () => {
  let directory: string;
  let workspace: WorkspaceState;
  let state: string;
  let root: string;
  const readJson = async (file: string) =>
    JSON.parse(await readFile(file, "utf8")) as unknown;
  const savedManifest = () => readJson(join(workspace.output, "manifest.json"));

  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "spyglass-cli-")));
    root = join(directory, "workspace");
    await cp(resolve(import.meta.dirname, "lib/fixtures/semantics"), root, {
      recursive: true,
    });
    state = join(directory, "state");
    workspace = await workspaceState(root, state);
    await scan(root, { state });
  }, 60_000);

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  test("report, lens, check, and export fail on a workspace never scanned", async () => {
    const other = join(directory, "never-scanned");
    await mkdir(other);
    const fresh = await workspaceState(other, state);
    const missing = `Spyglass: No dataset found for ${fresh.root} in ${fresh.output}. Run spyglass scan to save one.\n`;
    for (const args of [
      ["report", "@s/a"],
      ["lens", "package-sizes"],
      ["check"],
      ["export", join(directory, "never-site")],
    ]) {
      expect(await runCli([...args, "--state", state], other)).toEqual({
        code: 1,
        stderr: missing,
        stdout: "",
      });
    }
  });

  test("scan --json prints the library's result on one line, and --quiet silences only progress", async () => {
    const quiet = await runCli(
      ["scan", "--state", state, "--json", "--quiet"],
      root
    );
    expect(quiet.code, quiet.stderr).toBe(0);
    expect(quiet.stderr).toBe("");
    expect(quiet.stdout.endsWith("\n")).toBe(true);
    expect(quiet.stdout.trimEnd().split("\n")).toHaveLength(1);
    const result = JSON.parse(quiet.stdout) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["manifest", "output"]);
    expect(result.output).toBe(workspace.output);
    expect(result.manifest).toEqual(await savedManifest());
    const progress = await runCli(["scan", "--state", state, "--json"], root);
    expect(progress.stderr.split("\n")[0]).toBe("discover");
  }, 60_000);

  test("report renders each format, colours only for the terminal, and prints the saved report with --json", async () => {
    const report = (flags: string[], env: Record<string, string> = {}) =>
      runCli(["report", "@s/a", "--state", state, ...flags], root, {
        ...process.env,
        NO_COLOR: undefined,
        ...env,
      });
    const markdown = await report(["--format", "markdown"]);
    expect(markdown.code, markdown.stderr).toBe(0);
    expect(markdown.stdout.split("\n")[0]).toBe("# SEMANTIC SURFACE");
    expect(markdown.stdout).toContain("| Target | @s/a |");
    // Piped, the default is text, without colour.
    const text = await report([]);
    expect(text.stdout).toContain("Target  @s/a");
    expect(text.stdout).not.toContain("\u001b[");
    expect((await report(["--format", "terminal"])).stdout).toContain(
      "\u001b["
    );
    const uncoloured = await report(["--format", "terminal"], {
      NO_COLOR: "1",
    });
    expect(uncoloured.stdout).toContain("Target  @s/a");
    expect(uncoloured.stdout).not.toContain("\u001b[");
    expect(JSON.parse((await report(["--json"])).stdout)).toEqual(
      await readJson(join(workspace.output, "packages/@s__a.json"))
    );
    expect(await runCli(["report", "@s/x", "--state", state], root)).toEqual({
      code: 1,
      stderr:
        "Spyglass: The dataset has no package named @s/x. Its packages: @s/a, @s/b, @s/c.\n",
      stdout: "",
    });
  });

  test("lens renders a saved lens in each format and prints it as saved with --json", async () => {
    const lens = (args: string[]) =>
      runCli(["lens", ...args, "--state", state], root, {
        ...process.env,
        NO_COLOR: undefined,
      });
    const text = await lens(["package-sizes"]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout.split("\n")[0]).toBe("Package sizes");
    expect(text.stdout).toContain("Packages  3 (3 analyzed)");
    expect(text.stdout).not.toContain("\u001b[");
    const markdown = await lens(["package-sizes", "--format", "markdown"]);
    expect(markdown.stdout.split("\n")[0]).toBe("# Package sizes");
    // The fixture declares no domains.
    expect((await lens(["domains"])).stdout).toBe(
      "Domains\n═══════\nNo domains declared.\n"
    );
    const json = await lens(["placement", "--json"]);
    expect(json.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(json.stdout)).toEqual(
      await readJson(join(workspace.output, "lenses/placement.json"))
    );
    expect(await lens(["places"])).toEqual({
      code: 2,
      stderr:
        "Spyglass: spyglass lens takes domains, file-roles, frequent-change, import-traffic, nesting, package-sizes, placement, proximity, responsibility-groups, or rules.\nRun spyglass --help for usage.\n",
      stdout: "",
    });
  });

  test("lens fails on a dataset saved before the lens existed", async () => {
    const file = join(workspace.output, "manifest.json");
    const saved = await readFile(file, "utf8");
    const { lenses, ...manifest } = JSON.parse(saved) as DatasetManifest;
    const { domains: _domains, ...others } = lenses;
    try {
      await writeFile(file, JSON.stringify({ ...manifest, lenses: others }));
      expect(await runCli(["lens", "domains", "--state", state], root)).toEqual(
        {
          code: 1,
          stderr:
            "Spyglass: The dataset has no domains lens. Run spyglass scan again.\n",
          stdout: "",
        }
      );
    } finally {
      await writeFile(file, saved);
    }
  });

  test("export writes a static viewer, prints the library's result with --json, and refuses the workspace", async () => {
    const site = join(directory, "site");
    expect(await runCli(["export", site, "--state", state], root)).toEqual({
      code: 0,
      stderr: "",
      stdout: `Static viewer saved to ${site}\n`,
    });
    expect(await readFile(join(site, "data/manifest.json"), "utf8")).toBe(
      await readFile(join(workspace.output, "manifest.json"), "utf8")
    );
    const exported = await runCli(
      ["export", site, "--state", state, "--json"],
      root
    );
    expect(JSON.parse(exported.stdout)).toEqual({
      directory: site,
      manifest: await savedManifest(),
    });
    expect(await runCli(["export", root, "--state", state], root)).toEqual({
      code: 1,
      stderr: `Spyglass: ${root} holds the workspace ${root}. Choose another directory.\n`,
      stdout: "",
    });
  });

  test("a usage error exits 2 with a pointer to the help", async () => {
    expect(await runCli(["report", "@s/a", "one", "two"], root)).toEqual({
      code: 2,
      stderr:
        "Spyglass: spyglass report reads one workspace's dataset; give one path.\nRun spyglass --help for usage.\n",
      stdout: "",
    });
    expect(await runCli(["serve", "--history"], root)).toEqual({
      code: 2,
      stderr:
        "Spyglass: spyglass serve does not take --history.\nRun spyglass --help for usage.\n",
      stdout: "",
    });
  });

  test("serve --json prints the server's root and url once it listens", async () => {
    await withFirstLine(
      ["serve", "--state", state, "--port", "0", "--no-open", "--json"],
      root,
      async (line) => {
        const served = JSON.parse(line) as Record<string, unknown>;
        expect(Object.keys(served).sort()).toEqual(["root", "url"]);
        expect(served.root).toBe(root);
        expect((await fetch(String(served.url))).status).toBe(200);
      }
    );
  });

  test("the default command prints one line with --json: the scan's result and the server's", async () => {
    await withFirstLine(
      ["--state", state, "--port", "0", "--no-open", "--json", "--quiet"],
      root,
      async (line) => {
        const opened = JSON.parse(line) as Record<string, unknown>;
        expect(Object.keys(opened).sort()).toEqual([
          "manifest",
          "output",
          "root",
          "url",
        ]);
        expect(opened.output).toBe(workspace.output);
        expect((await fetch(String(opened.url))).status).toBe(200);
      }
    );
  }, 60_000);
});

describe("built CLI collections", () => {
  let directory: string;
  let platform: WorkspaceState;
  let product: WorkspaceState;
  let state: string;
  let roots: [string, string];

  beforeAll(async () => {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), "spyglass-collection-cli-"))
    );
    state = join(directory, "state");
    roots = ["platform", "product"].map((name) => join(directory, name)) as [
      string,
      string,
    ];
    for (const [index, name] of ["platform", "product"].entries()) {
      await cp(
        resolve(import.meta.dirname, "lib/fixtures/collection", name),
        roots[index] as string,
        { recursive: true }
      );
    }
    platform = await workspaceState(roots[0], state);
    product = await workspaceState(roots[1], state);
  });

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  test("scan reads two paths as a collection, in the collection's order, and prints its result", async () => {
    // Given out of order: the collection scans by resolved root.
    const text = await runCli(
      ["scan", roots[1], roots[0], "--state", state],
      directory
    );
    expect(text.code).toBe(0);
    expect(text.stdout).toBe(
      `Dataset saved to ${platform.output}\nDataset saved to ${product.output}\nCollection: 2 workspaces, 2 crossings\n`
    );
    const headers = text.stderr
      .split("\n")
      .filter((line) => line.startsWith("workspace: "));
    expect(headers).toEqual([
      `workspace: ${platform.root}`,
      `workspace: ${product.root}`,
    ]);
    const json = await runCli(
      ["scan", ...roots, "--state", state, "--json", "--quiet"],
      directory
    );
    expect(json.code).toBe(0);
    expect(json.stderr).toBe("");
    const result = JSON.parse(json.stdout) as {
      manifest: { crossings: { from: string; to: string }[] };
      workspaces: { manifest: unknown; output: string }[];
    };
    expect(Object.keys(result)).toEqual(["manifest", "workspaces"]);
    expect(result.workspaces.map((saved) => saved.output)).toEqual([
      platform.output,
      product.output,
    ]);
    expect(result.manifest.crossings.map(({ from, to }) => [from, to])).toEqual(
      [
        [`${product.id}:@p/app`, `${platform.id}:@k/db`],
        [`${product.id}:@p/web`, `${platform.id}:@k/db`],
      ]
    );
  }, 120_000);

  test("the viewer loads a served collection: one frame per workspace, qualified, its readings and imports each from its own dataset", async () => {
    const server = await serve.collection(roots, { port: 0, state });
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        nativeFetch(
          typeof input === "string" ? new URL(input, server.url) : input,
          init
        ),
      { preconnect: nativeFetch.preconnect }
    );
    try {
      // No manifest.json at the data root: the collection manifest is read.
      const spyglass = await loadSpyglass();
      expect(spyglass.frames.map((frame) => frame.id)).toEqual([
        platform.id,
        product.id,
      ]);
      expect(spyglass.frames.map((frame) => frame.dataset.root)).toEqual([
        `${platform.id}/`,
        `${product.id}/`,
      ]);
      const ids = spyglass.territories.map((territory) => territory.id);
      expect(new Set(ids).size).toBe(ids.length);
      // @k/shared is two packages, one in each workspace.
      expect(ids).toContain(`${platform.id}:@k/shared`);
      expect(ids).toContain(`${product.id}:@k/shared`);
      expect(
        spyglass.frames.flatMap((frame) => frame.territories).sort()
      ).toEqual([...ids].sort());
      // The crossings resolve to islands of the two frames.
      expect(spyglass.crossings?.map(({ from, to }) => [from, to])).toEqual([
        [`${product.id}:@p/app`, `${platform.id}:@k/db`],
        [`${product.id}:@p/web`, `${platform.id}:@k/db`],
      ]);
      for (const crossing of spyglass.crossings ?? []) {
        expect(ids).toContain(crossing.from);
        expect(ids).toContain(crossing.to);
      }
      // One line for each pair, never a route.
      expect(crossingPairs(spyglass).map(({ from, to }) => [from, to])).toEqual(
        [
          [`${product.id}:@p/app`, `${platform.id}:@k/db`],
          [`${product.id}:@p/web`, `${platform.id}:@k/db`],
        ]
      );
      expect(
        spyglass.routes.some((route) =>
          crossingPairs(spyglass).some(
            (pair) => pair.from === route.from && pair.to === route.to
          )
        )
      ).toBe(false);
      // Side by side, one rim each with open water between them, and both
      // each workspace retaining its own two-dimensional geography.
      const [west = [], east = []] = archipelagoRims(spyglass);
      expect(
        Math.min(...east.map(([x]) => x)) - Math.max(...west.map(([x]) => x))
      ).toBeCloseTo(frameSea, 6);
      const collectionFetch = globalThis.fetch;
      for (const frame of spyglass.frames) {
        globalThis.fetch = Object.assign(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
            nativeFetch(
              typeof input === "string"
                ? new URL(
                    input.replace("./data/", `./data/${frame.id}/`),
                    server.url
                  )
                : input,
              init
            ),
          { preconnect: nativeFetch.preconnect }
        );
        const standalone = await loadSpyglass();
        globalThis.fetch = collectionFetch;
        const offsets = standalone.territories.map((island) => {
          const placed = spyglass.territories.find(
            (territory) => territory.id === `${frame.id}:${island.id}`
          );
          expect(placed).toBeDefined();
          return {
            x: (placed?.x ?? 0) - island.x,
            y: (placed?.y ?? 0) - island.y,
          };
        });
        const [first] = offsets;
        expect(first).toBeDefined();
        for (const offset of offsets) {
          expect(offset.x).toBeCloseTo(first?.x ?? 0, 6);
          expect(offset.y).toBeCloseTo(first?.y ?? 0, 6);
        }
      }
      const files = new Set(
        spyglass.territories.flatMap((territory) =>
          territory.files.map((file) => file.id)
        )
      );
      for (const route of spyglass.routes) {
        expect(ids).toContain(route.from);
        expect(ids).toContain(route.to);
        for (const file of [...route.consumerFiles, ...route.supplierFiles]) {
          expect(files.has(file)).toBe(true);
        }
      }
      // Each frame's late readings and imports come from its own dataset.
      const late = await loadLateReadings(spyglass);
      expect(Object.keys(late).sort()).toEqual(
        [platform.id, product.id].sort()
      );
      const edges = await loadImports(spyglass);
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(files.has(edge.source)).toBe(true);
        expect(files.has(edge.target)).toBe(true);
      }
    } finally {
      globalThis.fetch = nativeFetch;
      await server.stop();
    }
  });

  test("paths that name one workspace twice exit 2 and name the duplicate", async () => {
    await symlink(roots[0], join(directory, "link"));
    for (const [args, duplicate] of [
      [["scan", roots[0], `${roots[0]}/`], `${roots[0]}/`],
      [["serve", roots[0], roots[1], "link"], "link"],
      [["export", join(directory, "site"), roots[0], roots[0]], roots[0]],
      [[roots[1], roots[1]], roots[1]],
    ] as const) {
      const result = await runCli([...args, "--state", state], directory);
      expect(result.code).toBe(2);
      expect(result.stderr).toStartWith(
        `Spyglass: ${duplicate} names the same workspace as `
      );
      expect(result.stderr).toContain("give each workspace once.");
      expect(result.stdout).toBe("");
    }
    // A workspace inside another is a usage error too.
    const nested = join(roots[1], "apps");
    const overlapping = await runCli(
      ["scan", nested, roots[1], "--state", state],
      directory
    );
    expect(overlapping).toEqual({
      code: 2,
      stderr: `Spyglass: Workspace ${product.root} holds workspace ${nested}; the workspaces of a collection cannot overlap.\nRun spyglass --help for usage.\n`,
      stdout: "",
    });
  });

  test("the commands that read one workspace's dataset refuse a second path with exit 2", async () => {
    for (const [args, command] of [
      [["report", "@k/db"], "report"],
      [["lens", "package-sizes"], "lens"],
      [["check"], "check"],
    ] as const) {
      const result = await runCli([...args, ...roots], directory);
      expect(result.code).toBe(2);
      expect(result.stderr).toBe(
        `Spyglass: spyglass ${command} reads one workspace's dataset; give one path.\nRun spyglass --help for usage.\n`
      );
    }
  });

  test("serve --json prints the roots and url, and serves the collection manifest and each dataset", async () => {
    await withFirstLine(
      [
        "serve",
        ...roots,
        "--state",
        state,
        "--port",
        "0",
        "--no-open",
        "--json",
      ],
      directory,
      async (line) => {
        const served = JSON.parse(line) as { roots: string[]; url: string };
        expect(Object.keys(served).sort()).toEqual(["roots", "url"]);
        expect(served.roots).toEqual([platform.root, product.root]);
        const data = (path: string) =>
          fetch(new URL(`data/${path}`, served.url));
        const manifest = (await (
          await data("collection-manifest.json")
        ).json()) as {
          workspaces: { dataset: string }[];
        };
        expect(manifest.workspaces.map((entry) => entry.dataset)).toEqual([
          `${platform.id}/`,
          `${product.id}/`,
        ]);
        expect(await (await data(`${product.id}/manifest.json`)).text()).toBe(
          await readFile(join(product.output, "manifest.json"), "utf8")
        );
      }
    );
    const text = spawnCli(
      ["serve", ...roots, "--state", state, "--port", "0", "--no-open"],
      directory
    );
    try {
      const reader = text.stdout.getReader();
      let printed = "";
      while (printed.split("\n").length < 4) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        printed += new TextDecoder().decode(value);
      }
      expect(printed).toMatch(
        new RegExp(
          `^Spyglass: http://127\\.0\\.0\\.1:\\d+/\\nWorkspace: ${platform.root}\\nWorkspace: ${product.root}\\n$`
        )
      );
    } finally {
      text.kill("SIGTERM");
      await text.exited;
    }
  });

  test("the default command scans, serves, and prints one line with --json", async () => {
    await withFirstLine(
      [
        ...roots,
        "--state",
        state,
        "--port",
        "0",
        "--no-open",
        "--json",
        "--quiet",
      ],
      directory,
      async (line) => {
        const result = JSON.parse(line) as Record<string, unknown>;
        expect(Object.keys(result).sort()).toEqual([
          "manifest",
          "roots",
          "url",
          "workspaces",
        ]);
        const response = await fetch(
          new URL("data/collection-manifest.json", String(result.url))
        );
        expect(await response.json()).toEqual(result.manifest);
      }
    );
  }, 120_000);

  test("export writes the collection beside each dataset, prints its result, and refuses a place that holds a workspace", async () => {
    const site = join(directory, "site");
    const result = await runCli(
      ["export", site, ...roots, "--state", state, "--json"],
      directory
    );
    expect(result.code).toBe(0);
    const written = JSON.parse(result.stdout) as {
      directory: string;
      manifest: unknown;
      workspaces: { dataset: string; id: string; root: string }[];
    };
    expect(Object.keys(written)).toEqual([
      "directory",
      "manifest",
      "workspaces",
    ]);
    expect(written.workspaces).toEqual([
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
    expect(written.directory).toBe(site);
    expect(
      JSON.parse(
        await readFile(join(site, "data/collection-manifest.json"), "utf8")
      )
    ).toEqual(written.manifest);
    for (const workspace of [platform, product]) {
      expect(
        await readFile(
          join(site, "data", workspace.id, "manifest.json"),
          "utf8"
        )
      ).toBe(await readFile(join(workspace.output, "manifest.json"), "utf8"));
    }
    expect(existsSync(join(site, "data/manifest.json"))).toBe(false);
    expect(existsSync(join(site, "index.html"))).toBe(true);
    // A second export replaces the first.
    const again = await runCli(
      ["export", site, ...roots, "--state", state],
      directory
    );
    expect(again.code).toBe(0);
    expect(again.stdout).toBe(`Static viewer saved to ${site}\n`);
    // A directory that holds the workspaces is refused, naming the first.
    const holding = await runCli(
      ["export", directory, ...roots, "--state", state],
      directory
    );
    expect(holding.code).toBe(1);
    expect(holding.stderr).toBe(
      `Spyglass: ${directory} holds the workspace ${platform.root}. Choose another directory.\n`
    );
  });
});

describe("built CLI check", () => {
  let directory: string;
  let root: string;
  let state: string;
  const RULES = ".foundry/spyglass/rules.ts";
  const declare = async (rules: unknown[]) => {
    await mkdir(join(root, ".foundry/spyglass"), { recursive: true });
    await writeFile(
      join(root, RULES),
      `export default { rules: ${JSON.stringify(rules)} };\n`
    );
    await scan(root, { state });
  };
  const check = (flags: string[] = []) =>
    runCli(["check", "--state", state, ...flags], root);
  const requiring = (subject: string): Rule => ({
    effect: "require",
    operator: "internalize",
    subject,
  });

  beforeAll(async () => {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), "spyglass-check-"))
    );
    root = join(directory, "workspace");
    await cp(resolve(import.meta.dirname, "lib/fixtures/semantics"), root, {
      recursive: true,
    });
    state = join(directory, "state");
  });

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  test("exits 0 with a note when no rule is declared", async () => {
    await scan(root, { state });
    expect(await check()).toEqual({
      code: 0,
      stderr: "",
      stdout:
        "Rules\n═════\nNo rules declared. Declare them under rules in .foundry/spyglass/.\n",
    });
  }, 60_000);

  test("exits 3 on a violation, with its plan, and prints the result on one line with --json", async () => {
    await declare([requiring("tooling/c")]);
    const text = await check();
    expect(text.code, text.stderr).toBe(3);
    expect(text.stdout).toContain(
      "Breaks rules[0] require internalize tooling/c"
    );
    expect(text.stdout).toContain(
      "tooling/c/src/index.ts#fence · @s/c · plan ready"
    );
    const json = await check(["--json"]);
    expect(json.code).toBe(3);
    expect(json.stdout.trimEnd().split("\n")).toHaveLength(1);
    const result = JSON.parse(json.stdout) as CheckResult;
    expect(result.outcome).toBe("violations");
    expect(result.lens).toEqual({
      missing: [],
      rules: [requiring("tooling/c")],
      unmatched: [],
      violations: [
        {
          opportunity: "internalize-symbol:tooling/c/src/index.ts#fence",
          package: "@s/c",
          place: "tooling/c/src/index.ts#fence",
          plan: {
            blockers: [],
            id: "plan:internalize-symbol:tooling/c/src/index.ts#fence",
            status: "ready",
          },
          rule: 0,
        },
      ],
    });
    // Rules read back from the lens hash as the configuration's do, so an
    // authorization made from either matches the other.
    expect(ruleFingerprint(result.lens.rules)).toBe(
      ruleFingerprint((await loadConfiguration(root)).rules)
    );
    // The same lens `spyglass lens rules` prints.
    const lens = await runCli(
      ["lens", "rules", "--json", "--state", state],
      root
    );
    expect(JSON.parse(lens.stdout)).toEqual(result.lens);
  }, 60_000);

  test("exits 1 when a require could not be checked, over any violation, and on a dataset saved before the lens", async () => {
    await declare([requiring("tooling/c")]);
    const workspace = await workspaceState(root, state);
    const file = join(workspace.output, "lenses/rules.json");
    const saved = await readFile(file, "utf8");
    const manifestFile = join(workspace.output, "manifest.json");
    const manifest = await readFile(manifestFile, "utf8");
    try {
      const lens = JSON.parse(saved) as Record<string, unknown>;
      await writeFile(
        file,
        JSON.stringify({ ...lens, missing: [{ package: "@s/c", rule: 0 }] })
      );
      const incomplete = await check(["--json"]);
      expect(incomplete.code).toBe(1);
      expect(JSON.parse(incomplete.stdout).outcome).toBe("incomplete");
      expect(incomplete.stderr).toBe(
        "Spyglass: rules[0] meets @s/c, which failed analysis, so it could not be checked there. Fix the package or narrow the rule's subject, then scan again.\n"
      );
      const { lenses, ...rest } = JSON.parse(manifest) as DatasetManifest;
      const { rules: _rules, ...others } = lenses;
      await writeFile(
        manifestFile,
        JSON.stringify({ ...rest, lenses: others })
      );
      expect(await check()).toEqual({
        code: 1,
        stderr:
          "Spyglass: The dataset has no rules lens. Run spyglass scan again.\n",
        stdout: "",
      });
    } finally {
      await writeFile(file, saved);
      await writeFile(manifestFile, manifest);
    }
  }, 60_000);

  test("exits 0 once the rule only permits, or the violation is gone", async () => {
    await declare([{ ...requiring("tooling/c"), effect: "permit" }]);
    expect((await check()).code).toBe(0);
    await declare([requiring("tooling/c")]);
    expect((await check()).code).toBe(3);
    const source = join(root, "tooling/c/src/index.ts");
    const written = await readFile(source, "utf8");
    try {
      await writeFile(
        source,
        written.replace("export function fence", "function fence")
      );
      await scan(root, { state });
      const gone = await check();
      expect(gone.code, gone.stdout).toBe(0);
      expect(gone.stdout).toContain("Violations   0");
    } finally {
      await writeFile(source, written);
    }
  }, 120_000);
});

describe("built CLI plan", () => {
  const SITE = "tooling/c/src/index.ts#fence";
  let directory: string;
  let root: string;
  let state: string;
  const plan = (words: string[]) =>
    runCli(["plan", ...words, "--state", state], root);

  // A committed copy of the semantics fixture whose @s/c has a test script,
  // which readiness runs, and a rule permitting internalize there.
  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "spyglass-plan-")));
    root = join(directory, "workspace");
    await cp(resolve(import.meta.dirname, "lib/fixtures/semantics"), root, {
      recursive: true,
    });
    const manifest = join(root, "tooling/c/package.json");
    const parsed = JSON.parse(await readFile(manifest, "utf8"));
    await writeFile(
      manifest,
      JSON.stringify({ ...parsed, scripts: { test: "true" } })
    );
    await mkdir(join(root, ".foundry/spyglass"), { recursive: true });
    await writeFile(
      join(root, ".foundry/spyglass/rules.ts"),
      'export default { rules: [{ effect: "permit", operator: "internalize", subject: "tooling/c" }] };\n'
    );
    commitFixture(root);
    state = join(directory, "state");
    await scan(root, { state });
  }, 60_000);

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  test("exits 0 with an authorized plan, saves its record in the state directory, and writes nothing in the workspace", async () => {
    const json = await plan([SITE, "--json"]);
    expect(json.code, json.stderr).toBe(0);
    expect(json.stdout.trimEnd().split("\n")).toHaveLength(1);
    const result = JSON.parse(json.stdout) as PlanSiteResult;
    expect(result.site).toBe(SITE);
    expect(result.opportunity).toBe(`internalize-symbol:${SITE}`);
    expect(result.verdict.kind).toBe("authorized");
    const workspace = await workspaceState(root, state);
    expect(result.record?.startsWith(join(workspace.directory, "plans/"))).toBe(
      true
    );
    const record = JSON.parse(await readFile(result.record ?? "", "utf8"));
    expect(
      result.verdict.kind === "authorized" && result.verdict.record
    ).toEqual(record);
    expect(record.execution).toEqual({
      mutator: "internalize-export",
      planFingerprint: result.plan.fingerprint,
      planId: `plan:internalize-symbol:${SITE}`,
    });
    const text = await plan([`plan:internalize-symbol:${SITE}`]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("◇ Authorized");
    expect(text.stdout).toContain(
      `Run spyglass apply internalize-symbol:${SITE} to preview; add --write to write.`
    );
    const status = spawn(["git", "status", "--porcelain"], {
      cwd: root,
      stdout: "pipe",
    });
    expect(await new Response(status.stdout).text()).toBe("");
  }, 60_000);

  test("exits 0 on a refusal, 1 for an opportunity the dataset does not hold, and 2 for another shape", async () => {
    const refused = await plan(["apps/a/src/index.ts#Tile", "--json"]);
    expect(refused.code, refused.stderr).toBe(0);
    expect((JSON.parse(refused.stdout) as PlanSiteResult).verdict.kind).toBe(
      "refused-by-rule"
    );
    const unknown = await plan(["packages/b/src/index.ts#nothing"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("@s/b records no opportunity");
    expect(await plan(["fold-package:@s/c"])).toEqual({
      code: 2,
      stderr:
        "Spyglass: fold-package:@s/c names no internalize opportunity. Write internalize-symbol:<path#name>, its plan id, or <path#name>.\nRun spyglass --help for usage.\n",
      stdout: "",
    });
  }, 60_000);
});

describe("built CLI apply", () => {
  const SITE = "tooling/c/src/index.ts#fence";
  const FILE = "tooling/c/src/index.ts";
  const RULES = ".foundry/spyglass/rules.ts";
  let directory: string;
  let root: string;
  let state: string;
  const cli = (words: string[]) =>
    runCli([...words, "--state", state, "--quiet"], root);
  const status = async () => {
    const child = spawn(["git", "status", "--porcelain"], {
      cwd: root,
      stdout: "pipe",
    });
    return (await new Response(child.stdout).text()).trim();
  };
  /** Runs `body` with a workspace file rewritten, then puts it back. */
  const withFile = async (
    file: string,
    edit: (text: string) => string,
    body: () => Promise<void>
  ) => {
    const path = join(root, file);
    const original = await readFile(path, "utf8");
    await writeFile(path, edit(original));
    try {
      await body();
    } finally {
      await writeFile(path, original);
    }
  };

  // A committed copy of the semantics fixture whose @s/c has a test script
  // and a rule requiring internalize there, which also permits it.
  beforeAll(async () => {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), "spyglass-apply-"))
    );
    root = join(directory, "workspace");
    await cp(resolve(import.meta.dirname, "lib/fixtures/semantics"), root, {
      recursive: true,
    });
    const manifest = join(root, "tooling/c/package.json");
    const parsed = JSON.parse(await readFile(manifest, "utf8"));
    await writeFile(
      manifest,
      JSON.stringify({ ...parsed, scripts: { test: "true" } })
    );
    await mkdir(join(root, ".foundry/spyglass"), { recursive: true });
    await writeFile(
      join(root, RULES),
      'export default { rules: [{ effect: "require", operator: "internalize", subject: "tooling/c" }] };\n'
    );
    commitFixture(root);
    state = join(directory, "state");
    await scan(root, { state });
  }, 60_000);

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  test("checks, plans, refuses what moved, previews, writes, verifies, and scans again", async () => {
    expect((await cli(["check"])).code).toBe(3);

    // A file edited since the scan makes the dataset stale: plan fails early.
    // Scanned with the edit, a dirty file it writes refuses the write, and
    // nothing is written.
    await withFile(
      FILE,
      (text) => `${text}// local edit\n`,
      async () => {
        const stale = await cli(["plan", SITE]);
        expect(stale.code).toBe(1);
        expect(stale.stderr).toContain("The saved dataset is stale");
        await scan(root, { state });
        expect((await cli(["plan", SITE])).code).toBe(0);
        const dirty = await cli(["apply", SITE, "--write", "--json"]);
        expect(dirty.code).toBe(1);
        expect((JSON.parse(dirty.stdout) as ApplyResult).refusal).toEqual({
          files: [FILE],
          kind: "dirty",
        });
        expect(await readFile(join(root, FILE), "utf8")).toContain(
          "export function fence"
        );
      }
    );

    // Rules edited after the plan refuse it, naming the rule.
    await scan(root, { state });
    expect((await cli(["plan", SITE])).code).toBe(0);
    await withFile(
      RULES,
      () =>
        'export default { rules: [{ effect: "permit", operator: "internalize", subject: "packages" }, { effect: "require", operator: "internalize", subject: "tooling/c" }] };\n',
      async () => {
        const moved = await cli(["apply", SITE, "--write"]);
        expect(moved.code).toBe(1);
        expect(moved.stdout).toContain(
          "What spyglass plan authorized has moved: rule."
        );
      }
    );

    const workspace = await workspaceState(root, state);
    const before = JSON.parse(
      await readFile(join(workspace.output, "manifest.json"), "utf8")
    ) as DatasetManifest;
    const preview = await cli(["apply", `internalize-symbol:${SITE}`]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("Preview");
    expect(preview.stdout).toContain(
      "tooling/c/src/index.ts: export function fence(shape: Shape): number { → function fence(shape: Shape): number {"
    );
    expect(await status()).toBe("");

    const written = await cli(["apply", SITE, "--write", "--json"]);
    expect(written.code, written.stderr).toBe(0);
    expect(written.stdout.trimEnd().split("\n")).toHaveLength(1);
    const result = JSON.parse(written.stdout) as ApplyResult;
    expect(result).toMatchObject({
      mode: "write",
      scan: { status: "published" },
      site: SITE,
      status: "applied",
    });
    expect(await readFile(join(root, FILE), "utf8")).not.toContain(
      "export function fence"
    );
    expect(await status()).toBe(`M ${FILE}`);
    const after = JSON.parse(
      await readFile(join(workspace.output, "manifest.json"), "utf8")
    ) as DatasetManifest;
    expect(after.generatedAt > before.generatedAt).toBe(true);
    expect(existsSync(join(workspace.directory, "apply/journal.json"))).toBe(
      false
    );

    expect((await cli(["check"])).code).toBe(0);
    const again = await cli(["apply", SITE]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("No authorized plan is saved");
  }, 180_000);
});

describe("built CLI apply, interrupted", () => {
  const SITE = "tooling/c/src/index.ts#fence";
  const FILE = "tooling/c/src/index.ts";
  let directory: string;
  let root: string;
  let state: string;

  // The test script passes at once before the write, and sleeps after it,
  // so the interrupt lands while apply runs it again; with TRAP_INT set it
  // traps SIGINT and exits 0, as a test runner that cleans up might.
  beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "spyglass-int-")));
    root = join(directory, "workspace");
    await cp(resolve(import.meta.dirname, "lib/fixtures/semantics"), root, {
      recursive: true,
    });
    await writeFile(
      join(root, "tooling/c/slow-test.sh"),
      [
        "grep -q 'export function fence' src/index.ts && exit 0",
        'touch "$SLEEP_MARK"',
        'if [ -n "$TRAP_INT" ]; then',
        "  trap 'exit 0' INT",
        "  sleep 10 &",
        "  wait",
        "  exit 0",
        "fi",
        "sleep 10",
        "",
      ].join("\n")
    );
    const manifest = join(root, "tooling/c/package.json");
    const parsed = JSON.parse(await readFile(manifest, "utf8"));
    await writeFile(
      manifest,
      JSON.stringify({ ...parsed, scripts: { test: "sh ./slow-test.sh" } })
    );
    await mkdir(join(root, ".foundry/spyglass"), { recursive: true });
    await writeFile(
      join(root, ".foundry/spyglass/rules.ts"),
      'export default { rules: [{ effect: "permit", operator: "internalize", subject: "tooling/c" }] };\n'
    );
    commitFixture(root);
    state = join(directory, "state");
    await scan(root, { state });
  }, 60_000);

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  /**
   * Runs `apply --write` in its own process group, and sends that group
   * `signal` once the file is written and, unless `during` is `scan`, once
   * the script runs again, after the scan after the write.
   */
  async function interrupted(
    env: Record<string, string>,
    signal: NodeJS.Signals,
    during: "scan" | "script" = "script"
  ) {
    const mark = join(
      directory,
      `sleeping-${signal}-${during}-${Object.keys(env).length}`
    );
    expect(
      (await runCli(["plan", SITE, "--state", state, "--quiet"], root)).code
    ).toBe(0);
    const original = await readFile(join(root, FILE));
    const child = spawnDetached(
      [CLI, "apply", SITE, "--write", "--state", state, "--quiet"],
      root,
      { ...process.env, ...env, SLEEP_MARK: mark }
    );
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exited = new Promise<number | null>((done) =>
      child.on("exit", (status) => done(status))
    );
    const deadline = Date.now() + 30_000;
    while (
      (await readFile(join(root, FILE), "utf8")).includes(
        "export function fence"
      )
    ) {
      if (Date.now() > deadline) {
        throw new Error("apply never wrote the file");
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    while (during === "script" && !existsSync(mark)) {
      if (Date.now() > deadline) {
        throw new Error("the script never ran after the write");
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    process.kill(-(child.pid ?? 0), signal);
    const code = await exited;
    return {
      code,
      original,
      restored: await readFile(join(root, FILE)),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  }

  for (const [name, env, signal, exit] of [
    ["Ctrl-C stops a script that dies", {}, "SIGINT", 130],
    [
      "Ctrl-C stops a script that traps SIGINT and exits 0",
      { TRAP_INT: "1" },
      "SIGINT",
      130,
    ],
    ["SIGTERM stops a script", {}, "SIGTERM", 143],
  ] as const) {
    test(`restores byte for byte and exits ${exit} when ${name}`, async () => {
      const run = await interrupted(env, signal);
      expect(run.code, run.stderr).toBe(exit);
      expect(run.stderr).toContain(
        `Spyglass: Interrupted by ${signal}; every file Spyglass wrote is restored.`
      );
      expect(run.restored.equals(run.original)).toBe(true);
      const workspace = await workspaceState(root, state);
      expect(existsSync(join(workspace.directory, "apply/journal.json"))).toBe(
        false
      );
    }, 90_000);
  }

  test("restores byte for byte and exits 130 when Ctrl-C stops the scan after the write", async () => {
    const run = await interrupted({}, "SIGINT", "scan");
    expect(run.code, run.stderr).toBe(130);
    expect(run.restored.equals(run.original)).toBe(true);
    const workspace = await workspaceState(root, state);
    expect(existsSync(`${workspace.output}.next`)).toBe(false);
  }, 90_000);
});

test("built CLI includes Git history when requested", async () => {
  const { workspace, directory } = await fixture();
  await cp(
    resolve(import.meta.dirname, "lib/fixtures/semantics"),
    workspace.root,
    { recursive: true }
  );
  commitFixture(workspace.root);
  const child = spawnCli(
    ["scan", "--history", "--state", join(directory, "state")],
    workspace.root
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect(code, stderr).toBe(0);
  const manifest = JSON.parse(
    await readFile(join(workspace.output, "history/manifest.json"), "utf8")
  ) as HistoryManifest;
  expect(manifest.generation.failedSnapshots).toBe(0);
  expect(manifest.generation.successfulSnapshots).toBeGreaterThan(0);
  expect(
    await readFile(join(workspace.output, "history/entities.json"), "utf8")
  ).toContain("packages");
}, 60_000);

test("source and built CLI serve generated files from an external workspace", async () => {
  const { workspace, directory } = await fixture();
  await mkdir(workspace.output, { recursive: true });
  const manifest = '{ "schemaVersion": 5, "unchanged": true }\n';
  await writeFile(join(workspace.output, "manifest.json"), manifest);
  for (const entry of [
    resolve(import.meta.dirname, "../src/cli/spyglass.ts"),
    CLI,
  ]) {
    const child = spawn(
      [
        process.execPath,
        entry,
        "serve",
        "--state",
        join(directory, "state"),
        "--port",
        "0",
        "--no-open",
      ],
      { cwd: workspace.root, stderr: "pipe", stdout: "pipe" }
    );
    try {
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      const url = SERVER_URL.exec(new TextDecoder().decode(value))?.[1];
      expect(url).toBeDefined();
      if (!url) {
        throw new Error(await new Response(child.stderr).text());
      }
      expect((await fetch(url)).status).toBe(200);
      expect(
        await (await fetch(new URL("/data/manifest.json", url))).text()
      ).toBe(manifest);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  }
});

test.each(["dev:spyglass", "dev:spyglass:package"])(
  "%s scans fresh input and serves it through Vite",
  async (command) => {
    const { directory, workspace } = await fixture();
    const packageRoot =
      command === "dev:spyglass"
        ? join(workspace.root, "packages/one")
        : workspace.root;
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ exports: "./index.ts", name: "@dev/one" })
    );
    await writeFile(
      join(packageRoot, "index.ts"),
      "export const answer = 42;\n"
    );
    if (command === "dev:spyglass") {
      await writeFile(
        join(workspace.root, "package.json"),
        JSON.stringify({ name: "dev-workspace", workspaces: ["packages/*"] })
      );
    }
    const child = spawn(
      [
        process.execPath,
        "run",
        command,
        "--",
        workspace.root,
        "--state",
        join(directory, "state"),
        "--port",
        "0",
        "--no-open",
      ],
      {
        cwd: resolve(import.meta.dirname, "../../.."),
        env: { ...process.env, NO_COLOR: "1" },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const stderr = new Response(child.stderr).text();
    try {
      let output = "";
      let url: string | undefined;
      for await (const chunk of child.stdout) {
        output += new TextDecoder().decode(chunk);
        url = DEV_SERVER_URL.exec(output)?.[0];
        if (url) {
          break;
        }
      }
      if (!url) {
        throw new Error(`${output}\n${await stderr}`);
      }
      expect(await (await fetch(url)).text()).toContain("/@vite/client");
      const manifest = (await (
        await fetch(new URL("data/manifest.json", url))
      ).json()) as DatasetManifest;
      expect(
        manifest.packages.map((pkg) => ({ id: pkg.id, status: pkg.status }))
      ).toEqual([{ id: "@dev/one", status: "complete" }]);
      expect(manifest.discovery.declarationSource).toBe(
        command === "dev:spyglass" ? "package.json#workspaces" : "package.json"
      );
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await stderr;
    }
  },
  30_000
);
