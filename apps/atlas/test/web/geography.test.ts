import { describe, expect, it } from "vitest";
import {
  landContours,
  settleFiles,
  settlePackages,
} from "../../src/web/geography";
import type { AtlasFile, Territory } from "../../src/web/types";
import { loadAtlas } from "../helpers/reference-atlas";

const file = (id: string): AtlasFile => ({
  directory: "src",
  id,
  incoming: 0,
  kind: "source",
  outgoing: 0,
  path: id,
  x: 0,
  y: 0,
});
const region = (id: string, x: number): Territory => ({
  analyzed: true,
  coast: [],
  color: "#ffffff",
  files: [],
  hills: [],
  id,
  label: id,
  neighborhoods: [],
  radius: 40,
  shallows: [],
  x,
  y: 0,
});

describe("atlas geography", () => {
  it("reproduces file geometry for the same identifiers and imports", () => {
    const a = [file("a"), file("b"), file("c")];
    const b = structuredClone(a);
    const links = [{ source: "a", target: "b" }];
    settleFiles(a, 60, links);
    settleFiles(b, 60, links);
    expect(a).toEqual(b);
    expect(new Set(a.map((f) => `${f.x},${f.y}`)).size).toBe(3);
    expect(a.every((f) => Number.isFinite(f.x) && Number.isFinite(f.y))).toBe(
      true
    );
  });
  it("leaves water between disconnected file clusters", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...file(String(i)),
      x: i < 20 ? -60 : 60,
      y: (i % 20) * 0.2,
    }));
    expect(landContours(many, 100)[1]?.length).toBe(2);
    expect(landContours([], 100)).toEqual([[], [], []]);
  });
  it("keeps territories separate while using real relationship weights", () => {
    const a = [region("a", 0), region("b", 0)];
    settlePackages(a, new Map(), [{ from: "a", to: "b", weight: 30 }]);
    const [first, second] = a;
    expect(
      first && second && Math.hypot(first.x - second.x, first.y - second.y)
    ).toBeGreaterThan(125);
  });
  it("loads the real survey with finite geography and contours for populated regions", async () => {
    const data = await loadAtlas();
    expect(data.territories.length).toBeGreaterThan(0);
    expect(data.routes.length).toBeGreaterThan(0);
    expect(
      data.territories.every(
        (p) => Number.isFinite(p.x) && Number.isFinite(p.y)
      )
    ).toBe(true);
    expect(
      data.territories
        .filter((p) => p.files.length)
        .every((p) => p.coast.length > 0)
    ).toBe(true);
    expect(data.width).toBeGreaterThan(0);
    expect(data.height).toBeGreaterThan(0);
  });
});
