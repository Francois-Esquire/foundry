import { expect, test } from "vitest";
import { occupancyOf } from "../src/model/occupancy";
import type { Step, ToolUse } from "../src/model/thread";
import { stepsOf } from "../src/model/thread";
import { threads } from "../stories/fixtures/threads";

const LIMIT = 200_000;

function tool(id: string): ToolUse {
  return { detail: "", id, name: "Read", startedAt: 0, status: "success" };
}

function worked(input: number, output: number, tools = 0): Step {
  return {
    streaming: false,
    text: "",
    title: "A step",
    tools: Array.from({ length: tools }, (_, index) => tool(`tool-${index}`)),
    usage: { input, output },
  };
}

test("the estimate is the last step's input spread over its model calls, plus its output", () => {
  expect(occupancyOf([worked(30_000, 1000)], LIMIT).tokens).toBe(31_000);
  expect(occupancyOf([worked(30_000, 1000, 2)], LIMIT).tokens).toBe(11_000);
  expect(occupancyOf([worked(10_000, 0, 2)], LIMIT).tokens).toBe(3333);
  expect(occupancyOf([worked(10_001, 0, 5)], LIMIT).tokens).toBe(1667);
});

test("the latest step with usage counts, even from an earlier encounter", () => {
  const unfinished: Step = { ...worked(0, 0), usage: null };
  expect(
    occupancyOf([worked(90_000, 0), worked(30_000, 0), unfinished], LIMIT)
      .tokens
  ).toBe(30_000);
  expect(occupancyOf(stepsOf(threads.working), LIMIT)).toEqual({
    health: "scuffed",
    left: 138_000,
    tokens: 62_000,
    used: 0.31,
  });
});

test("no usage yet leaves the window fresh and full", () => {
  expect(occupancyOf([], LIMIT)).toEqual({
    health: "fresh",
    left: LIMIT,
    tokens: 0,
    used: 0,
  });
});

test("use is kept between none and all of the window", () => {
  const over = occupancyOf([worked(900_000, 0)], LIMIT);
  expect(over.used).toBe(1);
  expect(over.left).toBe(0);
  expect(over.health).toBe("critical");
  expect(occupancyOf([worked(1000, 0)], 0)).toMatchObject({
    left: 0,
    used: 0,
  });
});

test("health falls as the context fills", () => {
  expect(
    [0, 0.2, 0.3, 0.5, 0.7, 0.9, 1].map(
      (share) => occupancyOf([worked(share * LIMIT, 0)], LIMIT).health
    )
  ).toEqual([
    "fresh",
    "fresh",
    "scuffed",
    "hurt",
    "battered",
    "critical",
    "critical",
  ]);
});
