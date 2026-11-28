import { Catalog, schedule, step, workflow } from "@foundry.sh/marbles";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JSON_INPUT_FIELD } from "~/lib/definitions/schema";
import { describeTrigger, nextDue } from "~/lib/schedule";
import { parseEvery } from "~/lib/schedule/cadence";
import type { CalendarSlot, Schedule } from "~/lib/schedule/triggers";

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

function bindLog(lines: string[]) {
  bindLaunch(testEngine({ print: (line) => lines.push(line) }).bindings);
}

describe("definitions", () => {
  it("register by name and list in the catalog with their kind", () => {
    const shout = step("shout")
      .input(text)
      .do(({ input }) => input.text.toUpperCase());
    const loud = workflow("loud", shout({}, { text: "hi" }));
    const collected = Catalog.collect([shout, loud]);
    expect(collected.definitions.get("shout")).toBe(shout);
    expect(shout.name).toBe("shout");
    expect(
      declared(collected)
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
    const opaqueStep = step("opaque")
      .input(opaque)
      .do(({ input }) => input.n);
    const bare = step("bare").do(() => 1);
    expect(
      declared([opaqueStep, bare])
        .entries()
        .map((entry) => [entry.name, entry.input.fields])
    ).toEqual([
      ["opaque", [JSON_INPUT_FIELD]],
      ["bare", []],
    ]);
  });

  it("refuse a duplicate name across steps and workflows", () => {
    const first = step("x").do(() => null);
    const second = workflow("x", step().do(() => 1)({}));
    expect(() => Catalog.collect([first, second])).toThrow(
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
    const s1 = schedule(shout({}, { text: "a" })).every("6h");
    const s2 = schedule(shout({}, { text: "a" })).every("30m");
    const s3 = schedule(shout({}, { text: "b" })).every("1h");
    const collected = Catalog.collect([shout, s1, s2, s3]);
    const keys = [...collected.schedules.keys()];
    expect(keys).toHaveLength(3);
    const [first, second, third] = keys as [string, string, string];
    expect(first).toMatch(SHOUT_KEY_PATTERN);
    expect(second).toBe(`${first}-2`);
    expect(third).toMatch(SHOUT_KEY_PATTERN);
    expect(third).not.toBe(first);
    expect(collected.schedules.get(first)).toEqual({
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
    const scheduled = schedule(wave).every("1h");
    const collected = Catalog.collect([wave, scheduled]);
    expect(collected.schedules.get("wave")).toMatchObject({
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
    const unnamed = schedule(step().do(() => 1)).every("1h");
    expect(() => Catalog.collect([unnamed])).toThrow(NO_NAME_PATTERN);
  });

  it("schedule a calendar slot, minute defaulting to 0", () => {
    const w = step("w").do(() => 1);
    const scheduled = schedule(w).at({ hour: 9, weekday: "mon" });
    const collected = Catalog.collect([w, scheduled]);
    expect(collected.schedules.get("w")?.trigger).toEqual({
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
