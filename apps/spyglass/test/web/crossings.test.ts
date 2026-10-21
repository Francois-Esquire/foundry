import assert from "node:assert/strict";
import { expect, it } from "vitest";
import type { SpyglassData } from "../../src/web/data/types";
import { inks } from "../../src/web/ladder/ink-ladder";
import { inkStyle } from "../../src/web/ladder/ink-table";
import { crossingMarks } from "../../src/web/layout/crossing-marks";
import { twins } from "../helpers/twins";

/** The crossing lines drawn, with an island selected or none. */
function crossingStrokes(spyglass: SpyglassData, selected: string | null) {
  const marks = crossingMarks(spyglass, selected);
  return {
    beads: marks.filter((mark) => mark.kind === "glyph"),
    lines: marks.filter((mark) => mark.kind === "stroke"),
  };
}

it("draws one line for each pair of packages a crossing joins, in the crossing's ink, and none for a single workspace", async () => {
  const { spyglass, single } = await twins();
  const [crossing] = spyglass.crossings ?? [];
  assert(crossing);
  // Two declarations of one pair, and the pair the other way round.
  const merged: SpyglassData = {
    ...spyglass,
    crossings: [
      crossing,
      { ...crossing, kind: "devDependencies" },
      { ...crossing, from: crossing.to, to: crossing.from },
    ],
  };
  const drawn = crossingStrokes(merged, null);
  expect(drawn.lines).toHaveLength(2);
  expect(drawn.beads).toHaveLength(2);
  const pen = inkStyle("crossing");
  for (const line of drawn.lines) {
    expect(line.colour).toBe(inks.crossing);
    expect(line.dash).toEqual(pen.dash);
    expect(line.width).toBe(pen.weight);
    // Flat on the sea: the islands it passes behind hide it by depth.
    expect(line.on).toBeUndefined();
  }
  // The bead sits at the line's end, the package depended on.
  const [line] = drawn.lines;
  const [bead] = drawn.beads;
  expect(bead?.shape).toBe("dot");
  expect([bead?.x, bead?.y]).toEqual(line?.points.slice(-2));
  expect(crossingStrokes(single, null).lines).toHaveLength(0);
  // Never a route.
  expect(
    merged.routes.some(
      (route) => route.from === crossing.from && route.to === crossing.to
    )
  ).toBe(false);
});

it("keeps only the selected island's own crossings while an island is selected, with the same curves", async () => {
  const { spyglass } = await twins();
  const [crossing] = spyglass.crossings ?? [];
  assert(crossing);
  const other = spyglass.territories.find(
    (island) => island.id !== crossing.from && island.id !== crossing.to
  );
  assert(other);
  const all = crossingStrokes(spyglass, null);
  const own = crossingStrokes(spyglass, crossing.from);
  expect(own.lines).toHaveLength(1);
  expect(own.lines[0]?.points).toBe(all.lines[0]?.points);
  expect(crossingStrokes(spyglass, crossing.to).lines).toHaveLength(1);
  expect(crossingStrokes(spyglass, other.id).lines).toHaveLength(0);
});
