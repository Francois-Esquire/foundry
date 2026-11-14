import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as BrowserAnalysis from "../src/lib/browser-analysis";
import { createFileMapScanner } from "../src/lib/file-map-scanner";
import { scanGitHubRepository } from "../src/lib/repository-scan";
import { canonicalizeSemanticsArtifact } from "../src/lib/semantics-equivalence";
import type { FakeRepository } from "./lib/helpers/github-fake";
import { fakeGitHub } from "./lib/helpers/github-fake";

// The browser analysis asset as `bun run build` writes it (dist/scan/
// analysis): one module with no import left, whose process, require and
// file-system shims run here as they run in a page, giving the same
// dataset, artifact for artifact, as the sources scanning the same
// repository. Only timings, which no two runs share, are set aside: the
// generation record's clock fields here, and the V8 simulation clocks by
// the documented canonical rules. The clock runs unevenly, so the two
// scans never share a timing by chance.

const ASSET = resolve(
  import.meta.dirname,
  "../dist/scan/analysis/spyglass-analysis.js"
);
const COMMIT = "3333333333333333333333333333333333333333";
const NOW = new Date("2026-11-09T00:00:00.000Z");
/** A static `import` statement, which a page would have to resolve. */
const STATIC_IMPORT = /^\s*import\s[^(]/m;
/** A re-export or import naming a bare package or Node built-in. */
const BARE_FROM = /\bfrom\s*["'](?:node:)?[a-z@][^"']*["']\s*;?\s*$/m;

const repository: FakeRepository = {
  commits: {
    [COMMIT]: {
      ".gitignore": "dist\n",
      "package.json": JSON.stringify({
        name: "fixture",
        private: true,
        workspaces: ["packages/*"],
      }),
      "packages/a/package.json": JSON.stringify({
        exports: "./src/index.ts",
        name: "@fixture/a",
      }),
      "packages/a/src/helper.ts": "export const helper = () => 1;\n",
      "packages/a/src/index.ts":
        'import { parse } from "yaml";\nexport { helper } from "./helper";\nexport const read = (text: string) => parse(text);\n',
      "packages/b/package.json": JSON.stringify({
        dependencies: { "@fixture/a": "workspace:*" },
        name: "@fixture/b",
      }),
      "packages/b/src/index.ts":
        'import { helper } from "@fixture/a";\nimport "./missing";\nexport const b = helper() + 1;\n',
      "packages/b/vite.config.ts":
        'throw new Error("a repository configuration module must never run");\n',
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
    },
  },
  defaultBranch: "main",
  refs: { main: COMMIT },
};

/**
 * Every artifact's JSON, with wall-clock timings removed. The manifest keeps
 * its generation record, less the clock fields; every other artifact is
 * compared canonically (`canonicalizeSemanticsArtifact`), which removes only
 * the documented volatile fields: the V8 simulation `runtimeMs` of each
 * package report.
 */
function artifacts(dataset: {
  paths: readonly string[];
  text(path: string): string | undefined;
}) {
  const timeless = (_key: string, value: unknown) =>
    _key === "durationMs" ||
    _key === "totalDurationMs" ||
    _key === "startedAt" ||
    _key === "finishedAt"
      ? undefined
      : value;
  return Object.fromEntries(
    dataset.paths.map((path) => {
      const value: unknown = JSON.parse(dataset.text(path) ?? "null", timeless);
      return [
        path,
        path === "manifest.json"
          ? value
          : canonicalizeSemanticsArtifact(path, value),
      ];
    })
  );
}

/** A monotonic clock whose every step is longer than the last. */
function unevenClock() {
  let now = 0;
  let step = 0;
  return vi.spyOn(performance, "now").mockImplementation(() => {
    step += 1;
    now += step * 0.37;
    return now;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the built browser analysis asset", () => {
  it("is one module with no import left for a page to resolve", () => {
    const source = readFileSync(ASSET, "utf8");
    expect(source).not.toMatch(STATIC_IMPORT);
    expect(source).not.toMatch(BARE_FROM);
    expect(source).not.toContain("__vite-browser-external");
  });

  it("scans as the sources do, with its own shims, running no repository code", async () => {
    const asset = (await import(ASSET)) as typeof BrowserAnalysis;
    unevenClock();
    const run = (
      scanner: ReturnType<typeof createFileMapScanner>,
      scan: typeof scanGitHubRepository
    ) =>
      scan(
        scanner,
        { now: NOW, url: "https://github.com/octo/fixture" },
        {
          clock: () => NOW,
          fetch: fakeGitHub({ "octo/fixture": repository }).fetch,
        }
      );
    const built = await run(
      asset.createFileMapScanner(),
      asset.scanGitHubRepository as typeof scanGitHubRepository
    );
    const sources = await run(createFileMapScanner(), scanGitHubRepository);
    expect(artifacts(built.dataset)).toEqual(artifacts(sources.dataset));
    const manifest = await built.dataset.reader().manifest();
    expect(manifest.packages.map((pkg) => pkg.path).sort()).toEqual([
      "packages/a",
      "packages/b",
    ]);
    const analysis = await built.dataset.reader().analysis();
    expect(analysis?.capabilities.configuration.configModules).toEqual([
      "packages/b/vite.config.ts",
    ]);
    expect(analysis?.capabilities.types.unresolvedPackages).toEqual(["yaml"]);
    expect(analysis?.capabilities.moduleGraph.unresolved).toContainEqual({
      from: "packages/b/src/index.ts",
      specifier: "./missing",
    });
  });
});
