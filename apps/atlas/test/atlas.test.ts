import { afterEach, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import { parseArguments } from "../src/cli/args";
import type { SemanticsHistoryManifest } from "../src/lib/semantics-history-types";
import type { SemanticsManifest } from "../src/lib/semantics-types";
import { workspaceState } from "../src/lib/state";
import { startServer } from "../src/server/server";
import { loadAtlas } from "../src/web/load-atlas";
import { loadInternals } from "../src/web/load-internals";
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

test("commands select current or explicit workspaces and reject invalid flags", () => {
  expect(parseArguments([], "/workspace")).toMatchObject({
    command: "open",
    open: true,
    target: "/workspace",
  });
  expect(parseArguments(["scan", "/another"])).toMatchObject({
    command: "scan",
    target: "/another",
  });
  expect(parseArguments(["serve", "--no-open", "--port", "0"])).toMatchObject({
    command: "serve",
    open: false,
    port: 0,
  });
  expect(() => parseArguments(["--port", "65536"])).toThrow("Port");
  expect(() => parseArguments(["--unknown"])).toThrow();
  expect(() => parseArguments(["scan", "one", "two"])).toThrow("one workspace");
});

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
  const webRoot = resolve(import.meta.dirname, "../dist/web");
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
  const server = startServer({ output: workspace.output, port: 0, webRoot });
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
        new Uint8Array(await readFile(join(webRoot, asset)))
      );
    }
    expect(await (await request("/atlas/two-masted-brig.glb")).bytes()).toEqual(
      new Uint8Array(await readFile(join(webRoot, "atlas/two-masted-brig.glb")))
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

test("built CLI scans an external workspace and the web loaders consume its saved evidence", async () => {
  const { workspace, directory } = await fixture();
  const cli = resolve(import.meta.dirname, "../dist/cli/atlas.js");
  const help = spawn([process.execPath, cli, "--help"], {
    cwd: workspace.root,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(await help.exited).toBe(0);
  expect(await new Response(help.stdout).text()).toContain("atlas scan");
  await cp(
    resolve(import.meta.dirname, "lib/fixtures/semantics"),
    workspace.root,
    { recursive: true }
  );
  const runScan = async () => {
    const child = spawn(
      [process.execPath, cli, "scan", "--state", join(directory, "state")],
      { cwd: workspace.root, stderr: "pipe", stdout: "pipe" }
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(code, stderr).toBe(0);
    // Progress is the CLI's formatting of the library's events.
    const lines = stderr.trimEnd().split("\n");
    expect(lines[0]).toBe("discover");
    expect(lines.slice(lines.indexOf("write"))).toEqual([
      "write",
      "internals: @s/a",
      "internals: @s/b",
      "internals: @s/c",
    ]);
    return JSON.parse(
      await readFile(join(workspace.output, "manifest.json"), "utf8")
    ) as SemanticsManifest;
  };
  const first = await runScan();
  expect(first.schemaVersion).toBe(3);
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
  expect(
    await readFile(join(workspace.output, "manifests", filename), "utf8")
  ).toBe(
    await readFile(join(workspace.root, pkg.path, "package.json"), "utf8")
  );
  // Rendering uses the saved output even after the source workspace is removed.
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
    expect(atlas.territories.map((territory) => territory.id)).toContain(
      pkg.id
    );
    const { signal } = new AbortController();
    const evidence = await loadInternals(pkg.id, second.generatedAt, signal);
    expect(evidence.architecture?.review).toBeDefined();
    await expect(
      loadInternals(pkg.id, "outdated-survey", signal)
    ).rejects.toThrow("survey changed");
    await rm(join(workspace.output, "internals", filename));
    await expect(
      loadInternals(pkg.id, second.generatedAt, signal)
    ).rejects.toThrow("404");
    await rm(join(workspace.output, "manifest.json"));
    await expect(loadAtlas()).rejects.toThrow("Run atlas scan");
  } finally {
    globalThis.fetch = nativeFetch;
    server.stop(true);
  }
}, 60_000);

test("built CLI includes Git history when requested", async () => {
  const { workspace, directory } = await fixture();
  await cp(
    resolve(import.meta.dirname, "lib/fixtures/semantics"),
    workspace.root,
    { recursive: true }
  );
  commitFixture(workspace.root);
  const child = spawn(
    [
      process.execPath,
      resolve(import.meta.dirname, "../dist/cli/atlas.js"),
      "scan",
      "--history",
      "--state",
      join(directory, "state"),
    ],
    { cwd: workspace.root, stderr: "pipe", stdout: "pipe" }
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect(code, stderr).toBe(0);
  const manifest = JSON.parse(
    await readFile(join(workspace.output, "history/manifest.json"), "utf8")
  ) as SemanticsHistoryManifest;
  expect(manifest.generation.failedSnapshots).toBe(0);
  expect(manifest.generation.successfulSnapshots).toBeGreaterThan(0);
  expect(
    await readFile(join(workspace.output, "history/entities.json"), "utf8")
  ).toContain("packages");
}, 60_000);

test("source and built CLI serve generated files from an external workspace", async () => {
  const { workspace, directory } = await fixture();
  await mkdir(workspace.output, { recursive: true });
  const manifest = '{ "unchanged": true }\n';
  await writeFile(join(workspace.output, "manifest.json"), manifest);
  for (const entry of ["../src/cli/index.ts", "../dist/cli/atlas.js"]) {
    const child = spawn(
      [
        process.execPath,
        resolve(import.meta.dirname, entry),
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
