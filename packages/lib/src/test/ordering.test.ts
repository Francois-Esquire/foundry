import { expect, it } from "vitest";

import { byCodeUnit } from "../ordering";

it("orders string keys independently of locale and preserves equal keys", () => {
  const entries = [
    { path: "a", value: 1 },
    { path: "雪", value: 2 },
    { path: "A", value: 3 },
    { path: "a", value: 4 },
    { path: "é", value: 5 },
  ];
  const compare = byCodeUnit((entry: (typeof entries)[number]) => entry.path);
  expect(compare({ path: "a", value: 0 }, { path: "a", value: 1 })).toBe(0);
  expect(entries.sort(compare).map((entry) => entry.value)).toEqual([
    3, 1, 4, 5, 2,
  ]);
});
