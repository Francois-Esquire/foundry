import { expect, it } from "vitest";
import { distinctWeights } from "~/generation/family/weights";

const axis = { default: 400, max: 900, min: 100, name: "Weight", tag: "wght" };

it.each([
  { entries: [400, 400, 300], expected: [300, 400], name: "repeated entries" },
  {
    entries: [1, 5000, 400],
    expected: [100, 400, 900],
    name: "entries outside the axis",
  },
  { entries: [900, 100], expected: [100, 900], name: "both axis ends" },
  { entries: [400, 400], expected: [400], name: "one different entry" },
  { entries: [], expected: [], name: "no entries" },
  {
    entries: [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      400,
    ],
    expected: [400],
    name: "nonfinite entries",
  },
])("normalises $name", ({ entries, expected }) => {
  expect(distinctWeights(axis, entries)).toEqual(expected);
});
