import { resolve } from "node:path";
import { isGone, thisProcess } from "@foundry/lib/node/process-identity";
import { assertWebStandardExports } from "@foundry/lib/testing/seam";
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

const PACKAGE_DIR = resolve(import.meta.dirname, "../..");

describe("@foundry/scheduling runtime seams", () => {
  it("loads no node:* imports, ./node adapters, or unguarded Node/Bun globals from portable subpaths", () => {
    expect(() =>
      assertWebStandardExports(PACKAGE_DIR, [
        ".",
        "./client",
        "./queue",
        "./store",
        "./store/memory",
      ])
    ).not.toThrow();
  });

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
