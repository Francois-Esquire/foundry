import { describe, expect, it } from "vitest";

import type { GatedTurn } from "../../harness/turn-gate";
import { createTurnGate } from "../../harness/turn-gate";

describe("createTurnGate", () => {
  it("admits one turn until its message settles", async () => {
    const gate = createTurnGate("Harness");
    let finish: () => void = () => undefined;
    const message = new Promise<void>((resolve) => {
      finish = () => resolve();
    });
    let first: GatedTurn | undefined;
    gate.run(undefined, (turn) => {
      first = turn;
      return { message };
    });
    expect(() => gate.run(undefined, () => ({ message }))).toThrow("one turn");
    expect(gate.active).toBe(true);
    finish();
    await message;
    expect(first?.isActive()).toBe(false);
    expect(gate.active).toBe(false);
  });

  it("releases the gate when the turn body throws synchronously", () => {
    const gate = createTurnGate("Coding");
    expect(() =>
      gate.run(undefined, () => {
        throw new Error("start failed");
      })
    ).toThrow("start failed");
    expect(gate.active).toBe(false);
    expect(() =>
      gate.run(undefined, () => ({ message: Promise.resolve() }))
    ).not.toThrow();
  });

  it("aborts the active turn on interrupt and close, then rejects new turns", async () => {
    const gate = createTurnGate("Coding");
    let active: GatedTurn | undefined;
    gate.run(new AbortController().signal, (turn) => {
      active = turn;
      return { message: Promise.resolve() };
    });
    gate.interrupt();
    expect(active?.signal.reason).toEqual(
      new Error("Coding turn interrupted.")
    );
    await gate.close();
    expect(() =>
      gate.run(undefined, () => ({ message: Promise.resolve() }))
    ).toThrow("Coding session is closed.");
  });
});
