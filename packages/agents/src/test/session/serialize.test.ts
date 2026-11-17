import { describe, expect, it } from "vitest";

import { keptValue } from "../../session/serialize";

function throwingAt(index: number): unknown[] {
  const list: unknown[] = [1, 2, 3];
  Object.defineProperty(list, index, {
    enumerable: true,
    get: () => {
      throw new Error("unreadable");
    },
  });
  return list;
}

describe("keptValue", () => {
  it("names the path of an array element that throws when read", () => {
    expect(() => keptValue({ list: throwingAt(1) }, "parts")).toThrow(
      "parts.list[1] has no JSON form: unreadable"
    );
  });

  it("names the path of a bigint in an array, past a hole", () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case.
    expect(() => keptValue([1, , { n: 1n }], "parts")).toThrow(
      "parts[2].n has no JSON form"
    );
  });
});
