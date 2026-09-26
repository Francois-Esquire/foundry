import { schedule, step, workflow } from "@foundry/quirks";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { unbound } from "~/lib/bindings";
import { catalog } from "~/lib/catalog";
import { createLog } from "~/lib/log";
import { runs } from "~/lib/run-scope";
import { JSON_INPUT_FIELD } from "~/lib/schema";
import type { CalendarSlot, Schedule } from "~/lib/triggers";
import { nextDue, parseEvery, runSchedules } from "~/schedule";

import { launch } from "./helpers/launch";

const NOT_BOUND_PATTERN = /not bound/;
const CALENDAR_SLOT_PATTERN = /calendar slot/;
const CALENDAR_SLOT_PATTERN_2 = /calendar slot/;
const CADENCE_PATTERN = /cadence/;
const ALREADY_REGISTERED_PATTERN = /already registered/;
const SHOUT_KEY_PATTERN = /^shout-[0-9a-f]{8}$/;
const WRAP_PATTERN = /wrap it in workflow/;
const NO_NAME_PATTERN = /has no name/;

const text = z.object({ text: z.string() });

function bindLog(lines: string[]) {
  catalog.bind({
    agents: () => unbound("agents"),
    artifacts: () => unbound("artifacts"),
    log: createLog((_level, line) => lines.push(line)),
    root: process.cwd(),
    sandboxes: () => unbound("sandboxes"),
    workspaces: () => unbound("workspaces"),
  });
}

afterEach(() => {
  catalog.reset();
  runs.clear();
});

describe("definitions", () => {
  it("register by name and list in the catalog with their kind", () => {
    const shout = step("shout")
      .input(text)
      .do(({ input }) => input.text.toUpperCase());
    expect(catalog.definitions.get("shout")).toBe(shout);
    expect(shout.name).toBe("shout");
    workflow("loud", shout({}, { text: "hi" }));
    expect(catalog.entries().map((entry) => [entry.kind, entry.name])).toEqual([
      ["step", "shout"],
      ["workflow", "loud"],
    ]);
  });

  it("a schema without a JSON Schema still takes input, as one JSON field", () => {
    const opaque: StandardSchemaV1<{ n: number }> = {
      "~standard": {
        validate: (value) =>
          typeof value === "object" && value !== null && "n" in value
            ? { value: value as { n: number } }
            : { issues: [{ message: "expected { n }" }] },
        vendor: "test",
        version: 1,
      },
    };
    step("opaque")
      .input(opaque)
      .do(({ input }) => input.n);
    step("bare").do(() => 1);
    expect(
      catalog.entries().map((entry) => [entry.name, entry.input.fields])
    ).toEqual([
      ["opaque", [JSON_INPUT_FIELD]],
      ["bare", []],
    ]);
  });

  it("refuse a duplicate name across steps and workflows", () => {
    step("x").do(() => null);
    expect(() => workflow("x", step().do(() => 1)({}))).toThrow(
      ALREADY_REGISTERED_PATTERN
    );
  });

  it("run a step body against the bound runtime, only once bound", async () => {
    const seen = step("seen")
      .input(text)
      .do(({ input, log }) => {
        log(input.text);
        return input.text;
      });
    await expect(launch(seen, { text: "hi" })).rejects.toThrow(
      NOT_BOUND_PATTERN
    );

    const lines: string[] = [];
    bindLog(lines);
    await expect(launch(seen, { text: "hi" })).resolves.toBe("hi");
    expect(lines).toEqual(["hi"]);
  });

  it("compose steps into a workflow whose parent consumes its child", async () => {
    bindLog([]);
    const shout = step("shout")
      .input(text)
      .do(({ input }) => input.text.toUpperCase());
    const bang = step()
      .input(z.object({ a: z.string() }))
      .do(({ input }) => `${input.a}!`);
    const twice = workflow("twice")
      .input(text)
      .do(({ input }) => bang({ a: shout({}, input) }));
    expect(twice.name).toBe("twice");
    await expect(launch(twice, { text: "hey" })).resolves.toBe("HEY!");
  });

  it("hand a body without an input schema an empty object, never null", async () => {
    bindLog([]);
    const bare = step("bare").do(({ input }) => input);
    await expect(launch(bare)).resolves.toEqual({});
    await expect(launch(bare, null)).resolves.toEqual({});
  });

  it("schedule a definition, bare or locked, keyed by target and input", () => {
    const shout = step("shout")
      .input(text)
      .do(({ input }) => input.text);
    schedule(shout({}, { text: "a" })).every("6h");
    schedule(shout({}, { text: "a" })).every("30m");
    schedule(shout({}, { text: "b" })).every("1h");
    const keys = [...catalog.schedules.keys()];
    expect(keys).toHaveLength(3);
    const [first, second, third] = keys as [string, string, string];
    expect(first).toMatch(SHOUT_KEY_PATTERN);
    expect(second).toBe(`${first}-2`);
    expect(third).toMatch(SHOUT_KEY_PATTERN);
    expect(third).not.toBe(first);
    expect(catalog.schedules.get(first)).toEqual({
      input: { text: "a" },
      key: first,
      kind: "schedule",
      label: 'shout {"text":"a"}',
      trigger: { kind: "interval", ms: 6 * 3_600_000 },
      workflow: "shout",
    });
  });

  it("a bare target has the target's name as its key", () => {
    const wave = step("wave").do(() => 1);
    schedule(wave).every("1h");
    expect(catalog.schedules.get("wave")).toMatchObject({
      input: null,
      key: "wave",
      label: "wave",
      workflow: "wave",
    });
  });

  it("refuses a tree with children and a nameless target", () => {
    const shout = step("shout")
      .input(text)
      .do(({ input }) => input.text);
    const say = step("say").do(() => "x");
    expect(() => schedule(shout({ text: say({}) }))).toThrow(WRAP_PATTERN);
    expect(() => schedule(step().do(() => 1))).toThrow(NO_NAME_PATTERN);
  });

  it("schedule a calendar slot, minute defaulting to 0", () => {
    const w = step("w").do(() => 1);
    schedule(w).at({ hour: 9, weekday: "mon" });
    expect(catalog.schedules.get("w")?.trigger).toEqual({
      kind: "calendar",
      slot: { hour: 9, minute: 0, weekday: "mon" },
    });
  });

  it("reject a calendar slot outside the clock", () => {
    const w = step("w").do(() => 1);
    expect(() => {
      schedule(w).at({ hour: 24 });
    }).toThrow(CALENDAR_SLOT_PATTERN);
    expect(() => {
      schedule(w).at({ hour: 1, minute: 60 });
    }).toThrow(CALENDAR_SLOT_PATTERN_2);
  });
});

describe("cadence", () => {
  it("parses s/m/h/d and rejects the rest", () => {
    expect(parseEvery("90s")).toBe(90_000);
    expect(parseEvery("1d")).toBe(86_400_000);
    expect(() => parseEvery("weekly")).toThrow(CADENCE_PATTERN);
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
      key: "e",
      kind: "schedule",
      label: "e",
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
    key: "c",
    kind: "schedule",
    label: "c",
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
