import { describe, expect, it } from "vitest";
import {
  clearOfCoast,
  compositionInsideLand,
} from "../../src/web/composition-placement";
import { fitDistricts } from "../../src/web/district-layout";
import type { Territory } from "../../src/web/types";

const territory: Territory = {
  analyzed: true,
  coast: [
    [
      [
        [-30, -30],
        [30, -30],
        [30, 30],
        [-30, 30],
        [-30, -30],
      ],
      [
        [4, 4],
        [8, 4],
        [8, 8],
        [4, 8],
        [4, 4],
      ],
    ],
    [
      [
        [50, -10],
        [70, -10],
        [70, 10],
        [50, 10],
        [50, -10],
      ],
    ],
  ],
  color: "#aaa",
  files: Array.from({ length: 60 }, (_, i) => ({
    directory: "src",
    id: `file:${i}`,
    incoming: 0,
    kind: "source",
    outgoing: 0,
    path: `src/${i}.ts`,
    x: i === 59 ? 60 : -10 + (i % 10),
    y: -10 + Math.floor(i / 10),
  })),
  hills: [],
  id: "test",
  label: "Test",
  neighborhoods: [],
  radius: 30,
  shallows: [],
  x: 0,
  y: 0,
};

describe("island-wide district fitting", () => {
  it("fits every settlement with clearance, without filling holes or joining detached land", () => {
    const plan = territory.files.map((file) => ({ id: file.id, x: 0, y: 0 }));
    const result = fitDistricts(territory, plan);
    expect(result.unplaced).toEqual([]);
    for (const file of result.files) {
      expect(compositionInsideLand(file.x, file.y, territory.coast)).toBe(true);
      expect(clearOfCoast(file.x, file.y, territory.coast, 1.9)).toBe(true);
      if (file.id === "file:59") {
        expect(file.x).toBeGreaterThan(50);
      }
    }
    for (let i = 0; i < result.files.length; i += 1) {
      for (const b of result.files.slice(i + 1)) {
        const a = result.files[i];
        if (!a) {
          throw new Error("Missing settlement");
        }
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(3.5);
      }
    }
  });
  it("does not mutate the coastline or depend on input order", () => {
    const before = structuredClone(territory);
    const plan = territory.files.map((file) => ({
      id: file.id,
      x: file.x,
      y: file.y,
    }));
    const byId = (files: Territory["files"]) =>
      [...files].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(fitDistricts(territory, plan).files)).toEqual(
      byId(
        fitDistricts(
          { ...territory, files: [...territory.files].reverse() },
          [...plan].reverse()
        ).files
      )
    );
    expect(territory).toEqual(before);
  });
  it("retains unplaced identities when land has no capacity", () => {
    const result = fitDistricts({ ...territory, coast: [] }, []);
    expect(result.files).toEqual([]);
    expect(result.unplaced.sort()).toEqual(
      territory.files.map((file) => file.id).sort()
    );
  });
});
