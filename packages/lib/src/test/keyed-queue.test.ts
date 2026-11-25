import { describe, expect, it } from "vitest";

import { KeyedQueue } from "../keyed-queue";

describe("KeyedQueue", () => {
  it("runs one key's operations in call order, other keys alongside", async () => {
    const queue = new KeyedQueue();
    const order: string[] = [];
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();

    const first = queue.run("a", async () => {
      await gate;
      order.push("a1");
    });
    const second = queue.run("a", () => {
      order.push("a2");
      return Promise.resolve();
    });
    await queue.run("b", () => {
      order.push("b1");
      return Promise.resolve();
    });
    open();
    await Promise.all([first, second]);

    expect(order).toEqual(["b1", "a1", "a2"]);
  });

  it("keeps going after a failed operation", async () => {
    const queue = new KeyedQueue();
    const failed = queue.run("a", () => Promise.reject(new Error("boom")));
    const next = queue.run("a", () => Promise.resolve("ran"));

    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ran");
  });

  it("serialises operations on non-string keys", async () => {
    const queue = new KeyedQueue<number>();
    const order: string[] = [];
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();

    const first = queue.run(1, async () => {
      await gate;
      order.push("one-a");
    });
    const second = queue.run(1, () => {
      order.push("one-b");
      return Promise.resolve();
    });
    await queue.run(2, () => {
      order.push("two");
      return Promise.resolve();
    });
    open();
    await Promise.all([first, second]);

    expect(order).toEqual(["two", "one-a", "one-b"]);
  });

  it("waits in idle until every key has drained", async () => {
    const queue = new KeyedQueue();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    let finished = 0;

    const a = queue.run("a", async () => {
      await gate;
      finished += 1;
    });
    const b = queue.run("b", async () => {
      await gate;
      finished += 1;
    });
    const idle = queue.idle();
    open();
    await idle;

    expect(finished).toBe(2);
    await Promise.all([a, b]);
  });

  it("resolves idle immediately when nothing is queued", async () => {
    await expect(new KeyedQueue().idle()).resolves.toBeUndefined();
  });
});
