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
    belonging: null,
    data,
    labels,
    pickTerrain: () => undefined,
    reducedMotion: false,
    responsibility: null,
    streams: false,
    view: { height: 400, pixelsPerUnit, width: 600, x: 0, y: 0 },
    visibility: { composition: false, files: true },
  };
}

/** The chart point over a place on an island: the paper's y runs south, the scene's north. */
const over = (territory: Territory, x = 0, y = 0) =>
  new Vector3(territory.x + x, -(territory.y + y), 0);

it("selects the label under a point, and lets a click pass through the domain's name", () => {
  const territory = { id: "island" } as MapLabel["territory"];
  const label = (extra: Partial<MapLabel>): MapLabel => ({
    font: "12px SpyglassBody",
    height: 10,
    territory,
    text: "name",
    width: 40,
    x: 0,
    y: 0,
    ...extra,
  });
  const island = label({ text: "island" });
  expect(labelUnder([island], 5, -5)).toBe(island);
  expect(labelUnder([island], 30, -5)).toBeUndefined();
  const domain = label({ domain: true, text: "domain shapes" });
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
  const label: MapLabel = {
    file,
    font: "12px SpyglassBody",
    height: 10,
    regionId: "region",
    territory: other,
    text: "elsewhere",
    width: 40,
    x: island.x,
    y: island.y + 5,
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
