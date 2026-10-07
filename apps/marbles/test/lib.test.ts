import { schedule, step, workflow } from "@foundry/marbles";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { catalog } from "~/authoring/catalog";
import type { ScheduledEngine } from "~/lib/schedule";
import {
  describeTrigger,
  nextDue,
  parseEvery,
  runSchedules,
} from "~/lib/schedule";
import { JSON_INPUT_FIELD } from "~/lib/schema";
import { InMemoryStateStore } from "~/lib/state/store";
import type { CalendarSlot, Schedule } from "~/lib/triggers";

import { declared, testEngine } from "./helpers/engine";
import { bindLaunch, launch } from "./helpers/launch";

const CALENDAR_SLOT_PATTERN = /calendar slot/;
const CALENDAR_SLOT_PATTERN_2 = /calendar slot/;
const CADENCE_PATTERN = /cadence/;
const POSITIVE_CADENCE_PATTERN = /must be a positive interval/;
const ALREADY_REGISTERED_PATTERN = /already registered/;
const SHOUT_KEY_PATTERN = /^shout-[0-9a-f]{8}$/;
const WRAP_PATTERN = /wrap it in a named workflow/;
const NO_NAME_PATTERN = /has no name/;

const text = z.object({ text: z.string() });

/** An engine as the loop sees it: these triggers, a memory store, a stub launch. */
function loopEngine(
  schedules: readonly Schedule[],
  started: () => void
): ScheduledEngine {
  return {
    cancel: () => Promise.resolve(),
    has: () => true,
    launch: () => {
      started();
      return Promise.resolve({ id: "run", result: Promise.resolve() });
    },
    schedules: () => schedules,
    store: new InMemoryStateStore(),
  } as ScheduledEngine;
}

/** These bodies only read their input and log. */
function bindLog(lines: string[]) {
  bindLaunch(testEngine({ print: (line) => lines.push(line) }).bindings);
}

afterEach(() => {
  catalog.reset();
});

describe("definitions", () => {
  it("register by name and list in the catalog with their kind", () => {
    const shout = step("shout")
      .input(text)
      .do(({ input }) => input.text.toUpperCase());
    expect(catalog.definitions.get("shout")).toBe(shout);
    expect(shout.name).toBe("shout");
    workflow("loud", shout({}, { text: "hi" }));
    expect(
      declared()
        .entries()
        .map((entry) => [entry.kind, entry.name])
    ).toEqual([
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
      declared()
        .entries()
        .map((entry) => [entry.name, entry.input.fields])
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

  it("run a step body against the bindings it is given", async () => {
    const seen = step("seen")
      .input(text)
      .do(({ input, log }) => {
        log(input.text);
        return input.text;
      });

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

  it("rejects a zero or unsafe interval", () => {
    expect(() => parseEvery("0s")).toThrow(POSITIVE_CADENCE_PATTERN);
    expect(() => parseEvery("000m")).toThrow(POSITIVE_CADENCE_PATTERN);
    expect(() => parseEvery("9007199254740993d")).toThrow(
      POSITIVE_CADENCE_PATTERN
    );
  });

  it("fires from the last completion, so a mid-run tick is skipped", async () => {
    const dispatched: number[] = [];
    let clock = 0;
    const controller = new AbortController();
    const every: Schedule = {
      input: null,
      key: "e",
      kind: "schedule",
      label: "e",
      trigger: { kind: "interval", ms: 10 },
      workflow: "w",
    };
    const engine = loopEngine([every], () => {
      dispatched.push(clock);
      clock += 25;
      if (dispatched.length === 3) {
        controller.abort();
      }
    });
    expect(nextDue(every, 100)).toBe(110);

    await runSchedules(engine, {
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

  it("waits a cadence after a tick another holder skipped, rather than spinning", async () => {
    let clock = 0;
    const controller = new AbortController();
    const every: Schedule = {
      input: null,
      key: "held",
      kind: "schedule",
      label: "held",
      trigger: { kind: "interval", ms: 10 },
      workflow: "w",
    };
    const engine = loopEngine([every], () => {
      throw new Error("a held trigger must not start");
    });
    const held = engine.store.lock("held");
    const skipped: number[] = [];
    await runSchedules(engine, {
      now: () => clock,
      print: (line) => {
        if (line.includes("skipped")) {
          skipped.push(clock);
        }
        if (skipped.length === 3) {
          controller.abort();
        }
      },
      signal: controller.signal,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    expect(skipped).toEqual([10, 20, 30]);
    if ("release" in held) {
      held.release();
    }
  });
});

describe("describeTrigger", () => {
  it("reads an interval, a daily slot, and weekdays", () => {
    expect(describeTrigger({ kind: "interval", ms: 21_600_000 })).toBe(
      "every 6h"
    );
    expect(
      describeTrigger({ kind: "calendar", slot: { hour: 9, minute: 5 } })
    ).toBe("daily at 09:05");
    expect(
      describeTrigger({
        kind: "calendar",
        slot: { hour: 16, weekday: ["mon", "fri"] },
      })
    ).toBe("mon, fri at 16:00");
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
