import assert from "node:assert/strict";
import { Vector3 } from "three";
import { expect, it } from "vitest";
import type { SpyglassData, Territory } from "../../src/web/data/types";
import {
  type HitContext,
  labelUnder,
  resolveHit,
} from "../../src/web/interaction/hit";
import type { MapLabel } from "../../src/web/layout/labels";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** A hit test over the chart as it opens: no overlays, labels as given, flat paper. */
function context(
  data: SpyglassData,
  labels: readonly MapLabel[] = [],
  pixelsPerUnit = 2
): HitContext {
  return {
    data,
    labels,
    pickTerrain: () => undefined,
    reducedMotion: false,
    shown: { belonging: null, hasComposition: false, responsibility: null },
    streams: false,
    view: { height: 400, pixelsPerUnit, width: 600, x: 0, y: 0 },
    visibility: { composition: false, files: true },
  };
}

/** The chart point over a place on an island: the paper's y runs south, the scene's north. */
const over = (territory: Territory, x = 0, y = 0) =>
  new Vector3(territory.x + x, -(territory.y + y), 0);

it("selects the label under a point, and lets a click pass through the domain's name", () => {
  const territory = { id: "island" } as Territory;
  const box = {
    font: { face: "SpyglassBody", letterSpacing: 0 },
    halo: 3,
    height: 10,
    ink: "#665e50",
    opacity: 1,
    territory,
    width: 40,
    x: 0,
    y: 0,
    z: 0,
  } satisfies Partial<MapLabel>;
  const island: MapLabel = {
    ...box,
    caption: "2 FILES",
    kind: "island",
    place: { territory },
    text: "island",
  };
  expect(labelUnder([island], 5, -5)).toBe(island);
  expect(labelUnder([island], 30, -5)).toBeUndefined();
  const domain: MapLabel = { ...box, kind: "domain", text: "domain shapes" };
  expect(labelUnder([domain], 5, -5)).toBeUndefined();
  expect(labelUnder([domain, island], 5, -5)).toBe(island);
});

it("hits a label before the land beneath it, and names what the label names", async () => {
  const data = await loadSpyglass();
  const [island, other] = data.territories;
  if (!(island && other)) {
    throw new Error("Missing territories");
  }
  const [file] = other.files;
  assert(file);
  const label: MapLabel = {
    font: { face: "SpyglassBody", letterSpacing: 0 },
    halo: 3,
    height: 10,
    ink: "#665e50",
    kind: "file",
    opacity: 1,
    place: { file, regionId: "region", territory: other },
    territory: other,
    text: "elsewhere",
    width: 40,
    x: island.x,
    y: island.y + 5,
    z: 0,
  };
  const hit = resolveHit(context(data, [label]), over(island));
  expect(hit?.territory).toBe(other);
  expect(hit?.file).toBe(file);
  expect(hit?.regionId).toBe("region");
});

it("hits the island under a point, its file when files are drawn and the point is close, and nothing at sea", async () => {
  const data = await loadSpyglass();
  const island = data.territories.find((item) => item.files.length > 0);
  const file = island?.files[0];
  if (!(island && file)) {
    throw new Error("Missing a populated island");
  }
  expect(resolveHit(context(data), over(island))?.territory.id).toBe(island.id);
  const onFile = resolveHit(context(data), over(island, file.x, file.y));
  expect(onFile?.territory.id).toBe(island.id);
  expect(onFile?.file?.id).toBe(file.id);
  const filesHidden = {
    ...context(data),
    visibility: { composition: false, files: false },
  };
  expect(resolveHit(filesHidden, over(island, file.x, file.y))?.file).toBe(
    undefined
  );
  expect(
    resolveHit(context(data), new Vector3(data.width * 4, data.height * 4, 0))
  ).toBeNull();
});

it("lifts the point to the terrain surface it picks, so what reads the point afterwards sees the land", async () => {
  const data = await loadSpyglass();
  const [island] = data.territories;
  if (!island) {
    throw new Error("Missing territory");
  }
  const point = over(island);
  const surface = point.clone().setZ(3);
  resolveHit({ ...context(data), pickTerrain: () => surface }, point);
  expect(point.z).toBe(3);
});
