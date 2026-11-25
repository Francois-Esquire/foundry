import { resolve } from "node:path";
import { isGone, thisProcess } from "@foundry/lib/node/process-identity";
import { assertWebStandardExports } from "@foundry/lib/testing/seam";
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

const PACKAGE_DIR = resolve(import.meta.dirname, "../..");

describe("@foundry/queue runtime seams", () => {
  it("loads no node:* imports, ./node adapters, or unguarded Node/Bun globals from portable subpaths", () => {
    expect(() =>
      assertWebStandardExports(PACKAGE_DIR, [
        ".",
        "./client",
        "./store",
        "./store/memory",
        "./testing/store",
      ])
    ).not.toThrow();
  });

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
