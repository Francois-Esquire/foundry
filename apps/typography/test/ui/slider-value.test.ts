import { describe, expect, it } from "vitest";
import {
  fractionOf,
  parseReadout,
  snapToStep,
  valueAfterKey,
} from "~/ui/controls/slider-value";

const weight = { max: 1000, min: 100, step: 1 };
const tenths = { max: 1, min: 0, step: 0.1 };
const thirds = { max: 10, min: 0, step: 3 };

describe("snapToStep", () => {
  it("keeps values inside the range", () => {
    expect(snapToStep(5000, weight)).toBe(1000);
    expect(snapToStep(-3, weight)).toBe(100);
  });

  it("moves to the nearest step, counted from the minimum", () => {
    expect(snapToStep(640.4, weight)).toBe(640);
    expect(snapToStep(4, thirds)).toBe(3);
    expect(snapToStep(5, thirds)).toBe(6);
  });

  it("allows the maximum even when it is not on a step", () => {
    expect(snapToStep(10, thirds)).toBe(10);
  });

  it("leaves no binary noise on fractional steps", () => {
    expect(snapToStep(0.300_000_000_000_000_04, tenths)).toBe(0.3);
    expect(snapToStep(0.74, tenths)).toBe(0.7);
  });
});

describe("valueAfterKey", () => {
  it("moves one step with the arrow keys", () => {
    expect(valueAfterKey(640, "ArrowRight", weight)).toBe(641);
    expect(valueAfterKey(640, "ArrowUp", weight)).toBe(641);
    expect(valueAfterKey(640, "ArrowLeft", weight)).toBe(639);
    expect(valueAfterKey(640, "ArrowDown", weight)).toBe(639);
  });

  it("moves ten steps with Shift or the page keys", () => {
    expect(valueAfterKey(640, "ArrowRight", weight, true)).toBe(650);
    expect(valueAfterKey(640, "ArrowLeft", weight, true)).toBe(630);
    expect(valueAfterKey(640, "PageUp", weight)).toBe(650);
    expect(valueAfterKey(640, "PageDown", weight)).toBe(630);
  });

  it("goes to the ends with Home and End", () => {
    expect(valueAfterKey(640, "Home", weight)).toBe(100);
    expect(valueAfterKey(640, "End", weight)).toBe(1000);
  });

  it("stops at the ends", () => {
    expect(valueAfterKey(1000, "ArrowRight", weight)).toBe(1000);
    expect(valueAfterKey(105, "PageDown", weight)).toBe(100);
  });

  it("steps fractions without drift", () => {
    expect(valueAfterKey(0.3, "ArrowRight", tenths)).toBe(0.4);
    expect(valueAfterKey(0.3, "ArrowLeft", tenths)).toBe(0.2);
  });

  it("lands on the neighbouring step from between steps", () => {
    expect(valueAfterKey(10, "ArrowLeft", thirds)).toBe(9);
    expect(valueAfterKey(9, "ArrowRight", thirds)).toBe(10);
  });

  it("ignores keys that do not move a slider", () => {
    expect(valueAfterKey(640, "a", weight)).toBeUndefined();
    expect(valueAfterKey(640, "Tab", weight)).toBeUndefined();
  });
});

describe("parseReadout", () => {
  it("reads whole and decimal numbers, with a point or a comma", () => {
    expect(parseReadout(" 700 ")).toBe(700);
    expect(parseReadout("62.5")).toBe(62.5);
    expect(parseReadout("62,5")).toBe(62.5);
  });

  it("rejects text that is not a number", () => {
    expect(parseReadout("")).toBeUndefined();
    expect(parseReadout("bold")).toBeUndefined();
    expect(parseReadout("Infinity")).toBeUndefined();
  });
});

describe("fractionOf", () => {
  it("places a value along the track", () => {
    expect(fractionOf(100, weight)).toBe(0);
    expect(fractionOf(550, weight)).toBe(0.5);
    expect(fractionOf(1000, weight)).toBe(1);
  });

  it("puts every value of an empty range at the start", () => {
    expect(fractionOf(5, { max: 5, min: 5, step: 1 })).toBe(0);
  });
});
