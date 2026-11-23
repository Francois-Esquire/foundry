import { describe, expect, test } from "vitest";
import { progressOf } from "../src/game/progress";
import { scorecardOf } from "../src/game/scorecard";
import type { Effort } from "../src/model/context";
import type { Encounter, Todo } from "../src/model/thread";
import { encounter, STARTED, step, tool } from "./helpers/encounters";

const LIMIT = 200_000;

function done(count: number): Todo[] {
  return Array.from({ length: count }, (_, index) => ({
    added: false,
    id: `todo-${index + 1}`,
    status: "success",
    title: `Step ${index + 1}`,
  }));
}

function bare(overrides: Partial<Encounter> = {}): Encounter {
  return encounter({
    endedAt: STARTED + 30_000,
    loadout: { effort: "high", model: "opus" },
    outcome: "finished",
    steps: [
      step({
        tools: [tool("tool-1", "error")],
        usage: { input: 300_000, output: 10_000 },
      }),
    ],
    todos: done(1),
    ...overrides,
  });
}

function light(overrides: Partial<Encounter> = {}): Encounter {
  return bare({
    plan: { input: 1000, output: 100 },
    steps: [
      step({ tools: [tool("tool-1")], usage: { input: 8000, output: 400 } }),
      step({ usage: { input: 6000, output: 300 } }),
    ],
    todos: done(2),
    ...overrides,
  });
}

function labels(card: ReturnType<typeof scorecardOf>) {
  return card.items.map(({ amount, label }) => `${label} ${amount}`);
}

describe("facts", () => {
  test("are read from the encounter's own record", () => {
    const card = scorecardOf(
      light({
        steps: [
          step({
            tools: [tool("tool-1"), tool("tool-2", "error")],
            usage: { input: 9000, output: 1000 },
          }),
        ],
        todos: [
          ...done(1),
          { ...done(1)[0], id: "todo-2", status: "error" } as Todo,
        ],
      }),
      null,
      LIMIT
    );
    expect(card.facts).toEqual({
      calls: 2,
      duration: 30_000,
      failedCalls: 1,
      finished: 1,
      left: 0.98,
      loadout: { effort: "high", model: "opus" },
      outcome: "finished",
      steps: 2,
      swapped: false,
      tokens: { input: 10_000, output: 1100 },
    });
  });
});

describe("verdicts", () => {
  test("no verdict yet banks nothing and has no rank", () => {
    const card = scorecardOf(light(), null, LIMIT);
    expect(card).toMatchObject({
      items: [],
      rank: null,
      total: 0,
      verdict: null,
    });
  });

  test("a rejected encounter banks nothing, however good it was", () => {
    const card = scorecardOf(
      light({ loadout: { effort: "low", model: "haiku" } }),
      "reject",
      LIMIT
    );
    expect(card).toMatchObject({
      items: [],
      rank: "C",
      total: 0,
      verdict: "reject",
    });
  });

  test("a bare accept earns the base and its steps, and ranks low", () => {
    const card = scorecardOf(bare(), "accept", LIMIT);
    expect(labels(card)).toEqual(["Accepted 50", "Steps done 10"]);
    expect(card.total).toBe(60);
    expect(card.rank).toBe("C");
  });
});

describe("rules", () => {
  test("each finished step adds to the award", () => {
    const card = scorecardOf(bare({ todos: done(4) }), "accept", LIMIT);
    expect(labels(card)).toContain("Steps done 40");
  });

  test("a clean run needs no failed tool call", () => {
    const clean = bare({
      steps: [
        step({
          tools: [tool("tool-1")],
          usage: { input: 300_000, output: 10_000 },
        }),
      ],
    });
    expect(labels(scorecardOf(clean, "accept", LIMIT))).toContain(
      "Clean run 25"
    );
    expect(labels(scorecardOf(bare(), "accept", LIMIT))).not.toContain(
      "Clean run 25"
    );
  });

  test("a light touch leaves at least 60% of the window", () => {
    const at = (input: number) =>
      labels(
        scorecardOf(
          bare({
            steps: [
              step({
                tools: [tool("tool-1", "error")],
                usage: { input, output: 0 },
              }),
            ],
          }),
          "accept",
          LIMIT
        )
      );
    expect(at(160_000)).toContain("Light touch 20");
    expect(at(160_002)).not.toContain("Light touch 20");
  });

  test("light touch is withheld when the encounter switched to a fresh pairing", () => {
    const items = labels(
      scorecardOf(bare({ steps: [], swapped: true }), "accept", LIMIT)
    );
    expect(items).not.toContain("Light touch 20");
  });

  test("a skipped encounter banks nothing and has no rank", () => {
    const skipped = scorecardOf(bare(), "skip", LIMIT);
    expect(skipped.total).toBe(0);
    expect(skipped.rank).toBeNull();
  });

  test("a lighter model earns more: haiku over sonnet over opus", () => {
    const awarded = (model: string) =>
      scorecardOf(
        bare({ loadout: { effort: "high", model } }),
        "accept",
        LIMIT
      ).items.find((item) => item.label === "Lighter model")?.amount ?? 0;
    expect([awarded("haiku"), awarded("sonnet"), awarded("opus")]).toEqual([
      30, 15, 0,
    ]);
    expect(awarded("a model the rules do not know")).toBe(0);
  });

  test("less effort earns more: low over medium over high", () => {
    const spared = (effort: Effort) =>
      scorecardOf(
        bare({ loadout: { effort, model: "opus" } }),
        "accept",
        LIMIT
      ).items.find((item) => item.label === "Less effort")?.amount ?? 0;
    expect([spared("low"), spared("medium"), spared("high")]).toEqual([
      20, 10, 0,
    ]);
  });

  test("under par needs fewer tokens than a par that grows with the steps", () => {
    const usage = (input: number, steps: number) =>
      labels(
        scorecardOf(
          bare({
            steps: [
              step({
                tools: [tool("tool-1", "error")],
                usage: { input, output: 0 },
              }),
            ],
            todos: done(steps),
          }),
          "accept",
          LIMIT
        )
      );
    expect(usage(29_999, 1)).toContain("Under par 25");
    expect(usage(30_000, 1)).not.toContain("Under par 25");
    expect(usage(49_999, 2)).toContain("Under par 25");
  });

  test("a cheap, clean, light run reaches S", () => {
    const card = scorecardOf(
      light({ loadout: { effort: "low", model: "haiku" } }),
      "accept",
      LIMIT
    );
    expect(labels(card)).toEqual([
      "Accepted 50",
      "Steps done 20",
      "Clean run 25",
      "Light touch 20",
      "Lighter model 30",
      "Less effort 20",
      "Under par 25",
    ]);
    expect(card.total).toBe(190);
    expect(card.rank).toBe("S");
  });

  test("ranks step down with the total", () => {
    const rank = (overrides: Partial<Encounter>) =>
      scorecardOf(light(overrides), "accept", LIMIT).rank;
    expect(rank({ loadout: { effort: "high", model: "opus" } })).toBe("A");
    expect(
      rank({
        steps: [
          step({
            tools: [tool("tool-1", "error")],
            usage: { input: 8000, output: 400 },
          }),
        ],
      })
    ).toBe("B");
  });

  test("the total is the sum of the line items", () => {
    for (const card of [
      scorecardOf(light(), "accept", LIMIT),
      scorecardOf(bare(), "accept", LIMIT),
      scorecardOf(light({ outcome: "failed" }), "accept", LIMIT),
    ]) {
      expect(card.total).toBe(
        card.items.reduce((sum, item) => sum + item.amount, 0)
      );
    }
  });
});

describe("a failed encounter", () => {
  test("accepted, it is capped at the consolation with a line that says so", () => {
    const card = scorecardOf(
      light({ error: "stopped", outcome: "failed" }),
      "accept",
      LIMIT
    );
    expect(labels(card).at(-1)).toBe("Failed run -105");
    expect(labels(card)).not.toContain("Clean run 25");
    expect(card.total).toBe(10);
    expect(card.rank).toBe("C");
  });

  test("rejected, it banks nothing", () => {
    expect(
      scorecardOf(light({ outcome: "failed" }), "reject", LIMIT).total
    ).toBe(0);
  });
});

describe("progress", () => {
  const accepted = (times: number) =>
    Array.from({ length: times }, () =>
      scorecardOf(
        light({ loadout: { effort: "low", model: "haiku" } }),
        "accept",
        LIMIT
      )
    );

  test("starts at level 1 with nothing banked", () => {
    expect(progressOf([])).toEqual({ into: 0, level: 1, needed: 100, xp: 0 });
  });

  test("each level needs a hundred more than the last", () => {
    expect(progressOf(accepted(1))).toEqual({
      into: 90,
      level: 2,
      needed: 200,
      xp: 190,
    });
    expect(progressOf(accepted(4))).toEqual({
      into: 160,
      level: 4,
      needed: 400,
      xp: 760,
    });
  });

  test("unjudged and rejected encounters add nothing", () => {
    expect(
      progressOf([
        ...accepted(1),
        scorecardOf(light(), null, LIMIT),
        scorecardOf(light(), "reject", LIMIT),
      ]).xp
    ).toBe(190);
  });
});
