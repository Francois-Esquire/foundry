import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isGone, thisProcess } from "@foundry/lib/node/process-identity";
import { Effect, Layer, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import {
  createNodeQueueClient,
  nodeQueueLayer,
  nodeQueueOptions,
} from "../node";
import { Queue } from "../queue";
import { QueueStore } from "../store/index";
import { makeMemoryQueueStore } from "../store/memory";
import { flush, handler, sharedStore, withQueue } from "./helpers/queue";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT =
  /(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/g;
const IMPORT_PATH = /from\s+["'][^"']+["']/g;
const NODE_GLOBALS =
  /\b(?:process|Buffer|Bun|__dirname|__filename|setImmediate)\b/;

function graph(entry: string): {
  files: string[];
  packages: Set<string>;
  sources: Map<string, string>;
} {
  const files: string[] = [];
  const packages = new Set<string>();
  const sources = new Map<string, string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.includes(file)) {
      continue;
    }
    files.push(file);
    const raw = readFileSync(file, "utf8");
    sources.set(relative(SRC, file), raw);
    for (const match of raw.matchAll(IMPORT)) {
      const target = match[1] ?? match[2] ?? "";
      if (!target.startsWith(".")) {
        packages.add(target);
        continue;
      }
      const base = resolve(dirname(file), target);
      const found = [`${base}.ts`, join(base, "index.ts")].find(existsSync);
      if (found) {
        pending.push(found);
      }
    }
  }
  return {
    files: files.map((file) => relative(SRC, file)),
    packages,
    sources,
  };
}

describe("@foundry/queue runtime seams", () => {
  for (const [label, entry, expectedFile] of [
    ["base entry", "index.ts", "queue.ts"],
    ["client entry", "client.ts", "client.ts"],
    ["store entry", "store/index.ts", "store/index.ts"],
    ["memory store entry", "store/memory.ts", "store/memory.ts"],
  ] as const) {
    it(`loads no node:* imports, @foundry/lib/node/* imports, or Node globals from the ${label}`, () => {
      const { files, packages, sources } = graph(join(SRC, entry));
      expect(files).not.toContain("node.ts");
      expect([...packages].filter((name) => name.startsWith("node:"))).toEqual(
        []
      );
      expect(
        [...packages].filter((name) => name.startsWith("@foundry/lib/node"))
      ).toEqual([]);
      expect(files).toContain(expectedFile);
      for (const [file, source] of sources) {
        expect(
          source.replace(IMPORT_PATH, ""),
          `${file} should not reference Node globals`
        ).not.toMatch(NODE_GLOBALS);
      }
    });
  }

  it("defaults portable recovery to conservative liveness while honoring QueueOptions.isOwnerGone and per-call overrides", async () => {
    const store = await sharedStore();
    const foreign = { pid: 999_999, started: "foreign" } as const;
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withQueue(store, { identity: foreign }, (queue) =>
          Effect.gen(function* () {
            yield* queue.register("work", () => Effect.never);
            yield* queue.submit({ handler });
            yield* flush;
          })
        );
        const conservative = yield* withQueue(store, {}, (queue) =>
          queue.recover()
        );
        const configured = yield* withQueue(
          store,
          { isOwnerGone: (owner) => owner.started === foreign.started },
          (queue) =>
            Effect.gen(function* () {
              const overridden = yield* queue.recover({
                isOwnerGone: () => false,
              });
              const recovered = yield* queue.recover();
              return { overridden, recovered };
            })
        );
        return { conservative, ...configured };
      }).pipe(Effect.provide(TestContext.TestContext))
    );
    expect(summary.conservative.interrupted).toEqual([]);
    expect(summary.overridden.interrupted).toEqual([]);
    expect(summary.recovered.interrupted).toHaveLength(1);
  });

  it("fills Node process identity and liveness defaults in ./node helpers", async () => {
    const custom = { pid: 42, started: "custom" } as const;
    const customGone = () => false;
    expect(nodeQueueOptions()).toEqual({
      identity: thisProcess(),
      isOwnerGone: isGone,
    });
    expect(
      nodeQueueOptions({ identity: custom, isOwnerGone: customGone })
    ).toEqual({
      identity: custom,
      isOwnerGone: customGone,
    });

    const store = await Effect.runPromise(makeMemoryQueueStore);
    const layerSummary = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(Queue, (queue) => queue.recover())).pipe(
        Effect.provide(
          nodeQueueLayer().pipe(Layer.provide(Layer.succeed(QueueStore, store)))
        )
      )
    );
    expect(layerSummary).toEqual({ adopted: [], interrupted: [] });

    const client = createNodeQueueClient({
      store: Layer.succeed(QueueStore, store),
    });
    try {
      expect(await client.recover()).toEqual({ adopted: [], interrupted: [] });
    } finally {
      await client.dispose();
    }
  });
});
