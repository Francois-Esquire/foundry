import { describe, expect, it } from "vitest";
import { datasetReader } from "../../src/lib/dataset";
import type { DatasetAnalysis } from "../../src/lib/dataset-analysis";
import {
  datasetAnalysisProblems,
  verifyDatasetAnalysis,
} from "../../src/lib/dataset-analysis";
import { DATASET_ANALYSIS_FILE } from "../../src/lib/dataset-layout";
import { fileMapDataset } from "../../src/lib/file-map-dataset";
import type { FileMapScanProgress } from "../../src/lib/file-map-scanner";
import {
  createFileMapScanner,
  FileMapScanAbortedError,
} from "../../src/lib/file-map-scanner";
import { RepositoryAcquisitionError } from "../../src/lib/github-loader";
import { RepositoryInputError } from "../../src/lib/github-request";
import { scanGitHubRepository } from "../../src/lib/repository-scan";
import type { FakeRepository } from "./helpers/github-fake";
import { deferred, fakeGitHub } from "./helpers/github-fake";

// A public GitHub revision through the loader and the existing file-map
// scanner to a dataset read by the existing reader: the repository's
// coordinates and the loader's omissions are saved as analysis metadata
// version 2, survive a reload, and agree with the manifest; version 1
// file-map metadata is unchanged; the scanner's replacement, reset and
// stale-result rules hold across network awaits.

/** A module graph as recovery-era versions 1 and 2 recorded it. */
const RECORDED_GRAPH = {
  edgeKinds: ["import"],
  modulesOutsideProgram: [],
  nativeSource: "dependency-cruiser",
  source: "typescript-program",
  unresolved: [
    { from: "packages/a/src/index.ts", kind: "import", specifier: "x" },
  ],
  unsupportedEdgeKinds: [],
};

const SHA = "3333333333333333333333333333333333333333";
const NOW = new Date("2026-11-07T00:00:00Z");
const URL = "https://github.com/octo/demo";

const WORKSPACE: FakeRepository = {
  commits: {
    [SHA]: {
      "docs/diagram.png": new Uint8Array([1, 2, 3]),
      "package.json": JSON.stringify({
        name: "demo-root",
        private: true,
        workspaces: ["packages/*"],
      }),
      "packages/a/package.json": JSON.stringify({
        exports: { ".": "./src/index.ts" },
        name: "@demo/a",
      }),
      "packages/a/src/index.ts": "export const a = (): number => 1;\n",
      "packages/a/src/link.ts": { kind: "symlink", target: "index.ts" },
      "packages/b/package.json": JSON.stringify({
        exports: { ".": "./src/index.ts" },
        name: "@demo/b",
      }),
      "packages/b/src/index.ts":
        'import { a } from "@demo/a";\nexport const b = () => a();\n',
    },
  },
  defaultBranch: "main",
  refs: { main: SHA },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const label = (progress: FileMapScanProgress): string => {
  switch (progress.phase) {
    case "analyze":
      return `analyze:${progress.package}:${progress.stage}`;
    case "assemble":
      return `assemble:${progress.step}`;
    default:
      return `${progress.phase}:${progress.stage}`;
  }
};

function reloaded(texts: Record<string, string>) {
  const copy = JSON.parse(JSON.stringify(texts)) as Record<string, string>;
  return (path: string) => {
    const text = copy[path];
    return Promise.resolve(text === undefined ? undefined : JSON.parse(text));
  };
}

describe("scanGitHubRepository", () => {
  it("builds a dataset whose saved origin names the repository revision", async () => {
    const github = fakeGitHub({ "octo/demo": WORKSPACE });
    const scanner = createFileMapScanner();
    const events: string[] = [];
    const { acquisitionTiming, dataset } = await scanGitHubRepository(
      scanner,
      { now: NOW, url: URL },
      { fetch: github.fetch, onProgress: (p) => events.push(label(p)) }
    );
    expect(scanner.current).toBe(dataset);
    expect(Object.keys(acquisitionTiming).sort()).toEqual([
      "downloadMs",
      "listMs",
      "resolveMs",
    ]);
    expect(events.slice(0, 5)).toEqual([
      "resolve:start",
      "resolve:end",
      "list:start",
      "list:end",
      "download:start",
    ]);
    expect(events.filter((e) => e === "download:progress")).toHaveLength(5);
    expect(events.indexOf("download:end")).toBeLessThan(
      events.indexOf("prepare:start")
    );
    expect(events.at(-1)).toBe("assemble:visualization");

    const manifest = await dataset.reader().manifest();
    expect(manifest.workspace.root).toBe("demo");
    expect(manifest.generation.command).toBe("scanGitHubRepository");
    expect(manifest.packages.map((pkg) => pkg.path).sort()).toEqual([
      "packages/a",
      "packages/b",
    ]);

    const texts = Object.fromEntries(
      dataset.paths.map((path) => [path, dataset.text(path) ?? ""])
    );
    const analysis = await datasetReader(reloaded(texts)).analysis();
    expect(analysis?.schemaVersion).toBe(3);
    if (analysis?.origin.kind !== "github-repository") {
      throw new Error("expected a repository origin");
    }
    expect(analysis.origin).toEqual({
      acquisition: {
        integrity: "git-blob-sha1-matches-listing",
        limitations: [
          "history-not-fetched",
          "integrity-is-listing-consistency",
          "dependencies-not-installed",
          "public-repositories-only",
        ],
        limits: {
          concurrency: 6,
          maxFileBytes: 1_000_000,
          maxFiles: 5000,
          maxTotalBytes: 50_000_000,
          maxTreeEntries: 100_000,
        },
        omissions: {
          binary: [],
          nodeModules: [],
          notAnalysisInput: 1,
          notUtf8: [],
          submodules: [],
          symlinks: ["packages/a/src/link.ts"],
          tooLarge: [],
        },
        origins: [
          "https://api.github.com",
          "https://raw.githubusercontent.com",
        ],
        read: { bytes: expect.any(Number), files: 5 },
      },
      command: "scanGitHubRepository",
      kind: "github-repository",
      repository: {
        defaultBranch: "main",
        host: "github.com",
        owner: "octo",
        refKind: "default-branch",
        repo: "demo",
        requestedRef: null,
        resolvedCommit: SHA,
        scope: null,
      },
      root: "/github/octo/demo",
    });
    expect(analysis.capabilities.paths.root).toBe("/github/octo/demo");
    expect(analysis.capabilities.history.available).toBe(false);
  });

  it("scans a scope with the scope's last directory as the workspace root", async () => {
    const github = fakeGitHub({ "octo/demo": WORKSPACE });
    const { dataset } = await scanGitHubRepository(
      createFileMapScanner(),
      { now: NOW, ref: SHA, scope: "packages/b", url: URL },
      { fetch: github.fetch }
    );
    expect((await dataset.reader().manifest()).workspace.root).toBe("b");
    const analysis = await dataset.reader().analysis();
    expect(analysis?.origin).toMatchObject({
      repository: {
        refKind: "commit-sha",
        requestedRef: SHA,
        scope: "packages/b",
      },
      root: "/github/octo/demo/packages/b",
    });
  });

  it("refuses an unsupported input before touching the scanner", async () => {
    const github = fakeGitHub({ "octo/demo": WORKSPACE });
    const scanner = createFileMapScanner();
    const { dataset } = await scanGitHubRepository(
      scanner,
      { now: NOW, url: URL },
      { fetch: github.fetch }
    );
    const before = github.requests.length;
    await expect(
      scanGitHubRepository(
        scanner,
        { now: NOW, url: "https://github.com/octo/demo/tree/a/b" },
        { fetch: github.fetch }
      )
    ).rejects.toBeInstanceOf(RepositoryInputError);
    expect(scanner.current).toBe(dataset);
    expect(scanner.running).toBe(false);
    expect(github.requests.length).toBe(before);
  });

  it("publishes nothing when the load fails", async () => {
    const scanner = createFileMapScanner();
    await expect(
      scanGitHubRepository(
        scanner,
        { now: NOW, url: URL },
        { fetch: fakeGitHub({}).fetch }
      )
    ).rejects.toBeInstanceOf(RepositoryAcquisitionError);
    expect(scanner.current).toBeUndefined();
    expect(scanner.running).toBe(false);
  });

  it("a replacing scan aborts a download in flight; its late response publishes nothing", async () => {
    const github = fakeGitHub({ "octo/demo": WORKSPACE });
    const held = deferred<Response>();
    let holding = true;
    github.hook((url) => {
      if (holding && url.host === "raw.githubusercontent.com") {
        holding = false;
        return held.promise;
      }
    });
    const scanner = createFileMapScanner();
    const first: string[] = [];
    const replaced = scanGitHubRepository(
      scanner,
      { command: "first", now: NOW, url: URL },
      {
        fetch: github.fetch,
        limits: { concurrency: 1 },
        onProgress: (p) => first.push(label(p)),
      }
    );
    while (holding) {
      await tick();
    }
    const replacement = scanGitHubRepository(
      scanner,
      { command: "second", now: NOW, url: URL },
      { fetch: github.fetch }
    );
    await expect(replaced).rejects.toBeInstanceOf(FileMapScanAbortedError);
    held.resolve(new Response("{}"));
    const { dataset } = await replacement;
    await tick();
    expect(first).toEqual([
      "resolve:start",
      "resolve:end",
      "list:start",
      "list:end",
      "download:start",
    ]);
    expect(scanner.current).toBe(dataset);
    expect((await dataset.reader().manifest()).generation.command).toBe(
      "second"
    );
  });

  it("reset during download rejects and keeps nothing", async () => {
    const github = fakeGitHub({ "octo/demo": WORKSPACE });
    const held = deferred<Response>();
    let holding = true;
    github.hook((url) => {
      if (holding && url.host === "raw.githubusercontent.com") {
        holding = false;
        return held.promise;
      }
    });
    const scanner = createFileMapScanner();
    const scan = scanGitHubRepository(
      scanner,
      { now: NOW, url: URL },
      { fetch: github.fetch }
    );
    while (holding) {
      await tick();
    }
    scanner.reset();
    await expect(scan).rejects.toMatchObject({ end: "reset" });
    held.resolve(new Response("{}"));
    await tick();
    expect(scanner.current).toBeUndefined();
    expect(scanner.running).toBe(false);
  });

  it("a source that ignores its signal and resolves late is never analysed", async () => {
    const scanner = createFileMapScanner();
    const late = deferred<Parameters<typeof fileMapDataset>[0]>();
    const events: string[] = [];
    const stale = scanner.scanSource(() => late.promise, {
      onProgress: (p) => events.push(label(p)),
    });
    scanner.reset();
    late.resolve({ files: { "package.json": "{}" }, now: NOW, root: "/late" });
    await expect(stale).rejects.toMatchObject({ end: "reset" });
    expect(events).toEqual([]);
    expect(scanner.current).toBeUndefined();
  });

  it("the caller's own signal cancels a download", async () => {
    const github = fakeGitHub({ "octo/demo": WORKSPACE });
    const controller = new AbortController();
    github.hook((url) => {
      if (url.host === "raw.githubusercontent.com") {
        controller.abort(new Error("caller aborted"));
        return new Promise<Response>(() => undefined);
      }
    });
    const scanner = createFileMapScanner();
    await expect(
      scanGitHubRepository(
        scanner,
        { now: NOW, url: URL },
        { fetch: github.fetch, signal: controller.signal }
      )
    ).rejects.toThrow("caller aborted");
    expect(scanner.running).toBe(false);
    expect(scanner.current).toBeUndefined();
  });
});

describe("analysis metadata versions", () => {
  it("still writes and reads a plain file map as version 1", async () => {
    const files = Object.fromEntries(
      Object.entries(WORKSPACE.commits[SHA] ?? {}).filter(
        ([, entry]) => typeof entry === "string"
      )
    ) as Record<string, string>;
    const dataset = await fileMapDataset({ files, now: NOW, root: "/plain" });
    const saved = JSON.parse(dataset.text(DATASET_ANALYSIS_FILE) ?? "{}");
    expect(saved.schemaVersion).toBe(3);
    expect(saved.origin).toEqual({
      command: "fileMapDataset",
      kind: "file-map",
      root: "/plain",
    });
    expect((await dataset.reader().analysis())?.schemaVersion).toBe(3);
  });

  const v2 = async (): Promise<{
    analysis: DatasetAnalysis;
    texts: Record<string, string>;
  }> => {
    const github = fakeGitHub({ "octo/demo": WORKSPACE });
    const { dataset } = await scanGitHubRepository(
      createFileMapScanner(),
      { now: NOW, url: URL },
      { fetch: github.fetch }
    );
    const texts = Object.fromEntries(
      dataset.paths.map((path) => [path, dataset.text(path) ?? ""])
    );
    return {
      analysis: JSON.parse(texts[DATASET_ANALYSIS_FILE] ?? "{}"),
      texts,
    };
  };

  const edited = async (edit: (analysis: Record<string, any>) => void) => {
    const { analysis, texts } = await v2();
    const copy = structuredClone(analysis) as Record<string, any>;
    edit(copy);
    return datasetReader(
      reloaded({ ...texts, [DATASET_ANALYSIS_FILE]: JSON.stringify(copy) })
    ).analysis();
  };

  it.each([
    [
      "an unknown version",
      (a: Record<string, any>) => {
        a.schemaVersion = 99;
      },
    ],
    [
      "a cruised graph under the recorded-graph version 2",
      (a: Record<string, any>) => {
        a.schemaVersion = 2;
      },
    ],
    [
      "a file-map origin under version 2",
      (a: Record<string, any>) => {
        a.schemaVersion = 2;
        a.capabilities.moduleGraph = RECORDED_GRAPH;
        a.origin = {
          command: a.origin.command,
          kind: "file-map",
          root: a.origin.root,
        };
      },
    ],
    [
      "a repository origin under version 1",
      (a: Record<string, any>) => {
        a.schemaVersion = 1;
        a.capabilities.moduleGraph = RECORDED_GRAPH;
      },
    ],
    [
      "a short commit",
      (a: Record<string, any>) => {
        a.origin.repository.resolvedCommit = "333";
      },
    ],
    [
      "an unknown limitation",
      (a: Record<string, any>) => {
        a.origin.acquisition.limitations.push("complete");
      },
    ],
    [
      "a third-party origin",
      (a: Record<string, any>) => {
        a.origin.acquisition.origins[1] = "https://cdn.jsdelivr.net";
      },
    ],
    [
      "an extra field",
      (a: Record<string, any>) => {
        a.origin.repository.token = "x";
      },
    ],
  ])("refuses %s", async (_label, edit) => {
    await expect(edited(edit)).rejects.toThrow(
      "analysis metadata is unreadable"
    );
  });

  it.each([
    [
      "a root other than its repository's",
      (a: Record<string, any>) => {
        a.origin.repository.repo = "other";
      },
      "the root of its repository and scope",
    ],
    [
      "a ref kind its requested ref contradicts",
      (a: Record<string, any>) => {
        a.origin.repository.refKind = "named";
      },
      'repository.refKind is "named"',
    ],
    [
      "a pinned SHA that is not the resolved commit",
      (a: Record<string, any>) => {
        a.origin.repository.refKind = "commit-sha";
        a.origin.repository.requestedRef =
          "4444444444444444444444444444444444444444";
      },
      "not the commit SHA that was requested",
    ],
  ])("refuses %s as contradicting itself", async (_label, edit, text) => {
    await expect(edited(edit)).rejects.toThrow(text);
  });

  it("reloads a version 2 repository graph as it was recorded, still checked", async () => {
    const legacy = (a: Record<string, any>) => {
      a.schemaVersion = 2;
      a.capabilities.moduleGraph = RECORDED_GRAPH;
    };
    const { analysis } = await v2();
    const expected = structuredClone(analysis) as Record<string, any>;
    legacy(expected);
    expect(await edited(legacy)).toEqual(expected);
    await expect(
      edited((a) => {
        legacy(a);
        a.origin.repository.repo = "other";
      })
    ).rejects.toThrow("the root of its repository and scope");
  });

  it("checks repository coordinates in the shared problem list", async () => {
    const { analysis } = await v2();
    const parsed = verifyDatasetAnalysis(analysis);
    expect(
      datasetAnalysisProblems(parsed, {
        generation: { command: "scanGitHubRepository" },
        packages: [],
        workspace: { root: "demo" },
      })
    ).toEqual([]);
  });
});
