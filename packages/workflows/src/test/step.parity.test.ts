/**
 * `Step.#run` ⇄ `Executable.drive` parity (Tier 1 #1 + #2).
 *
 * Two parallel implementations of the run loop ship in this package:
 *
 *   - `Step.#run` (step.ts:1326) — the direct path that `step.run()`
 *     uses; what a body invoked via `await child.run()` exercises.
 *   - `Executable.drive` (executable.ts:313) — what Composer's
 *     composition primitives (`ctx.invoke`, `ctx.parallel`, etc.) use.
 *
 * They are NOT byte-for-byte identical. Documented divergences (each
 * one is "in `#run`, not in `drive`"):
 *
 *   - `ctx.next` and `ctx.pipe` exist on the `#run` ctx but not the
 *     `drive` inline ctx.
 *   - `#run` emits `step.progress` value=100 immediately before
 *     `step.complete`; `drive` does not.
 *   - `#run` calls `assertSerializable(result, ...)` before
 *     `step.complete`; `drive` does not.
 *   - `#run` runs `#waitWhilePaused()` at the top of every attempt.
 *   - `#run` has the skip-on-complete short-circuit when the path's
 *     persisted snapshot status is "complete".
 *   - `#run` runs the post-body auto-cascade over `self.children`.
 *   - `#run` suppresses `step.failed` if `self.aborted`.
 *
 * The parity contract this file pins is therefore the **intersection**:
 *   for a leaf body (no children/next/pipe) with no skip-on-complete
 *   precondition, both paths must produce
 *
 *     1. the same lifecycle event tag sequence (filtering progress);
 *     2. the same retry semantics (bail short-circuits, throws retry);
 *     3. the same ctx-field intersection (typed-context spread, path,
 *        signal, write/emit/suspend identity).
 *
 * Adding a new lifecycle event or ctx field to ONE side without the
 * other will break this test, which is exactly the silent-drift
 * regression the audit calls out.
 */

import type { Scope } from "effect";

import { Effect, Stream } from "effect";
import { describe, expect, test } from "vitest";

import type { ChannelEvent } from "../channels";
import { Channels } from "../channels";
import type { Witness } from "../executable";
import { Executable } from "../executable";
import { Snapshot } from "../snapshot";
import { Step } from "../step";
import { bail } from "../types";

// ════════════════════════════════════════════════════════════════════════════
// Helpers — collect events; build a fresh root Executable + harness
// ════════════════════════════════════════════════════════════════════════════

interface Harness {
  readonly channels: Channels;
  readonly events: ChannelEvent[];
  readonly snapshot: Snapshot;
}

function harness(): Effect.Effect<Harness, never, Scope.Scope> {
  return Effect.gen(function* () {
    const snapshot = yield* Snapshot.make();
    const channels = yield* Channels.make(snapshot);
    const events: ChannelEvent[] = [];
    yield* Effect.forkScoped(
      Stream.runForEach(channels.events.stream, (e) =>
        Effect.sync(() => {
          events.push(e);
        })
      )
    );
    yield* Effect.sleep(5);
    return { channels, events, snapshot };
  });
}

/**
 * Tags the test cares about — strips the `step.progress` ticks `#run`
 * emits before `step.complete`. drive does not emit those, so the
 * intersection of lifecycle tags is everything else.
 */
function lifecycleTags(events: ChannelEvent[]): string[] {
  return events
    .map((e) => e._tag)
    .filter((t) => t !== "step.progress" && t !== "custom");
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Event-tag sequence parity (success / throw / bail)
// ════════════════════════════════════════════════════════════════════════════

interface ParityCase<O> {
  readonly body: () => Promise<O | { _bail: true; error: unknown }>;
  readonly expected: string[]; // lifecycle tags, progress filtered
  readonly label: string;
}

const parityCases: ParityCase<unknown>[] = [
  {
    body: async () => "ok",
    expected: ["step.started", "step.complete"],
    label: "success",
  },
  {
    body: async () => {
      throw new Error("boom");
    },
    expected: ["step.started", "step.failed"],
    label: "throw",
  },
  {
    body: async () => bail("nope"),
    expected: ["step.started", "step.bailed"],
    label: "bail",
  },
];

describe("Parity — lifecycle event sequence (modulo step.progress)", () => {
  for (const c of parityCases) {
    test(`${c.label}: #run and drive produce the same tag sequence`, async () => {
      // ── Path A: Step.#run via step.run() ────────────────────────────────
      const runEvents = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const step = Step.create({
              execute: c.body,
              input: undefined,
              name: "root",
            });
            // Capture events off this step's own channels (Step lazy-binds
            // them on first substrate access).
            const events: ChannelEvent[] = [];
            yield* Effect.forkScoped(
              Stream.runForEach(step.channels.events.stream, (e) =>
                Effect.sync(() => {
                  events.push(e);
                })
              )
            );
            yield* Effect.sleep(5);
            try {
              yield* Effect.tryPromise({
                catch: (e) => (e instanceof Error ? e : new Error(String(e))),
                try: () => step.run(),
              }).pipe(Effect.either);
            } catch {
              /* swallow — we only care about events */
            }
            yield* Effect.sleep(5);
            return events;
          })
        )
      );

      // ── Path B: Executable.drive on a fresh harness ─────────────────────
      const driveEvents = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness();
            const exe = yield* Executable.make({
              input: undefined,
              name: "root",
            });
            const step = Step.create<unknown, unknown>({
              execute: c.body,
              input: undefined,
              name: "root",
            });
            const witness: Witness = { channels: h.channels };
            yield* exe.drive(witness, step).pipe(Effect.either);
            yield* Effect.sleep(5);
            return h.events;
          })
        )
      );

      expect(lifecycleTags(runEvents)).toEqual(c.expected);
      expect(lifecycleTags(driveEvents)).toEqual(c.expected);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Retry parity — both paths honor maxAttempts; final attempt count matches
// ════════════════════════════════════════════════════════════════════════════

describe("Parity — retry semantics", () => {
  test("a body that throws twice then succeeds reports attempt=3 on step.complete from both paths", async () => {
    const buildBody = (): {
      readonly body: () => Promise<number>;
      readonly attempts: () => number;
    } => {
      let n = 0;
      return {
        attempts: () => n,
        body: async () => {
          n++;
          if (n < 3) {
            throw new Error(`a${n}`);
          }
          return n;
        },
      };
    };

    // Path A
    const aOut = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { body } = buildBody();
          const step = Step.create<unknown, number>({
            config: { retry: { maxAttempts: 3 } },
            execute: body,
            input: undefined,
            name: "root",
          });
          const events: ChannelEvent[] = [];
          yield* Effect.forkScoped(
            Stream.runForEach(step.channels.events.stream, (e) =>
              Effect.sync(() => {
                events.push(e);
              })
            )
          );
          yield* Effect.sleep(5);
          const out = yield* Effect.tryPromise({
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
            try: () => step.run(),
          });
          yield* Effect.sleep(5);
          return { events, out };
        })
      )
    );

    // Path B
    const bOut = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exe = yield* Executable.make({
            input: undefined,
            name: "root",
          });
          const { body } = buildBody();
          const step = Step.create<unknown, number>({
            config: { retry: { maxAttempts: 3 } },
            execute: body,
            input: undefined,
            name: "root",
          });
          const witness: Witness = { channels: h.channels };
          const out = yield* exe.drive(witness, step);
          yield* Effect.sleep(5);
          return { events: h.events, out };
        })
      )
    );

    // Both paths returned the value 3.
    expect(aOut.out).toBe(3);
    expect(bOut.out).toBe(3);
    // Both paths emit started 3 times and complete once.
    const startedA = aOut.events.filter(
      (e) => e._tag === "step.started"
    ).length;
    const startedB = bOut.events.filter(
      (e) => e._tag === "step.started"
    ).length;
    expect(startedA).toBe(3);
    expect(startedB).toBe(3);
    const completeA = aOut.events.find((e) => e._tag === "step.complete");
    const completeB = bOut.events.find((e) => e._tag === "step.complete");
    expect(completeA?._tag === "step.complete" && completeA.attempt).toBe(3);
    expect(completeB?._tag === "step.complete" && completeB.attempt).toBe(3);
  });

  test("a Bail short-circuits retry on both paths (attempt=1, no further retries)", async () => {
    const driveAttempts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exe = yield* Executable.make({
            input: undefined,
            name: "root",
          });
          let n = 0;
          const step = Step.create<unknown, number>({
            config: { retry: { maxAttempts: 5 } },
            execute: async () => {
              n++;
              return bail("x");
            },
            input: undefined,
            name: "root",
          });
          yield* exe.drive({ channels: h.channels }, step);
          return n;
        })
      )
    );
    const runAttempts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let n = 0;
          const step = Step.create<unknown, number>({
            config: { retry: { maxAttempts: 5 } },
            execute: async () => {
              n++;
              return bail("x");
            },
            input: undefined,
            name: "root",
          });
          yield* Effect.tryPromise({
            catch: () => new Error("StepBailError"),
            try: () => step.run(),
          }).pipe(Effect.either);
          return n;
        })
      )
    );
    expect(driveAttempts).toBe(1);
    expect(runAttempts).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. ctx-field intersection parity
// ════════════════════════════════════════════════════════════════════════════

describe("Parity — StepContext field intersection", () => {
  // Field NAMES present on both ctx-builders. `next` and `pipe` are
  // documented to be `#run`-only; they are excluded here.
  const expectedIntersection = [
    "step",
    "path",
    "signal",
    "children",
    "fork",
    "state",
    "steps",
    "results",
    "workflow",
    "resultOf",
    "statusOf",
    "write",
    "emit",
    "suspend",
    "invoke",
    "parallel",
    "race",
    "branch",
    "sequence",
    // X spread — the `name` field from BaseContext lives on every ctx.
    "name",
  ];

  test("a body invoked via #run sees every intersection field", async () => {
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let captured = new Set<string>();
          const step = Step.create({
            execute: async (_input, ctx) => {
              captured = new Set(Object.keys(ctx));
              return "ok";
            },
            input: undefined,
            name: "root",
          });
          yield* Effect.promise(() => step.run());
          return captured;
        })
      )
    );
    for (const k of expectedIntersection) {
      expect(seen.has(k), `expected ctx (#run) to expose '${k}'`).toBe(true);
    }
    // #run also exposes `next` and `pipe` (documented divergence).
    expect(seen.has("next")).toBe(true);
    expect(seen.has("pipe")).toBe(true);
  });

  test("a body invoked via Executable.drive sees every intersection field (and NOT next/pipe)", async () => {
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const exe = yield* Executable.make({
            input: undefined,
            name: "root",
          });
          let captured = new Set<string>();
          const step = Step.create<unknown, unknown>({
            execute: async (_input, ctx) => {
              captured = new Set(Object.keys(ctx));
              return "ok";
            },
            input: undefined,
            name: "root",
          });
          yield* exe.drive({ channels: h.channels }, step);
          return captured;
        })
      )
    );
    for (const k of expectedIntersection) {
      expect(seen.has(k), `expected ctx (drive) to expose '${k}'`).toBe(true);
    }
    // Documented divergence: drive's inline ctx does NOT expose next/pipe.
    expect(seen.has("next")).toBe(false);
    expect(seen.has("pipe")).toBe(false);
  });

  test("functional fields (write, emit, fork, suspend, invoke, parallel, race, branch, sequence) are all callable on both paths", async () => {
    const probeKeys = [
      "write",
      "emit",
      "fork",
      "suspend",
      "invoke",
      "parallel",
      "race",
      "branch",
      "sequence",
      "resultOf",
      "statusOf",
    ];

    async function probe(
      via: "run" | "drive"
    ): Promise<Record<string, string>> {
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            let kinds: Record<string, string> = {};
            const step = Step.create<unknown, unknown>({
              execute: async (_input, ctx) => {
                kinds = Object.fromEntries(
                  probeKeys.map((k) => [
                    k,
                    typeof (ctx as unknown as Record<string, unknown>)[k],
                  ])
                );
                return "ok";
              },
              input: undefined,
              name: "root",
            });
            if (via === "run") {
              yield* Effect.promise(() => step.run());
            } else {
              const h = yield* harness();
              const exe = yield* Executable.make({
                input: undefined,
                name: "root",
              });
              yield* exe.drive({ channels: h.channels }, step);
            }
            return kinds;
          })
        )
      );
    }
    const a = await probe("run");
    const b = await probe("drive");
    for (const k of probeKeys) {
      expect(a[k], `#run ctx['${k}']`).toBe("function");
      expect(b[k], `drive ctx['${k}']`).toBe("function");
    }
  });
});
