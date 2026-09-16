import { schedule, step, workflow } from "@foundry/quirks";
import { afterEach, describe, expect, it } from "vitest";

import type { CalendarSlot, Schedule } from "~/lib/registry";

import { registry } from "~/lib/registry";
import { nextDue, parseEvery, runSchedules } from "~/schedule";

afterEach(() => {
  registry.reset();
});

describe("factories", () => {
  it("register by name and hand back the definition", () => {
    const shout = step("shout", (_, input: string) =>
      Promise.resolve(input.toUpperCase())
    );
    expect(registry.definitions.has("shout")).toBe(true);
    expect(shout.definitionKey).toBe("quirks.shout");
  });

  it("refuse a duplicate name across steps and workflows", () => {
    step("x", () => Promise.resolve(null));
    expect(() => workflow("x", () => undefined)).toThrow(/already registered/);
  });

  it("run a step body against the bound primitives, only once bound", async () => {
    const seen = step("seen", ({ log }, input: string) => {
      log(input);
      return Promise.resolve(input);
    });
    await expect(seen.create().run("hi")).rejects.toThrow(/not bound/);

    const lines: string[] = [];
    registry.bind({
      log: (line: string) => lines.push(line),
    } as never);
    await expect(seen.create().run("hi")).resolves.toBe("hi");
    expect(lines).toEqual(["hi"]);
  });

  it("compose registered steps into a workflow graph", async () => {
    registry.bind({ log: () => undefined } as never);
    const shout = step("shout", (_, input: string) =>
      Promise.resolve(input.toUpperCase())
    );
    const twice = workflow<string, string>("twice", (graph) => {
      graph
        .step("a", shout, ({ input }) => input)
        .step("b", shout, ({ a }) => `${a}!`)
        .output(({ b }) => b);
    });
    await expect(twice.create().run("hey")).resolves.toBe("HEY!");
  });

  it("schedule a handle or a name", () => {
    const shout = step("shout", (_, input: string) => Promise.resolve(input));
    schedule("s1", { at: "6h", input: "a", workflow: shout });
    schedule("s2", { at: "30m", input: "b", workflow: "shout" });
    expect(registry.schedules.get("s1")).toMatchObject({
      trigger: { kind: "interval", ms: 6 * 3_600_000 },
      workflow: "shout",
    });
    expect(registry.schedules.get("s2")?.trigger).toEqual({
      kind: "interval",
      ms: 1_800_000,
    });
  });

  it("schedule a calendar slot, minute defaulting to 0", () => {
    schedule("s3", {
      at: { hour: 9, weekday: "mon" },
      input: null,
      workflow: "w",
    });
    expect(registry.schedules.get("s3")?.trigger).toEqual({
      kind: "calendar",
      slot: { hour: 9, minute: 0, weekday: "mon" },
    });
  });

  it("reject a calendar slot outside the clock", () => {
    expect(() => {
      schedule("bad", { at: { hour: 24 }, input: null, workflow: "w" });
    }).toThrow(/calendar slot/);
    expect(() => {
      schedule("bad", {
        at: { hour: 1, minute: 60 },
        input: null,
        workflow: "w",
      });
    }).toThrow(/calendar slot/);
  });
});

describe("cadence", () => {
  it("parses s/m/h/d and rejects the rest", () => {
    expect(parseEvery("90s")).toBe(90_000);
    expect(parseEvery("1d")).toBe(86_400_000);
    expect(() => parseEvery("weekly")).toThrow(/cadence/);
  });

  it("fires from the last completion, so a mid-run tick is skipped", async () => {
    const dispatched: number[] = [];
    let clock = 0;
    const controller = new AbortController();
    const engine = {
      run: () => {
        dispatched.push(clock);
        clock += 25;
        if (dispatched.length === 3) {
          controller.abort();
        }
        return Promise.resolve(undefined);
      },
    };
    const every: Schedule = {
      input: null,
      name: "e",
      trigger: { kind: "interval", ms: 10 },
      workflow: "w",
    };
    expect(nextDue(every, 100)).toBe(110);

    await runSchedules(engine as never, [every], {
      now: () => clock,
      print: () => undefined,
      signal: controller.signal,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    // Each run takes 25 > cadence 10; the next fires 10 after completion.
    expect(dispatched).toEqual([10, 45, 80]);
  });
});

describe("calendar", () => {
  const at = (slot: CalendarSlot): Schedule => ({
    input: null,
    name: "c",
    trigger: { kind: "calendar", slot },
    workflow: "w",
  });
  // Local-time constructors, never ISO strings, so the zone does not matter.
  const tuesday = new Date(2026, 8, 8, 10);
  expect(tuesday.getDay()).toBe(2);

  it("fires next weekday at the hour", () => {
    const due = nextDue(at({ hour: 9, weekday: "mon" }), tuesday.getTime());
    expect(due).toBe(new Date(2026, 8, 14, 9).getTime());
  });

  it("fires tomorrow when today's slot has passed", () => {
    const due = nextDue(at({ hour: 2 }), new Date(2026, 8, 8, 3).getTime());
    expect(due).toBe(new Date(2026, 8, 9, 2).getTime());
  });

  it("picks the nearest of several weekdays", () => {
    const slot: CalendarSlot = {
      hour: 9,
      minute: 30,
      weekday: ["mon", "wed", "fri"],
    };
    const due = nextDue(at(slot), tuesday.getTime());
    expect(due).toBe(new Date(2026, 8, 9, 9, 30).getTime());
  });
});
