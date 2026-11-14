import { describe, expect, test } from "vitest";
import { ReentrantCallError, Turns } from "../turns";

const advice = "use the view you were given";

describe("Turns", () => {
  test("runs operations one at a time, in call order, past a failure", async () => {
    const turns = new Turns(advice);
    const order: string[] = [];
    const step = (name: string, fail = false) =>
      turns.run(async () => {
        order.push(`${name} start`);
        await Promise.resolve();
        order.push(`${name} end`);
        if (fail) {
          throw new Error(name);
        }
        return name;
      });

    const results = await Promise.allSettled([
      step("a"),
      step("b", true),
      step("c"),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect(order).toEqual([
      "a start",
      "a end",
      "b start",
      "b end",
      "c start",
      "c end",
    ]);
  });

  test("refuses a call from inside the running operation, at once", async () => {
    const turns = new Turns(advice);
    const inner = await turns.run(async () => {
      await Promise.resolve();
      return turns.run(() => Promise.resolve("never")).catch((error) => error);
    });

    expect(inner).toBeInstanceOf(ReentrantCallError);
    expect((inner as Error).message).toBe(advice);
    await expect(turns.run(() => Promise.resolve("after"))).resolves.toBe(
      "after"
    );
  });

  test("refuses a call from a callback the operation awaits", async () => {
    const turns = new Turns(advice);
    const hook = () => turns.run(() => Promise.resolve("never"));
    await expect(
      turns.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return hook();
      })
    ).rejects.toBeInstanceOf(ReentrantCallError);
  });

  test("queues a concurrent caller, and a callback that runs after the turn", async () => {
    const turns = new Turns(advice);
    const { promise: ended, resolve: end } = Promise.withResolvers<void>();
    let later: Promise<string> | undefined;
    const order: string[] = [];

    const first = turns.run(async () => {
      later = ended.then(() => turns.run(() => Promise.resolve("later")));
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("first");
    });
    const concurrent = turns.run(() => {
      order.push("concurrent");
      return Promise.resolve();
    });
    await Promise.all([first, concurrent]);
    end();

    expect(order).toEqual(["first", "concurrent"]);
    await expect(later).resolves.toBe("later");
  });
});
