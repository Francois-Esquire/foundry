import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
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
import { loadConfiguration } from "../src/lib/atlas-config";
import type { CheckResult } from "../src/lib/check";
import type { PlanSiteResult } from "../src/lib/codemod-types";
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
import type { WorkspaceState } from "../src/lib/state";
import { workspaceState } from "../src/lib/state";
import { startServer } from "../src/server/server";
import { loadAtlas } from "../src/web/load-atlas";
import { loadInternals } from "../src/web/load-internals";
import { CLI, spawnCli } from "./helpers/cli";
import { commitFixture } from "./helpers/commit-fixture";

const directories: string[] = [];
const SERVER_URL = /Atlas: (http:\/\/\S+)/;
const BUNDLED_ASSET = /(?:src|href)="([^"]+\.(?:js|css))"/g;
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "atlas-test-"));
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
    expect(await (await request("/atlas/two-masted-brig.glb")).bytes()).toEqual(
      new Uint8Array(await readFile(join(viewer, "atlas/two-masted-brig.glb")))
    );
    expect((await request("/atlas.svg")).headers.get("content-type")).toContain(
      "image/svg+xml"
    );
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
  const manifest = '{ "schemaVersion": 4, "packages": [] }\n';
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
    `No dataset found for ${workspace.root} in ${workspace.output}. Run atlas scan to save one.`
  );
  await mkdir(workspace.output, { recursive: true });
  await writeFile(
    join(workspace.output, "manifest.json"),
    '{ "schemaVersion": 3 }\n'
  );
  await expect(serve(workspace.root, { port: 0, state })).rejects.toThrow(
    "Atlas reads dataset schema version 4; this dataset has version 3. Run atlas scan to save it again."
  );
});

test("built CLI scans an external workspace and the web loaders read its saved dataset through the reader, over the real server", async () => {
  const { workspace, directory } = await fixture();
  const help = spawnCli(["--help"], workspace.root);
  expect(await help.exited).toBe(0);
  expect(await new Response(help.stdout).text()).toContain("atlas scan");
  await cp(
    resolve(import.meta.dirname, "lib/fixtures/semantics"),
    workspace.root,
    { recursive: true }
  );
  // A domain across two packages; the analyses never read it.
  await mkdir(join(workspace.root, ".foundry/atlas"), { recursive: true });
  await writeFile(
    join(workspace.root, ".foundry/atlas/domains.ts"),
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
    ]);
    return JSON.parse(
      await readFile(join(workspace.output, "manifest.json"), "utf8")
    ) as DatasetManifest;
  };
  const first = await runScan();
  expect(first.schemaVersion).toBe(4);
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
    const atlas = await loadAtlas();
    const territory = atlas.territories.find((item) => item.id === pkg.id);
    if (!territory) {
      throw new Error(`The map has no island for ${pkg.id}.`);
    }
    // The map keeps the lens's entry from load and binds it on entering the island.
    const { fileRoles } = territory;
    expect(fileRoles?.modules).toEqual(
      roles.packages.find((saved) => saved.id === pkg.id)?.modules
    );
    const grouped = groups.packages.find((entry) => entry.id === pkg.id);
    expect(territory.responsibilityGroups).toEqual(
      grouped && { groups: grouped.groups, independent: grouped.independent }
    );
    const { signal } = new AbortController();
    const evidence = await loadInternals(
      pkg.id,
      fileRoles,
      second.generatedAt,
      signal
    );
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
      loadInternals(pkg.id, fileRoles, "2000-01-01T00:00:00.000Z", signal)
    ).rejects.toThrow(
      "A later scan replaced the dataset. Reload Atlas to see it."
    );
    await rm(join(workspace.output, "internals", filename));
    await expect(
      loadInternals(pkg.id, fileRoles, second.generatedAt, signal)
    ).rejects.toThrow(
      `The dataset is missing internals/${filename}. Run atlas scan again.`
    );
    await rm(join(workspace.output, "manifest.json"));
    await expect(loadAtlas()).rejects.toThrow(
      "No dataset found. Run atlas scan to save one."
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
    directory = await realpath(await mkdtemp(join(tmpdir(), "atlas-cli-")));
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
    const missing = `Atlas: No dataset found for ${fresh.root} in ${fresh.output}. Run atlas scan to save one.\n`;
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
        "Atlas: The dataset has no package named @s/x. Its packages: @s/a, @s/b, @s/c.\n",
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
        "Atlas: atlas lens takes domains, file-roles, frequent-change, nesting, package-sizes, placement, proximity, responsibility-groups, or rules.\nRun atlas --help for usage.\n",
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
            "Atlas: The dataset has no domains lens. Run atlas scan again.\n",
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
      stderr: `Atlas: ${root} holds the workspace ${root}. Choose another directory.\n`,
      stdout: "",
    });
  });

  test("a usage error exits 2 with a pointer to the help", async () => {
    expect(await runCli(["scan", "one", "two"], root)).toEqual({
      code: 2,
      stderr:
        "Atlas: atlas scan takes one workspace path. Reading several workspaces at once is not supported yet.\nRun atlas --help for usage.\n",
      stdout: "",
    });
    expect(await runCli(["serve", "--history"], root)).toEqual({
      code: 2,
      stderr:
        "Atlas: atlas serve does not take --history.\nRun atlas --help for usage.\n",
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

describe("built CLI check", () => {
  let directory: string;
  let root: string;
  let state: string;
  const RULES = ".foundry/atlas/rules.ts";
  const declare = async (rules: unknown[]) => {
    await mkdir(join(root, ".foundry/atlas"), { recursive: true });
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
    directory = await realpath(await mkdtemp(join(tmpdir(), "atlas-check-")));
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
        "Rules\n═════\nNo rules declared. Declare them under rules in .foundry/atlas/.\n",
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
    // The same lens `atlas lens rules` prints.
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
        "Atlas: rules[0] meets @s/c, which failed analysis, so it could not be checked there. Fix the package or narrow the rule's subject, then scan again.\n"
      );
      const { lenses, ...rest } = JSON.parse(manifest) as DatasetManifest;
      const { rules: _rules, ...others } = lenses;
      await writeFile(
        manifestFile,
        JSON.stringify({ ...rest, lenses: others })
      );
      expect(await check()).toEqual({
        code: 1,
        stderr: "Atlas: The dataset has no rules lens. Run atlas scan again.\n",
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
    directory = await realpath(await mkdtemp(join(tmpdir(), "atlas-plan-")));
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
    await mkdir(join(root, ".foundry/atlas"), { recursive: true });
    await writeFile(
      join(root, ".foundry/atlas/rules.ts"),
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
      `Run atlas apply internalize-symbol:${SITE} to preview; add --write to write.`
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
        "Atlas: fold-package:@s/c names no internalize opportunity. Write internalize-symbol:<path#name>, its plan id, or <path#name>.\nRun atlas --help for usage.\n",
      stdout: "",
    });
  }, 60_000);
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
  const manifest = '{ "schemaVersion": 4, "unchanged": true }\n';
  await writeFile(join(workspace.output, "manifest.json"), manifest);
  for (const entry of [
    resolve(import.meta.dirname, "../src/cli/atlas.ts"),
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
