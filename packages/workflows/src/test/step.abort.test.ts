/**
 * Step — the abort surface, end-to-end.
 *
 * Consolidates `step.bind.test.ts` (local effects, onAbort handler
 * registration, cascade across forks) and `step.aborted.test.ts`
 * (channel-event emission, pre-aborted short-circuit, mid-flight
 * suppression of `step.failed`, post-complete substrate cascade).
 *
 * Sections:
 *   A. step.abort — local effects (flag flip, signal abort, reason).
 *   B. step.abort — channel event emission (event shape, idempotency,
 *      no-flip-on-terminal, isTerminal projection).
 *   C. step.onAbort — handler registration (sync, registered-after,
 *      reason argument, throwing-handler-doesn't-poison-siblings).
 *   D. step.run — pre-aborted short-circuit + mid-flight suppression
 *      of step.failed + unrelated-failure-still-emits-failed control.
 *   E. Cascade across forks — declared children, sibling roots,
 *      deeply nested in-flight execute, post-complete dynamic child.
 */

import { describe, expect, it } from "vitest";

import type { StepSpec, Step as StepType } from "../step";

import { Step } from "../step";
import { collectEvents } from "./helpers/streams";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const makeStep = (name = "x"): Promise<Step> =>
  Step.make<unknown, unknown>({
    execute: async () => undefined,
    input: undefined,
    name,
  });

// ════════════════════════════════════════════════════════════════════════════
// A. step.abort — local effects
// ════════════════════════════════════════════════════════════════════════════

describe("step.abort — local effects", () => {
  it("aborted is false and signal is not aborted before abort()", async () => {
    const step = await makeStep();
    expect(step.aborted).toBe(false);
    expect(step.signal.aborted).toBe(false);
  });

  it("abort(reason) flips aborted, aborts the signal, and records the reason", async () => {
    const step = await makeStep();
    step.abort({ code: "stop", message: "user-cancelled" });
    expect(step.aborted).toBe(true);
    expect(step.signal.aborted).toBe(true);
    expect(step.reason).toEqual({ code: "stop", message: "user-cancelled" });
  });

  it("calling abort() twice with different reasons preserves the first reason", async () => {
    const step = await makeStep();
    step.abort("first");
    step.abort("second");
    expect(step.reason).toBe("first");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. step.abort — channel-event emission and projection
// ════════════════════════════════════════════════════════════════════════════

describe("step.abort — event emission + projection", () => {
  it("emits step.aborted and projects status to 'aborted' / isTerminal=true", async () => {
    const step = await makeStep();
    expect(step.isTerminal).toBe(false);
    step.abort("user-cancelled");
    await sleep(10);
    expect(step.status).toBe("aborted");
    expect(step.isTerminal).toBe(true);
  });

  it("step.aborted event carries the abort reason", async () => {
    const step = await makeStep();
    const sink = collectEvents(step);
    await sleep(5);
    step.abort({ code: 42, msg: "user-cancelled" });
    await sleep(10);
    sink.stop();
    const aborted = sink.events.filter((e) => e._tag === "step.aborted");
    expect(aborted).toHaveLength(1);
    const e = aborted[0];
    if (e?._tag === "step.aborted") {
      expect(e.reason).toEqual({ code: 42, msg: "user-cancelled" });
    }
  });

  it("is idempotent — repeated abort() does not re-emit step.aborted", async () => {
    const step = await makeStep();
    const sink = collectEvents(step);
    await sleep(5);
    step.abort("first");
    await sleep(10);
    step.abort("second");
    step.abort("third");
    await sleep(20);
    sink.stop();
    const count = sink.events.filter((e) => e._tag === "step.aborted").length;
    expect(count).toBe(1);
    expect(step.status).toBe("aborted");
  });

  it("does not flip a terminal 'complete' step's status to 'aborted'", async () => {
    const step = await Step.make({
      execute: async () => "ok",
      input: undefined,
      name: "x",
    });
    await step.run();
    await sleep(10);
    expect(step.status).toBe("complete");
    step.abort("too-late");
    await sleep(10);
    expect(step.status).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. step.onAbort — handler registration
// ════════════════════════════════════════════════════════════════════════════

describe("step.onAbort — handler registration", () => {
  it("a handler registered before abort() runs synchronously on abort()", async () => {
    const step = await makeStep();
    let fired = false;
    step.onAbort(() => {
      fired = true;
    });
    step.abort("go");
    expect(fired).toBe(true);
  });

  it("a handler registered after abort() runs on the next microtask", async () => {
    const step = await makeStep();
    step.abort("first");
    let fired = false;
    step.onAbort(() => {
      fired = true;
    });
    // EventTarget fires registered-after-abort handlers asynchronously.
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toBe(true);
  });

  it("the handler receives the abort reason", async () => {
    const step = await makeStep();
    let captured: unknown = null;
    step.onAbort((reason) => {
      captured = reason;
    });
    step.abort({ code: 7 });
    expect(captured).toEqual({ code: 7 });
  });

  it("a throwing handler does not prevent siblings from running", async () => {
    const step = await makeStep();
    const fired: string[] = [];
    step.onAbort(() => {
      fired.push("a");
    });
    step.onAbort(() => {
      fired.push("b");
      throw new Error("kaboom");
    });
    step.onAbort(() => {
      fired.push("c");
    });
    expect(() => {
      step.abort();
    }).not.toThrow();
    expect(fired).toEqual(["a", "b", "c"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. step.run interaction with abort
// ════════════════════════════════════════════════════════════════════════════

describe("step.run() interaction with abort", () => {
  it("pre-aborted run does not call execute, fires no started/complete, ends 'aborted'", async () => {
    let calls = 0;
    const step = await Step.make({
      execute: async () => {
        calls++;
        return "should not run";
      },
      input: undefined,
      name: "x",
    });
    const sink = collectEvents(step);
    await sleep(5);
    step.abort();
    await sleep(10);
    const result = await step.run();
    expect(result).toBeUndefined();
    expect(calls).toBe(0);
    expect(step.status).toBe("aborted");
    await sleep(20);
    sink.stop();
    expect(sink.events.filter((e) => e._tag === "step.started")).toHaveLength(
      0
    );
    expect(sink.events.filter((e) => e._tag === "step.complete")).toHaveLength(
      0
    );
  });

  it("mid-flight abort suppresses step.failed; run ends 'aborted'", async () => {
    const stepHolder: { current: StepType<void, void> | undefined } = {
      current: undefined,
    };
    const step = await Step.make<void, void>({
      execute: () =>
        new Promise<void>((_resolve, reject) => {
          const current = stepHolder.current;
          if (!current) {
            reject(new Error("stepRef not initialized"));
            return;
          }
          const onAbort = (): void => {
            current.signal.removeEventListener("abort", onAbort);
            reject(new Error("AbortError"));
          };
          if (current.signal.aborted) {
            reject(new Error("AbortError"));
            return;
          }
          current.signal.addEventListener("abort", onAbort);
        }),
      input: undefined,
      name: "x",
    });
    stepHolder.current = step;

    const sink = collectEvents(step);
    await sleep(5);

    const settled = step.run();
    await sleep(20);
    step.abort("mid-flight");
    await settled.catch(() => undefined);
    await sleep(20);
    sink.stop();

    expect(step.status).toBe("aborted");
    expect(sink.events.filter((e) => e._tag === "step.failed")).toHaveLength(0);
    expect(sink.events.filter((e) => e._tag === "step.aborted")).toHaveLength(
      1
    );
  });

  it("an unrelated execute error still emits step.failed (no spurious suppression)", async () => {
    const step = await Step.make({
      execute: async () => {
        throw new Error("kaboom");
      },
      input: undefined,
      name: "x",
    });
    const sink = collectEvents(step);
    await sleep(5);
    await step.run().catch(() => undefined);
    await sleep(20);
    sink.stop();
    expect(step.status).toBe("failed");
    expect(step.aborted).toBe(false);
    expect(sink.events.filter((e) => e._tag === "step.failed")).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E. Cascade across forks
// ════════════════════════════════════════════════════════════════════════════

describe("Abort cascade across forks", () => {
  it("parent.abort() cascades to every declared descendant via the shared signal", async () => {
    const parent = await Step.make({
      children: [
        {
          execute: async () => undefined,
          input: undefined,
          name: "c1",
        },
        {
          children: [
            {
              execute: async () => undefined,
              input: undefined,
              name: "g1",
            },
          ],
          execute: async () => undefined,
          input: undefined,
          name: "c2",
        },
      ],
      execute: async () => undefined,
      input: undefined,
      name: "p",
    });
    const [c1, c2] = parent.children;
    if (!(c1 && c2)) {
      throw new Error("expected children");
    }
    const grand = c2.children[0];
    if (!grand) {
      throw new Error("expected grandchild");
    }

    parent.abort("root");
    expect(parent.aborted).toBe(true);
    expect(c1.aborted).toBe(true);
    expect(c2.aborted).toBe(true);
    expect(grand.aborted).toBe(true);
  });

  it("sibling root steps don't share a signal — abort on one leaves the other alone", async () => {
    // The "downward only" intent applies to fresh sub-Steps that aren't
    // forked from a parent. Forked children share the parent's substrate
    // AbortController; independent roots do not.
    const a = await makeStep("a");
    const b = await makeStep("b");
    a.abort("a-only");
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(false);
  });

  it("a deeply nested in-flight execute is interrupted when the root aborts", async () => {
    const grandHolder: { current: StepType | undefined } = {
      current: undefined,
    };
    let grandRejected = false;
    const parent = await Step.make({
      children: [
        {
          children: [
            {
              execute: () =>
                new Promise<void>((_resolve, reject) => {
                  const g = grandHolder.current;
                  if (!g) {
                    reject(new Error("no grand ref"));
                    return;
                  }
                  if (g.signal.aborted) {
                    grandRejected = true;
                    reject(new Error("AbortError"));
                    return;
                  }
                  g.signal.addEventListener(
                    "abort",
                    () => {
                      grandRejected = true;
                      reject(new Error("AbortError"));
                    },
                    { once: true }
                  );
                }),
              input: undefined,
              name: "g",
            },
          ],
          execute: async (_input, ctx) => {
            const g = ctx.children[0];
            if (!g) {
              throw new Error("expected grandchild");
            }
            await g.run();
          },
          input: undefined,
          name: "c",
        },
      ],
      execute: async (_input, ctx) => {
        const c = ctx.children[0];
        if (!c) {
          throw new Error("expected child");
        }
        await c.run();
      },
      input: undefined,
      name: "p",
    });
    grandHolder.current = parent.children[0]?.children[0];
    if (!grandHolder.current) {
      throw new Error("grandchild not materialized");
    }

    const settled = parent.run();
    await sleep(20);
    parent.abort("root-cancel");
    await settled.catch(() => undefined);
    await sleep(10);

    expect(grandRejected).toBe(true);
    expect(grandHolder.current.aborted).toBe(true);
  });

  it("parent.abort() after parent completes still aborts a dynamic child", async () => {
    // Substrate-cascade judgment call: executable.abort always fires through
    // forked children, even when the parent has reached a terminal status.
    // eslint-disable-next-line prefer-const -- captured by parentSpec.execute closure; assigned after Step.make
    let parentRef: StepType<void, "ok"> | undefined;
    let dynRef: StepType | undefined;

    const parentSpec: StepSpec<void, "ok"> = {
      execute: async (): Promise<"ok"> => {
        if (!parentRef) {
          throw new Error("parentRef not initialized");
        }
        const dyn = parentRef.fork<unknown, unknown>({
          execute: async () => 1,
          input: undefined,
          name: "dyn",
        });
        dynRef = dyn;
        await dyn.run();
        return "ok";
      },
      input: undefined,
      name: "parent",
    };

    const parent = await Step.make(parentSpec);
    parentRef = parent;
    await parent.run();
    await sleep(10);

    expect(parent.status).toBe("complete");
    expect(parent.isTerminal).toBe(true);
    if (!dynRef) {
      throw new Error("expected dynamic child to be created");
    }
    expect(dynRef.aborted).toBe(false);

    parent.abort("cascade-after-complete");
    await sleep(10);

    expect(dynRef.aborted).toBe(true);
    expect(parent.status).toBe("complete");
  });
});
