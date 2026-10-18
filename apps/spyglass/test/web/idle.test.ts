import { afterEach, expect, it, vi } from "vitest";
import { runIdle } from "../../src/web/scene/idle";

afterEach(() => vi.unstubAllGlobals());

/** A browser whose idle periods are handed out by the test, each with the time it says remains. */
function stubIdle() {
  const queue = new Map<number, IdleRequestCallback>();
  let sequence = 0;
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    sequence += 1;
    queue.set(sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelIdleCallback", (id: number) => queue.delete(id));
  return {
    period(remaining: number[]) {
      const [id, callback] = [...queue].at(-1) ?? [];
      queue.delete(id ?? 0);
      callback?.({
        didTimeout: false,
        timeRemaining: () => remaining.shift() ?? 0,
      });
    },
    get waiting() {
      return queue.size;
    },
  };
}

it("runs as many steps as each idle period allows, and calls done after the last", () => {
  const idle = stubIdle();
  const ran: number[] = [];
  const done = vi.fn();
  function* steps() {
    for (let i = 0; i < 5; i += 1) {
      ran.push(i);
      yield;
    }
  }
  runIdle(steps(), done);
  expect(idle.waiting).toBe(1);
  // Two steps fit before the period's time runs out; the rest wait.
  idle.period([5, 0]);
  expect(ran).toEqual([0, 1]);
  expect(done).not.toHaveBeenCalled();
  expect(idle.waiting).toBe(1);
  idle.period([5, 5, 5, 5, 5]);
  expect(ran).toEqual([0, 1, 2, 3, 4]);
  expect(done).toHaveBeenCalledTimes(1);
  expect(idle.waiting).toBe(0);
});

it("stops when cancelled and never calls done", () => {
  const idle = stubIdle();
  const ran: number[] = [];
  const done = vi.fn();
  function* steps() {
    for (let i = 0; i < 3; i += 1) {
      ran.push(i);
      yield;
    }
  }
  const cancel = runIdle(steps(), done);
  idle.period([5, 0]);
  cancel();
  expect(idle.waiting).toBe(0);
  expect(ran).toEqual([0, 1]);
  expect(done).not.toHaveBeenCalled();
});

it("falls back to a timer where the browser has no idle callback", async () => {
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.stubGlobal("cancelIdleCallback", undefined);
  const done = vi.fn();
  let ran = 0;
  function* steps() {
    while (ran < 3) {
      ran += 1;
      yield;
    }
  }
  runIdle(steps(), done);
  expect(ran).toBe(0);
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  expect(ran).toBe(3);
  expect(done).toHaveBeenCalledTimes(1);
});
