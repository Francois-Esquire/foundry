import { describe, expect, test } from "vitest";
import { slotsOf } from "../src/model/context";
import { quipFor } from "../src/model/quip";
import { adjust, focusOn, refocus, startRail } from "../src/model/rail";
import { fitSteps } from "../src/model/steps";
import {
  compactCount,
  emptyThread,
  hasFailed,
  isEnded,
  latestEncounter,
  startEncounter,
  stepsOf,
  type Todo,
  threadTokens,
  titleOf,
  todosOf,
  tokensOf,
  toolLabel,
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
  const more =
    (before > 0 ? 2 + String(before).length : 0) +
    (after > 0 ? 2 + String(after).length : 0);
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

  test.each([
    [12, 11, 30],
    [12, 0, 30],
    [12, 5, 24],
    [120, 60, 40],
    [120, 119, 20],
  ])("%i steps running step %i fit %i columns", (count, running, width) => {
    const row = fitSteps(todos(count, running), width);
    expect(widthOf(row)).toBeLessThanOrEqual(width);
    expect(row.steps.map((step) => step.number)).toContain(running + 1);
    expect(row.before + row.steps.length + row.after).toBe(count);
  });

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
    const row = fitSteps(todosOf(threads.working), 200);
    expect(row.steps.map((step) => step.label)).toEqual(
      todosOf(threads.working).map((todo) => todo.title)
    );
  });
});

test("tools are tallied by name, most used first", () => {
  expect(toolTallies(stepsOf(threads.idle))).toEqual([]);
  expect(toolTallies(stepsOf(threads.working))).toEqual([
    { count: 1, failed: 0, name: "Skill", running: false },
    { count: 1, failed: 0, name: "Read", running: false },
    { count: 1, failed: 0, name: "Bash", running: true },
  ]);
  expect(toolTallies(stepsOf(threads.failed))).toEqual([
    { count: 1, failed: 1, name: "Read", running: false },
  ]);
});

describe("encounters", () => {
  const loadout = { effort: "low", model: "haiku" } as const;
  const opened = startEncounter({
    goal: "list the files",
    id: "encounter-7",
    loadout,
    startedAt: 1000,
  });

  test("a new encounter is running, empty, and starts when it was told", () => {
    expect(opened).toEqual({
      endedAt: null,
      goal: "list the files",
      id: "encounter-7",
      loadout,
      outcome: "running",
      plan: { input: 0, output: 0 },
      startedAt: 1000,
      steps: [],
      swapped: false,
      todos: [],
    });
    expect(isEnded(opened)).toBe(false);
    expect(isEnded(undefined)).toBe(false);
    expect(isEnded({ ...opened, outcome: "failed" })).toBe(true);
  });

  test("an encounter's tokens are its plan and its own steps, not the thread's", () => {
    const [done] = threads.done.encounters;
    expect(done && tokensOf(done)).toEqual({ input: 18_400, output: 912 });
    expect(
      threadTokens({
        ...threads.done,
        encounters: [...threads.done.encounters, ...threads.working.encounters],
      })
    ).toEqual({ input: 18_400 + 182_400, output: 912 + 2120 });
    expect(threadTokens(emptyThread)).toEqual({ input: 0, output: 0 });
  });

  test("the thread is titled by its first goal and fails with its latest encounter", () => {
    expect(titleOf(emptyThread)).toBe("New thread");
    expect(titleOf(threads.done)).toBe(threads.done.encounters[0]?.goal);
    expect(latestEncounter(emptyThread)).toBeUndefined();
    expect(hasFailed(threads.failed)).toBe(true);
    expect(
      hasFailed({
        ...threads.failed,
        encounters: [...threads.failed.encounters, opened],
      })
    ).toBe(false);
  });

  test("to-dos and steps keep their order across encounters", () => {
    const second = {
      ...opened,
      steps: [
        { streaming: false, text: "", title: "Later", tools: [], usage: null },
      ],
      todos: [
        {
          added: false,
          id: "todo-9",
          status: "pending" as const,
          title: "Later",
        },
      ],
    };
    const thread = {
      ...threads.done,
      encounters: [...threads.done.encounters, second],
    };
    expect(todosOf(thread).map((todo) => todo.id)).toEqual([
      "todo-1",
      "todo-2",
      "todo-3",
      "todo-9",
    ]);
    expect(stepsOf(thread).map((step) => step.title)).toEqual([
      "Read package.json in this directory",
      "Later",
    ]);
  });
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

test("the toolkit lists skills, then MCP servers", () => {
  expect(slotsOf(context).map(({ kind, name }) => `${kind} ${name}`)).toEqual([
    "skill task-notes",
    "mcp backlog",
  ]);
});

describe("the rail", () => {
  const rail = startRail(context);

  test("starts on the first model on medium effort", () => {
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

  test("the model and the avatar wrap round", () => {
    expect(adjust(rail, STOPS, 1, around).model).toBe("opus");
    expect(adjust(rail, STOPS, -1, around).model).toBe("haiku");
    expect(adjust({ ...rail, focus: "avatar" }, STOPS, -1, around).avatar).toBe(
      2
    );
  });

  test("Up raises effort, Down lowers it, and both stop at the ends", () => {
    const focused = { ...rail, focus: "effort" } as const;
    expect(adjust(focused, STOPS, -1, around).effort).toBe("high");
    expect(adjust(focused, STOPS, 1, around).effort).toBe("low");
    expect(
      adjust({ ...focused, effort: "high" }, STOPS, -1, around).effort
    ).toBe("high");
  });

  test("the toolkit slot stops at its ends", () => {
    const slot = { ...rail, focus: "slot" } as const;
    expect(adjust(slot, STOPS, 1, around).slot).toBe(1);
    expect(adjust({ ...slot, slot: 1 }, STOPS, 1, around).slot).toBe(1);
    expect(adjust(slot, [], 1, around)).toBe(slot);
  });
});

test("a server tool is labelled by server and tool, and others keep their name", () => {
  expect(toolLabel("mcp__backlog__add_todo")).toBe("backlog · add_todo");
  expect(toolLabel("Read")).toBe("Read");
});
