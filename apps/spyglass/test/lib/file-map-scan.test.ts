import { describe, expect, it } from "vitest";
import { datasetReader } from "../../src/lib/dataset";
import { DATASET_ANALYSIS_FILE } from "../../src/lib/dataset-layout";
import type { FileMapDatasetInput } from "../../src/lib/file-map-dataset";
import { fileMapDataset } from "../../src/lib/file-map-dataset";
import type {
  FileMapScanProgress,
  FileMapSource,
} from "../../src/lib/file-map-scanner";
import {
  createFileMapScanner,
  FileMapScanAbortedError,
} from "../../src/lib/file-map-scanner";

const ROOT = "/spyglass-file-map-scan";
const NOW = new Date("2026-11-07T00:00:00Z");

const MAP: FileMapDatasetInput = {
  files: {
    "package.json": JSON.stringify({
      name: "scan-root",
      private: true,
      workspaces: ["packages/*"],
    }),
    "packages/a/package.json": JSON.stringify({
      exports: { ".": "./src/index.ts" },
      name: "@scan/a",
    }),
    "packages/a/src/index.ts": [
      'import { missing } from "undeclared-dep";',
      'import { gone } from "./gone";',
      "export const a = (): unknown => [missing, gone];",
      "",
    ].join("\n"),
    "packages/a/src/legacy.js": "module.exports = 1;\n",
    "packages/b/package.json": JSON.stringify({
      exports: { ".": "./src/index.ts" },
      name: "@scan/b",
    }),
    "packages/b/src/index.ts":
      'import { a } from "@scan/a";\nexport const b = () => a();\n',
  },
  now: NOW,
  root: ROOT,
};

const ASSEMBLY_STEPS = [
  "ingest",
  "intelligence",
  "project",
  "write",
  "lenses",
  "visualization",
];

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

function untilAborted(signal: AbortSignal): Promise<FileMapDatasetInput> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function reloaded(texts: Record<string, string>) {
  const copy = JSON.parse(JSON.stringify(texts)) as Record<string, string>;
  return (path: string) => {
    const text = copy[path];
    return Promise.resolve(text === undefined ? undefined : JSON.parse(text));
  };
}

describe("saved analysis metadata", () => {
  it("survives serialization: unavailable history, missing types, unresolved imports and the graph source", async () => {
    const dataset = await fileMapDataset(MAP);
    const texts = Object.fromEntries(
      dataset.paths.map((path) => [path, dataset.text(path) ?? ""])
    );
    const analysis = await datasetReader(reloaded(texts)).analysis();
    expect(analysis).toEqual({
      capabilities: dataset.capabilities,
      origin: { command: "fileMapDataset", kind: "file-map", root: ROOT },
      provenance: {
        inputsFingerprint: "unrecorded",
        internals: "not-assembled",
      },
      schemaVersion: 3,
    });
    expect(analysis?.capabilities.history.available).toBe(false);
    expect(analysis?.capabilities.types.unresolvedPackages).toEqual([
      "undeclared-dep",
    ]);
    expect(analysis?.capabilities.moduleGraph.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ specifier: "undeclared-dep" }),
        expect.objectContaining({ specifier: "./gone" }),
      ])
    );
    expect(analysis?.capabilities.moduleGraph.source).toBe(
      "dependency-cruiser"
    );
  });

  it("is owned per read: mutating one answer changes neither the dataset nor another read", async () => {
    const dataset = await fileMapDataset(MAP);
    const first = await dataset.reader().analysis();
    if (first === undefined) {
      throw new Error("no analysis metadata");
    }
    first.capabilities.types.unresolvedPackages.push("mutated");
    expect(
      (await dataset.reader().analysis())?.capabilities.types.unresolvedPackages
    ).toEqual(["undeclared-dep"]);
    expect(dataset.capabilities.types.unresolvedPackages).toEqual([
      "undeclared-dep",
    ]);
  });

  it("is absent from a dataset without it and refused when unreadable", async () => {
    const dataset = await fileMapDataset(MAP);
    const texts = Object.fromEntries(
      dataset.paths.map((path) => [path, dataset.text(path) ?? ""])
    );
    const { [DATASET_ANALYSIS_FILE]: saved, ...without } = texts;
    expect(saved).toBeDefined();
    expect(await datasetReader(reloaded(without)).analysis()).toBeUndefined();
    const unsupported = JSON.stringify({
      ...JSON.parse(saved ?? "{}"),
      schemaVersion: 2,
    });
    await expect(
      datasetReader(
        reloaded({ ...texts, [DATASET_ANALYSIS_FILE]: unsupported })
      ).analysis()
    ).rejects.toThrow("unsupported schema version");
    const claimed = JSON.parse(saved ?? "{}");
    claimed.capabilities.history.available = true;
    await expect(
      datasetReader(
        reloaded({ ...texts, [DATASET_ANALYSIS_FILE]: JSON.stringify(claimed) })
      ).analysis()
    ).rejects.toThrow("analysis metadata is unreadable");
  });
});

describe("fileMapDataset lifecycle", () => {
  it("reports every real step in order and yields at every boundary", async () => {
    const events: string[] = [];
    let yields = 0;
    await fileMapDataset(MAP, {
      onProgress: (progress) => events.push(label(progress)),
      yieldTask: () => {
        yields += 1;
        events.push("yield");
        return Promise.resolve();
      },
    });
    expect(events).toEqual([
      "prepare:start",
      "prepare:end",
      "yield",
      "analyze:packages/a:start",
      "analyze:packages/a:end",
      "yield",
      "analyze:packages/b:start",
      "analyze:packages/b:end",
      "yield",
      "derive:start",
      "derive:end",
      ...ASSEMBLY_STEPS.flatMap((step) => ["yield", `assemble:${step}`]),
    ]);
    expect(yields).toBe(9);
  });

  it("gives other macrotasks the event loop between steps by default", async () => {
    const events: string[] = [];
    await fileMapDataset(MAP, {
      onProgress: (progress) => {
        events.push(label(progress));
        if (progress.phase === "prepare" && progress.stage === "end") {
          setTimeout(() => events.push("timer"), 0);
        }
      },
    });
    expect(events.indexOf("timer")).toBe(events.indexOf("prepare:end") + 1);
  });

  it("times the whole operation from a clock read before preparation", async () => {
    const events: string[] = [];
    const reads: Date[] = [];
    const clock = () => {
      const at = new Date(Date.UTC(2026, 10, 8) + reads.length * 1000);
      reads.push(at);
      events.push("clock");
      return at;
    };
    const dataset = await fileMapDataset(MAP, {
      clock,
      onProgress: (progress) => events.push(label(progress)),
    });
    expect(events.slice(0, 2)).toEqual(["clock", "prepare:start"]);
    const { generation } = dataset.manifest;
    expect(generation.startedAt).toBe(reads[0]?.toISOString());
    expect(generation.finishedAt).toBe(reads.at(-1)?.toISOString());
    expect(generation.totalDurationMs).toBe(
      (reads.at(-1)?.getTime() ?? 0) - (reads[0]?.getTime() ?? 0)
    );
    expect(generation.phases.map((phase) => phase.name)).toEqual([
      "discover",
      "analyze",
      "derive",
      ...ASSEMBLY_STEPS,
    ]);
    const { assemblyMs, scanMs } = dataset.timing;
    expect(typeof assemblyMs).toBe("number");
    expect(scanMs).toBeGreaterThanOrEqual(Number(assemblyMs));
  });

  it("refuses an already-aborted signal before any work", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);
    const events: string[] = [];
    await expect(
      fileMapDataset(MAP, {
        onProgress: (progress) => events.push(label(progress)),
        signal: controller.signal,
      })
    ).rejects.toBe(reason);
    expect(events).toEqual([]);
  });

  it("lets a synchronous step finish and stops at the next boundary", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    await expect(
      fileMapDataset(MAP, {
        onProgress: (progress) => {
          events.push(label(progress));
          if (progress.phase === "prepare" && progress.stage === "start") {
            controller.abort(new Error("stopped during preparation"));
          }
        },
        signal: controller.signal,
      })
    ).rejects.toThrow("stopped during preparation");
    expect(events).toEqual(["prepare:start", "prepare:end"]);
  });

  it("stops between packages and during a yield", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    await expect(
      fileMapDataset(MAP, {
        onProgress: (progress) => events.push(label(progress)),
        signal: controller.signal,
        yieldTask: () => {
          if (events.at(-1) === "analyze:packages/a:end") {
            controller.abort(new Error("stopped in a yield"));
          }
          return Promise.resolve();
        },
      })
    ).rejects.toThrow("stopped in a yield");
    expect(events.at(-1)).toBe("analyze:packages/a:end");
  });

  it("stops before an assembly phase", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    await expect(
      fileMapDataset(MAP, {
        onProgress: (progress) => {
          events.push(label(progress));
          if (label(progress) === "assemble:project") {
            controller.abort(new Error("stopped in assembly"));
          }
        },
        signal: controller.signal,
      })
    ).rejects.toThrow("stopped in assembly");
    expect(events.at(-1)).toBe("assemble:project");
  });
});

describe("createFileMapScanner", () => {
  it("publishes a finished scan and drops it on reset", async () => {
    const scanner = createFileMapScanner();
    const scan = scanner.scan(MAP);
    expect(scanner.running).toBe(true);
    const dataset = await scan;
    expect(scanner.current).toBe(dataset);
    expect(scanner.running).toBe(false);
    scanner.reset();
    expect(scanner.current).toBeUndefined();
  });

  it("lets a replacing scan abort the running one, which never reports or publishes again", async () => {
    const scanner = createFileMapScanner();
    const first: string[] = [];
    let replacement: ReturnType<typeof scanner.scan> | undefined;
    const original = scanner.scan(MAP, {
      onProgress: (progress) => {
        first.push(label(progress));
        if (progress.phase === "prepare" && progress.stage === "end") {
          replacement = scanner.scan({ ...MAP, command: "replacement" });
        }
      },
    });
    const error = await original.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FileMapScanAbortedError);
    expect((error as FileMapScanAbortedError).end).toBe("replaced");
    expect(first).toEqual(["prepare:start", "prepare:end"]);
    const published = await replacement;
    expect(published?.manifest.generation.command).toBe("replacement");
    expect(scanner.current).toBe(published);
  });

  it("never publishes a scan whose last step finishes after it was replaced", async () => {
    const scanner = createFileMapScanner();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let steps = 0;
    const stale = scanner.scan(MAP, {
      yieldTask: () => {
        steps += 1;

        return steps === 9 ? held : Promise.resolve();
      },
    });
    while (steps < 9) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const replacement = scanner.scan({ ...MAP, command: "replacement" });
    release?.();
    await expect(stale).rejects.toBeInstanceOf(FileMapScanAbortedError);
    const published = await replacement;
    expect(scanner.current).toBe(published);
    expect(published.manifest.generation.command).toBe("replacement");
  });

  it("rejects a reset scan and keeps nothing", async () => {
    const scanner = createFileMapScanner();
    const events: string[] = [];
    const scan = scanner.scan(MAP, {
      onProgress: (progress) => {
        events.push(label(progress));
        if (label(progress) === "derive:end") {
          scanner.reset();
        }
      },
    });
    const error = await scan.catch((caught: unknown) => caught);
    expect((error as FileMapScanAbortedError).end).toBe("reset");
    expect(events.at(-1)).toBe("derive:end");
    expect(scanner.current).toBeUndefined();
    expect(scanner.running).toBe(false);
  });

  it("keeps a scan started from an abort listener as the one current scan", async () => {
    const scanner = createFileMapScanner();
    const signals: Record<string, AbortSignal> = {};

    const pending =
      (name: string, onAbort?: () => void): FileMapSource =>
      ({ signal }) => {
        signals[name] = signal;
        if (onAbort !== undefined) {
          signal.addEventListener("abort", onAbort);
        }
        return untilAborted(signal);
      };
    let late: Promise<unknown> | undefined;

    const first = scanner
      .scanSource(
        pending("a", () => {
          late = scanner.scanSource(pending("c")).catch((error) => error);
        })
      )
      .catch((error: unknown) => error);
    await Promise.resolve();
    const second = scanner.scanSource(pending("b"));
    expect((await first) as FileMapScanAbortedError).toBeInstanceOf(
      FileMapScanAbortedError
    );
    await expect(second).rejects.toMatchObject({ end: "replaced" });

    expect(scanner.running).toBe(true);
    expect(signals.c?.aborted).toBe(false);
    scanner.reset();
    expect(signals.c?.aborted).toBe(true);
    expect(scanner.running).toBe(false);
    expect(((await late) as FileMapScanAbortedError).end).toBe("reset");
  });

  it("lets a scan started from a reset's abort listener run", async () => {
    const scanner = createFileMapScanner();
    let restartedSignal: AbortSignal | undefined;
    const restarted: FileMapSource = ({ signal }) => {
      restartedSignal = signal;
      return untilAborted(signal);
    };
    let late: Promise<unknown> | undefined;
    const first = scanner
      .scanSource(({ signal }) => {
        signal.addEventListener("abort", () => {
          late = scanner.scanSource(restarted).catch((error) => error);
        });
        return untilAborted(signal);
      })
      .catch((error: unknown) => error);
    await Promise.resolve();
    scanner.reset();
    expect(((await first) as FileMapScanAbortedError).end).toBe("reset");
    expect(scanner.running).toBe(true);
    expect(restartedSignal?.aborted).toBe(false);
    scanner.reset();
    expect(restartedSignal?.aborted).toBe(true);
    expect(((await late) as FileMapScanAbortedError).end).toBe("reset");
  });

  it("honours the caller's own signal", async () => {
    const scanner = createFileMapScanner();
    const controller = new AbortController();
    const scan = scanner.scan(MAP, {
      onProgress: (progress) => {
        if (progress.phase === "derive") {
          controller.abort(new Error("caller stopped"));
        }
      },
      signal: controller.signal,
    });
    await expect(scan).rejects.toThrow("caller stopped");
    expect(scanner.current).toBeUndefined();
    expect(scanner.running).toBe(false);
  });
});
