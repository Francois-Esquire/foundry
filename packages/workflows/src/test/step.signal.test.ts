import { describe, expect, it } from "vitest";

import { Step } from "../step";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Fetch-style mock: resolves after `ms`, OR rejects with an AbortError
 * if `signal` aborts first. Mirrors the contract of `fetch`/`setTimeout`-
 * with-signal so we can pin the hand-off case without a real network call.
 */
function delayWithSignal(ms: number, signal: AbortSignal): Promise<"ok"> {
  return new Promise<"ok">((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("ok");
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort);
  });
}

describe("ctx.signal — identity", () => {
  it("ctx.signal === step.signal (no shadow, no fork)", async () => {
    let captured: AbortSignal | undefined;
    const step = await Step.make<void, "ok">({
      execute: async (_input, ctx): Promise<"ok"> => {
        captured = ctx.signal;
        return "ok";
      },
      input: undefined,
      name: "identity",
    });
    await step.run();
    expect(captured).toBe(step.signal);
  });
});

describe("ctx.signal — pre-aborted state", () => {
  it("if step.abort() is called before run(), the body never opens", async () => {
    // Confirms the existing short-circuit: a pre-aborted step skips
    // execute() entirely. Used as the baseline for the next test.
    let opened = false;
    const step = await Step.make<void, "ok">({
      execute: async (): Promise<"ok"> => {
        opened = true;
        return "ok";
      },
      input: undefined,
      name: "pre-aborted",
    });
    step.abort("pre-run");
    await step.run().catch(() => undefined);
    expect(opened).toBe(false);
    expect(step.status).toBe("aborted");
  });
});

describe("ctx.signal — mid-flight abort", () => {
  it("ctx.signal.aborted flips to true when step.abort() fires externally", async () => {
    let observedAbortedAfterAwait = false;
    const step = await Step.make<void, void>({
      execute: async (_input, ctx) => {
        // Resume after abort to observe the signal state inside the body.
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true }
          );
        });
        observedAbortedAfterAwait = ctx.signal.aborted;
      },
      input: undefined,
      name: "mid-flight-flip",
    });

    const settled = step.run();
    await sleep(10);
    step.abort("external");
    await settled.catch(() => undefined);

    expect(observedAbortedAfterAwait).toBe(true);
  });

  it("addEventListener('abort') registered inside the body fires on external abort", async () => {
    let listenerFired = false;
    const step = await Step.make<void, void>({
      execute: async (_input, ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            listenerFired = true;
            resolve();
          });
        });
      },
      input: undefined,
      name: "listener-fires",
    });

    const settled = step.run();
    await sleep(10);
    step.abort("external");
    await settled.catch(() => undefined);

    expect(listenerFired).toBe(true);
  });
});

describe("ctx.signal — fetch-style hand-off", () => {
  it("delayWithSignal(100ms, ctx.signal) rejects with AbortError when step is aborted", async () => {
    let caught: unknown;
    const step = await Step.make<void, void>({
      execute: async (_input, ctx) => {
        try {
          await delayWithSignal(500, ctx.signal);
        } catch (err) {
          caught = err;
        }
      },
      input: undefined,
      name: "handoff",
    });

    const settled = step.run();
    await sleep(10);
    step.abort("external");
    await settled.catch(() => undefined);

    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
  });

  it("delayWithSignal completes normally when no abort fires", async () => {
    let result: "ok" | "err" | undefined;
    const step = await Step.make<void, "ok">({
      execute: async (_input, ctx): Promise<"ok"> => {
        try {
          result = await delayWithSignal(10, ctx.signal);
        } catch {
          result = "err";
        }
        return "ok";
      },
      input: undefined,
      name: "no-abort",
    });
    await step.run();
    expect(result).toBe("ok");
  });
});

describe("ctx.signal — generator body", () => {
  it("ctx.signal === step.signal inside an async generator body", async () => {
    let captured: AbortSignal | undefined;
    const step = await Step.make<void, "ok">({
      async *execute(_input, ctx): AsyncGenerator<unknown, "ok", unknown> {
        captured = ctx.signal;
        yield "tick";
        return "ok";
      },
      input: undefined,
      name: "gen-identity",
    });
    await step.run();
    expect(captured).toBe(step.signal);
  });

  it("listener registered inside generator body fires on external abort", async () => {
    let listenerFired = false;
    const step = await Step.make<void, void>({
      async *execute(_input, ctx) {
        ctx.signal.addEventListener("abort", () => {
          listenerFired = true;
        });
        // Park until abort
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true }
          );
        });
        yield "after-abort";
      },
      input: undefined,
      name: "gen-listener",
    });

    const settled = step.run();
    await sleep(10);
    step.abort("external");
    await settled.catch(() => undefined);

    expect(listenerFired).toBe(true);
  });
});
