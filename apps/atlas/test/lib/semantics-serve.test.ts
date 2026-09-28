import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: The module namespace is required by vi.spyOn to replace the analyzer in this server test.
import * as analyze from "../../src/lib/analyze";
import type { SemanticsServer } from "../../src/lib/semantics-serve";
import {
  createSemanticsServer,
  DEFAULT_SEMANTICS_HOST,
  DEFAULT_SEMANTICS_PORT,
  resolveServedFile,
} from "../../src/lib/semantics-serve";

/** A repository-like tree: source at the root, a dataset and an index page under `.foundry/`. */
function makeTree(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "serve-")));
  writeFileSync(join(repo, "package.json"), '{"name":"secret"}');
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "index.ts"), "export const secret = 1;\n");
  const web = join(repo, ".foundry");
  mkdirSync(join(web, "semantics", "modules"), { recursive: true });
  writeFileSync(
    join(web, "index.html"),
    "<!doctype html><title>explorer</title>"
  );
  writeFileSync(join(web, "app.js"), "console.log(1)");
  writeFileSync(join(web, "style.css"), "body{}");
  writeFileSync(
    join(web, "semantics", "manifest.json"),
    JSON.stringify({ counts: { packages: 2 }, schemaVersion: 1 })
  );
  writeFileSync(join(web, "semantics", "modules", "index.json"), "{}");
  symlinkSync(join(repo, "src"), join(web, "escape"));
  return repo;
}

describe("resolveServedFile", () => {
  const repo = makeTree();
  const web = join(repo, ".foundry");
  afterAll(() => {
    rmSync(repo, { force: true, recursive: true });
  });

  it("maps request paths inside the root", () => {
    expect(resolveServedFile(web, "/semantics/manifest.json")).toBe(
      join(web, "semantics", "manifest.json")
    );
    expect(resolveServedFile(web, "/semantics/manifest.json?x=1")).toBe(
      join(web, "semantics", "manifest.json")
    );
    expect(resolveServedFile(web, "/")).toBe(web);
    expect(resolveServedFile(web, "/%73emantics/manifest.json")).toBe(
      join(web, "semantics", "manifest.json")
    );
  });

  it("refuses every path that escapes the root", () => {
    for (const request of [
      "/../package.json",
      "/../../package.json",
      "/semantics/../../package.json",
      "/%2e%2e/package.json",
      "/..%2fpackage.json",
      "/escape/index.ts",
      "/semantics/manifest.json%00",
      "/missing.json",
    ]) {
      expect(resolveServedFile(web, request), request).toBeUndefined();
    }
  });
});

describe("static server", () => {
  let repo: string;
  let url: string;
  let server: SemanticsServer;
  const analyzeSpy = vi.spyOn(analyze, "analyzeSurface");

  beforeAll(async () => {
    repo = makeTree();
    server = createSemanticsServer({
      port: 0,
      root: join(repo, ".foundry"),
    });
    const listening = await server.listen();
    ({ url } = listening);
    expect(listening.host).toBe("127.0.0.1");
    expect(listening.port).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await server.close();
    rmSync(repo, { force: true, recursive: true });
  });

  it("defaults to localhost and port 4173", () => {
    expect(DEFAULT_SEMANTICS_HOST).toBe("127.0.0.1");
    expect(DEFAULT_SEMANTICS_PORT).toBe(4173);
    const overlayServer = createSemanticsServer({ root: repo });
    expect(overlayServer.root).toBe(repo);
  });

  it("serves index.html at /", async () => {
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
    expect(await response.text()).toContain("explorer");
  });

  it("serves the manifest as JSON without caching", async () => {
    const response = await fetch(`${url}/semantics/manifest.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.json()).toEqual({
      counts: { packages: 2 },
      schemaVersion: 1,
    });
  });

  it("uses the right MIME type per extension", async () => {
    const types: [string, string][] = [
      ["/index.html", "text/html; charset=utf-8"],
      ["/app.js", "text/javascript; charset=utf-8"],
      ["/style.css", "text/css; charset=utf-8"],
      ["/semantics/modules/index.json", "application/json"],
    ];
    for (const [file, type] of types) {
      const response = await fetch(`${url}${file}`);
      expect(response.status, file).toBe(200);
      expect(response.headers.get("content-type"), file).toBe(type);
    }
  });

  it("returns 404 for unknown paths with no SPA fallback", async () => {
    for (const request of [
      "/nope.json",
      "/semantics/missing",
      "/semantics/modules",
    ]) {
      const response = await fetch(`${url}${request}`);
      expect(response.status, request).toBe(404);
      expect(await response.text()).not.toContain("explorer");
    }
  });

  it("never exposes repository source", async () => {
    for (const request of [
      "/../package.json",
      "/../src/index.ts",
      "/%2e%2e/package.json",
      "/escape/index.ts",
    ]) {
      const response = await fetch(`${url}${request}`);
      expect(response.status, request).toBe(404);
      const text = await response.text();
      expect(text).not.toContain("secret");
    }
  });

  it("rejects non-GET methods", async () => {
    const response = await fetch(`${url}/semantics/manifest.json`, {
      method: "POST",
    });
    expect(response.status).toBe(405);
  });

  it("serves whatever is on disk and never analyzes", async () => {
    writeFileSync(join(repo, "src", "index.ts"), "export const secret = 2;\n");
    writeFileSync(
      join(repo, ".foundry", "semantics", "manifest.json"),
      JSON.stringify({ counts: { packages: 3 }, schemaVersion: 1 })
    );
    const response = await fetch(`${url}/semantics/manifest.json`);
    expect(await response.json()).toEqual({
      counts: { packages: 3 },
      schemaVersion: 1,
    });
    expect(analyzeSpy).not.toHaveBeenCalled();
  });

  it("explains the missing index when there is none", async () => {
    rmSync(join(repo, ".foundry", "index.html"));
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("/semantics/manifest.json");
  });
});

describe("app overlay", () => {
  let repo: string;
  let url: string;
  let server: SemanticsServer;

  beforeAll(async () => {
    repo = makeTree();
    const app = join(repo, "explorer");
    mkdirSync(join(app, "js"), { recursive: true });
    writeFileSync(
      join(app, "index.html"),
      "<!doctype html><title>overlay</title>"
    );
    writeFileSync(join(app, "js", "app.js"), "export {}");
    mkdirSync(join(app, "semantics"));
    writeFileSync(join(app, "semantics", "manifest.json"), '{"decoy":true}');
    symlinkSync(join(repo, "src"), join(app, "escape"));
    server = createSemanticsServer({
      app,
      port: 0,
      root: join(repo, ".foundry"),
    });
    ({ url } = await server.listen());
  });

  afterAll(async () => {
    await server.close();
    rmSync(repo, { force: true, recursive: true });
  });

  it("serves the app at / ahead of the web root", async () => {
    expect(await (await fetch(`${url}/`)).text()).toContain("overlay");
    expect(await (await fetch(`${url}/index.html`)).text()).toContain(
      "overlay"
    );
    const script = await fetch(`${url}/js/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8"
    );
  });

  it("falls through to the web root for files the app lacks", async () => {
    expect(await (await fetch(`${url}/app.js`)).text()).toBe("console.log(1)");
  });

  it("always takes /semantics/ from the web root", async () => {
    expect(
      await (await fetch(`${url}/semantics/manifest.json`)).json()
    ).toEqual({ counts: { packages: 2 }, schemaVersion: 1 });
  });

  it("applies the same escape rules to the app directory", async () => {
    for (const request of ["/escape/index.ts", "/../src/index.ts"]) {
      const response = await fetch(`${url}${request}`);
      expect(response.status, request).toBe(404);
      expect(await response.text()).not.toContain("secret");
    }
  });
});
