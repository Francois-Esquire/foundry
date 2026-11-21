import { describe, expect, test } from "vitest";
import { slotsOf } from "../src/model/context";
import { quipFor } from "../src/model/quip";
import { adjust, focusOn, refocus, startRail } from "../src/model/rail";
import { fitSteps } from "../src/model/steps";
import {
  compactCount,
  contextUsed,
  emptyThread,
  type Todo,
  toolTallies,
} from "../src/model/thread";
import { context, threads } from "../stories/fixtures/threads";

const STOPS = ["avatar", "model", "effort", "slot"] as const;
const around = { avatars: 3, context };

function statusAt(index: number, running: number) {
  if (index === running) {
    return "running";
  }
  return index < running ? "success" : "pending";
}

function todos(count: number, running: number): Todo[] {
  return Array.from({ length: count }, (_, index) => ({
    added: false,
    id: `todo-${index + 1}`,
    status: statusAt(index, running),
    title: `Step number ${index + 1} of the plan`,
  }));
}

function widthOf({ after, before, steps }: ReturnType<typeof fitSteps>) {
  const chips = steps.reduce(
    (sum, step) =>
      sum +
      4 +
      String(step.number).length +
      (step.label === "" ? 0 : step.label.length + 1),
    0
  );
  const more = (before > 0 ? 3 : 0) + (after > 0 ? 3 : 0);
  return chips + Math.max(steps.length - 1, 0) * 2 + more;
}

describe("steps", () => {
  test.each([120, 80, 60, 44, 30, 20])(
    "eight steps fit %i columns",
    (width) => {
      const row = fitSteps(todos(8, 3), width);
      expect(widthOf(row)).toBeLessThanOrEqual(width);
      expect(row.steps.map((step) => step.number)).toContain(4);
      expect(row.before + row.steps.length + row.after).toBe(8);
    }
  );

  test("the running step keeps its title first", () => {
    const row = fitSteps(todos(8, 3), 80);
    expect(row.steps[3]?.label).toBe("Step number 4 of the plan");
    expect(row.before + row.after).toBe(0);
  });

  test("a tight row windows around the running step", () => {
    const row = fitSteps(todos(8, 6), 30);
    expect(row.before).toBeGreaterThan(0);
    expect(row.steps.map((step) => step.number)).toContain(7);
  });

  test("a wide row shows every title in full", () => {
    const row = fitSteps(threads.working.todos, 200);
    expect(row.steps.map((step) => step.label)).toEqual(
      threads.working.todos.map((todo) => todo.title)
    );
  });
});

test("tools are tallied by name, most used first", () => {
  expect(toolTallies(threads.idle)).toEqual([]);
  expect(toolTallies(threads.working)).toEqual([
    { count: 1, failed: 0, name: "Skill", running: false },
    { count: 1, failed: 0, name: "Read", running: false },
    { count: 1, failed: 0, name: "Bash", running: true },
  ]);
  expect(toolTallies(threads.failed)).toEqual([
    { count: 1, failed: 1, name: "Read", running: false },
  ]);
});

test("context use is a share of the window, kept between none and all", () => {
  expect(contextUsed(emptyThread, 200_000)).toBe(0);
  expect(contextUsed(threads.working, 200_000)).toBeCloseTo(0.31);
  expect(contextUsed({ ...emptyThread, context: 900_000 }, 200_000)).toBe(1);
  expect(contextUsed(threads.working, 0)).toBe(0);
});

test("counts shorten past a thousand", () => {
  expect([0, 912, 18_400, 200_000].map(compactCount)).toEqual([
    "0",
    "912",
    "18.4k",
    "200k",
  ]);
});

test("the comment follows the phase, the health and a failure", () => {
  expect(quipFor(threads.idle, "fresh")).toBe("ready when you are");
  expect(quipFor(threads.planning, "fresh")).toBe("sizing it up");
  expect(quipFor(threads.working, "scuffed")).toBe("working the list");
  expect(quipFor(threads.done, "critical")).toBe("context almost gone");
  expect(quipFor(threads.failed, "battered")).toBe("that one got away");
});

test("the loadout lists skills, then MCP servers", () => {
  expect(slotsOf(context).map(({ kind, name }) => `${kind} ${name}`)).toEqual([
    "skill task-notes",
    "mcp backlog",
  ]);
});

describe("the rail", () => {
  const rail = startRail(context);

  test("starts on the first gun with medium ammo", () => {
    expect(rail).toMatchObject({
      avatar: 0,
      effort: "medium",
      focus: "model",
      model: "sonnet",
    });
  });

  test("Tab moves the focus round the stops both ways", () => {
    expect(refocus(rail, STOPS, false).focus).toBe("effort");
    expect(refocus(rail, STOPS, true).focus).toBe("avatar");
    expect(refocus({ ...rail, focus: "slot" }, STOPS, false).focus).toBe(
      "avatar"
    );
    expect(refocus(rail, [], false)).toBe(rail);
  });

  test("a hidden stop falls back to the first one shown", () => {
    expect(focusOn({ ...rail, focus: "slot" }, ["avatar", "model"])).toBe(
      "avatar"
    );
  });

  test("the gun and the avatar wrap round", () => {
    expect(adjust(rail, STOPS, 1, around).model).toBe("opus");
    expect(adjust(rail, STOPS, -1, around).model).toBe("haiku");
    expect(adjust({ ...rail, focus: "avatar" }, STOPS, -1, around).avatar).toBe(
      2
    );
  });

  test("Up loads ammo, Down drops it, and both stop at the ends", () => {
    const ammo = { ...rail, focus: "effort" } as const;
    expect(adjust(ammo, STOPS, -1, around).effort).toBe("high");
    expect(adjust(ammo, STOPS, 1, around).effort).toBe("low");
    expect(adjust({ ...ammo, effort: "high" }, STOPS, -1, around).effort).toBe(
      "high"
    );
  });

  test("the loadout slot stops at its ends", () => {
    const slot = { ...rail, focus: "slot" } as const;
    expect(adjust(slot, STOPS, 1, around).slot).toBe(1);
    expect(adjust({ ...slot, slot: 1 }, STOPS, 1, around).slot).toBe(1);
    expect(adjust(slot, [], 1, around)).toBe(slot);
  });
});
