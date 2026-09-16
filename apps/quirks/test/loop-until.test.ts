import { Step } from "@foundry/workflows/step";
import { describe, expect, it } from "vitest";

import { loopUntil } from "~/workflows/loop-until";

interface Attempt {
  readonly value: number;
}

/** Body under test: increments, so `until` can settle on a known round. */
class Increment extends Step<Attempt, Attempt> {
  readonly definitionKey = "test.increment";
  rounds = 0;

  protected execute(input: Attempt): Promise<Attempt> {
    this.rounds += 1;
    return Promise.resolve({ value: input.value + 1 });
  }
}

describe("loopUntil", () => {
  it("stops the round `until` is satisfied", async () => {
    const body = new Increment();
    const loop = loopUntil<Attempt, Attempt>({
      body,
      maxRounds: 10,
      next: ({ output }) => output,
      until: ({ output }) => output.value >= 3,
    });

    await expect(loop.run({ value: 0 })).resolves.toEqual({
      output: { value: 3 },
      rounds: 3,
      settled: true,
    });
    expect(body.rounds).toBe(3);
  });

  it("gives up at maxRounds and reports unsettled", async () => {
    const body = new Increment();
    const loop = loopUntil<Attempt, Attempt>({
      body,
      maxRounds: 2,
      next: ({ output }) => output,
      until: () => false,
    });

    await expect(loop.run({ value: 0 })).resolves.toEqual({
      output: { value: 2 },
      rounds: 2,
      settled: false,
    });
  });

  it("runs the body once when it settles immediately", async () => {
    const body = new Increment();
    const loop = loopUntil<Attempt, Attempt>({
      body,
      maxRounds: 5,
      next: ({ output }) => output,
      until: () => true,
    });

    await expect(loop.run({ value: 0 })).resolves.toMatchObject({ rounds: 1 });
    expect(body.rounds).toBe(1);
  });

  it("rejects a maxRounds below one", () => {
    expect(() =>
      loopUntil<Attempt, Attempt>({
        body: new Increment(),
        maxRounds: 0,
        next: ({ output }) => output,
        until: () => true,
      })
    ).toThrow("maxRounds");
  });
});
