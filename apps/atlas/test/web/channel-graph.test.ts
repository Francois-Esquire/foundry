import { expect, it } from "vitest";

import { createChannelGraph } from "../../src/web/channel-graph";

it("follows shared region vertices before branching into the destination", () => {
  const width = 20,
    height = 20;
  const owners = Int32Array.from({ length: width * height }, (_, i) => {
    const x = i % width,
      y = Math.floor(i / width);
    return x < (y < 10 ? 7 : 12) ? 0 : 1;
  });
  const route = createChannelGraph(
    owners,
    width,
    height,
    (x, y) => ({ x, y }),
    () => true
  );
  const from = { x: 2, y: 2 },
    to = { x: 17, y: 17 };
  const path = route(from, to);
  expect(path[0]).toEqual(from);
  expect(path.at(-1)).toEqual(to);
  expect(path.some((p) => Math.abs(p.x - 7) < 0.1 && p.y < 9)).toBe(true);
  expect(path.some((p) => Math.abs(p.x - 12) < 0.1 && p.y > 11)).toBe(true);
  expect(route(from, to)).toEqual(path);
  expect(
    createChannelGraph(
      owners,
      width,
      height,
      (x, y) => ({ x, y }),
      () => false
    )(from, to)
  ).toEqual([]);
});
