import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import { parseArguments } from "../src/cli/args";
import { resolveWorkspace } from "../src/cli/workspace";
import { startServer } from "../src/server/server";

const directories: string[] = [];
const SERVER_URL = /Atlas: (http:\/\/\S+)/;
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
  const workspace = await resolveWorkspace(root, join(directory, "state"));
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
  expect(await resolveWorkspace(alias, join(directory, "state"))).toEqual(
    workspace
  );
  const other = join(directory, "other");
  await mkdir(other);
  expect(
    (await resolveWorkspace(other, join(directory, "state"))).output
  ).not.toBe(workspace.output);
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
    expect((await request("/")).status).toBe(200);
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

test("built CLI resolves the caller workspace and fails clearly at the unconnected library", async () => {
  const { workspace, directory } = await fixture();
  const cli = resolve(import.meta.dirname, "../dist/cli/atlas.js");
  const help = spawn([process.execPath, cli, "--help"], {
    cwd: workspace.root,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(await help.exited).toBe(0);
  expect(await new Response(help.stdout).text()).toContain("atlas scan");
  const scan = spawn(
    [process.execPath, cli, "scan", "--state", join(directory, "state")],
    { cwd: workspace.root, stderr: "pipe", stdout: "pipe" }
  );
  expect(await scan.exited).toBe(1);
  expect(await new Response(scan.stderr).text()).toContain(
    "analysis is not connected"
  );
});

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
