import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isGone, thisProcess } from "@foundry/lib/node/process-identity";
import { Effect, Layer, Ref, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import {
  createNodeSchedulerClient,
  nodeSchedulerLayer,
  nodeSchedulerOptions,
} from "../node";
import { Scheduler } from "../scheduler";
import { ScheduleStore } from "../store/index";
import { MemoryScheduleStore } from "../store/memory";
import { fakeDispatch, target, testScheduler } from "./helpers/scheduler";

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
      const targetSpecifier = match[1] ?? match[2] ?? "";
      if (!targetSpecifier.startsWith(".")) {
        packages.add(targetSpecifier);
        continue;
      }
      const base = resolve(dirname(file), targetSpecifier);
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

describe("@foundry/scheduling runtime seams", () => {
  for (const [label, entry, expectedFile] of [
    ["base entry", "index.ts", "scheduler.ts"],
    ["client entry", "client.ts", "client.ts"],
    ["queue adapter entry", "queue.ts", "queue.ts"],
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

  it("defaults portable Scheduler.layer to conservative liveness for foreign owners", async () => {
    const foreign = { pid: 999_999, started: "foreign" } as const;
    const submitted = await testScheduler((scheduler, dispatch) =>
      Effect.gen(function* () {
        const store = yield* ScheduleStore;
        yield* scheduler.register({
          cadence: { at: 1000, kind: "once" },
          id: "launch",
          target,
        });
        yield* store.claim({
          id: "launch:1000",
          scheduledFor: 1000,
          scheduleId: "launch",
          state: {
            claimedAt: 0,
            kind: "claimed",
            lease: { claimedAt: 0, owner: foreign },
          },
        });
        yield* TestClock.adjust(1000);
        return yield* Ref.get(dispatch.submitted);
      })
    );
    expect(submitted).toEqual([]);
  });

  it("fills Node process identity and liveness defaults in ./node helpers", async () => {
    const custom = { pid: 42, started: "custom" } as const;
    const customGone = () => false;
    expect(nodeSchedulerOptions()).toEqual({
      identity: thisProcess(),
      isOwnerGone: isGone,
    });
    expect(
      nodeSchedulerOptions({ identity: custom, isOwnerGone: customGone })
    ).toEqual({
      identity: custom,
      isOwnerGone: customGone,
    });

    const dispatch = await Effect.runPromise(fakeDispatch);
    const listed = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(Scheduler, (scheduler) => scheduler.list)
      ).pipe(
        Effect.provide(
          nodeSchedulerLayer().pipe(
            Layer.provide(Layer.merge(dispatch.layer, MemoryScheduleStore))
          )
        )
      )
    );
    expect(listed).toEqual([]);

    const client = createNodeSchedulerClient({ dispatch: dispatch.layer });
    try {
      expect(await client.list()).toEqual([]);
    } finally {
      await client.dispose();
    }
  });
});
