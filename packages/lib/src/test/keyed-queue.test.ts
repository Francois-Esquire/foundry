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
});
