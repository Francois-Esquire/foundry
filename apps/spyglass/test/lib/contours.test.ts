import { expect, it } from "vitest";
import {
  type ContourLevel,
  contourChannels,
  contourCoordinate,
  contourCoordinateField,
  contourLevels,
  contourStepField,
  contourVisibility,
  defaultContourSettings,
  type ElevationGrid,
  traceContours,
} from "../../src/lib/visualization/contours";
import {
  depthBands,
  elevationAtDepth,
  geologyLevels,
  nominalDepth,
} from "../../src/lib/visualization/geology";

const levels = contourLevels();
const bandBoundaries = [5, 20, 100, 1000, 2000];

/** A grid of `size` cells a side, centred on the origin. */
function centredGrid(
  size: number,
  cell: number,
  at: (radius: number) => number
): ElevationGrid & { elevation: Float32Array } {
  const left = -(size * cell) / 2;
  const elevation = new Float32Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const x = left + (column + 0.5) * cell;
      const y = left + (row + 0.5) * cell;
      elevation[row * size + column] = at(Math.hypot(x, y));
    }
  }
  return { cell, elevation, height: size, left, top: left, width: size };
}

function ringRadii(ring: [number, number][]) {
  const radii = ring.map(([x, y]) => Math.hypot(x, y));
  return { max: Math.max(...radii), min: Math.min(...radii) };
}

it("sorts levels deepest first, unique, strictly inside the field's range", () => {
  const elevations = levels.map((level) => level.elevation);
  expect(elevations).toEqual(elevations.toSorted((a, b) => a - b));
  expect(new Set(elevations).size).toBe(elevations.length);
  for (const elevation of elevations) {
    expect(elevation).toBeGreaterThan(geologyLevels.trenchFloor);
    expect(elevation).toBeLessThan(geologyLevels.land);
  }
  expect(levels.filter((level) => level.kind === "shoreline")).toEqual([
    expect.objectContaining({ elevation: 0, metres: 0, rank: "major" }),
  ]);
});

it("puts bathymetric majors at every band boundary and converts metres through the contract", () => {
  const bathymetric = levels.filter((level) => level.kind === "bathymetric");
  const majors = bathymetric
    .filter((level) => level.rank === "major")
    .map((level) => level.metres);
  expect(majors.toSorted((a, b) => a - b)).toEqual(bandBoundaries);
  for (const level of bathymetric) {
    expect(level.elevation).toBe(elevationAtDepth(level.metres));
    expect(nominalDepth(level.elevation)).toBeCloseTo(level.metres, 6);
  }
  // A boundary major belongs to the deeper band.
  expect(bathymetric.find((level) => level.metres === 20)?.band).toBe("shelf");
  expect(bathymetric.find((level) => level.metres === 100)?.band).toBe("slope");
});

it("places minors at each band's interval: dense on the shelf, sparse in deep water", () => {
  const minors = (band: string, from = levels) =>
    from
      .filter((level) => level.band === band && level.rank === "minor")
      .map((level) => level.metres);
  expect(minors("shoreline")).toEqual([]);
  expect(minors("shallows")).toEqual([10]);
  expect(minors("shelf")).toEqual([80, 60, 40]);
  expect(minors("slope")).toEqual([750, 500, 250]);
  expect(minors("deep")).toEqual([1500]);
  expect(minors("trench")).toEqual([3000]);
  const coarser = contourLevels({
    ...defaultContourSettings,
    bathymetricInterval: {
      ...defaultContourSettings.bathymetricInterval,
      deep: 0,
      shelf: 40,
    },
  });
  expect(minors("shelf", coarser)).toEqual([80, 40]);
  expect(minors("deep", coarser)).toEqual([]);
  // The deepest level stays above the trench floor's own depth.
  const deepest = nominalDepth(geologyLevels.trenchFloor);
  expect(Math.max(...levels.map((level) => level.metres))).toBeLessThan(
    deepest
  );
});

it("places land contours at a regular interval of nominal height, majors at every other", () => {
  const land = levels.filter((level) => level.kind === "elevation");
  expect(land.map((level) => level.metres)).toEqual([100, 200, 300, 400, 500]);
  expect(land.map((level) => level.rank)).toEqual([
    "minor",
    "major",
    "minor",
    "major",
    "minor",
  ]);
  expect(land.map((level) => level.elevation)).toEqual(
    land.map((level) => level.metres / 600)
  );
  const finer = contourLevels({
    ...defaultContourSettings,
    land: { interval: 50, majorEvery: 4 },
  }).filter((level) => level.kind === "elevation");
  expect(finer).toHaveLength(11);
  expect(
    finer.filter((level) => level.rank === "major").map((l) => l.metres)
  ).toEqual([200, 400]);
});

it("fades visibility by band: clearest on the shelf, nearly gone in deep water", () => {
  const visibility = (band: string) =>
    levels.find((level) => level.band === band)?.visibility ?? -1;
  expect(visibility("shelf")).toBe(1);
  expect(visibility("slope")).toBeLessThan(visibility("shelf"));
  expect(visibility("deep")).toBeLessThan(visibility("slope"));
  expect(visibility("trench")).toBeLessThan(visibility("deep"));
  for (const band of depthBands) {
    expect(defaultContourSettings.visibility[band.id]).toBeGreaterThan(0);
  }
});

it("lands every level on its own integer of the contour coordinate", () => {
  for (const [index, level] of levels.entries()) {
    expect(contourCoordinate(level.elevation, levels)).toBe(index);
  }
});

it("keeps the contour coordinate monotonic and without integers beyond the levels", () => {
  const samples = 20_000;
  const from = geologyLevels.trenchFloor - 0.1;
  const to = geologyLevels.land + 0.1;
  const first = levels[0]?.elevation ?? 0;
  const last = levels.at(-1)?.elevation ?? 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (let i = 0; i <= samples; i += 1) {
    const elevation = from + ((to - from) * i) / samples;
    const coordinate = contourCoordinate(elevation, levels);
    if (elevation > first && elevation <= last) {
      expect(coordinate).toBeGreaterThan(previous);
    } else {
      expect(coordinate).toBeGreaterThanOrEqual(previous);
    }
    expect(coordinate).toBeGreaterThanOrEqual(-0.5);
    expect(coordinate).toBeLessThanOrEqual(levels.length - 0.5);
    previous = coordinate;
  }
  expect(contourCoordinate(geologyLevels.trenchFloor, levels)).toBe(-0.5);
  expect(contourCoordinate(geologyLevels.land, levels)).toBe(
    levels.length - 0.5
  );
  expect(contourCoordinate(-5, levels)).toBe(-0.5);
  expect(contourCoordinate(5, levels)).toBe(levels.length - 0.5);
  expect(contourCoordinate(0, [])).toBe(-0.5);
});

it("keeps the contour coordinate continuous at every level and depth knot", () => {
  const epsilon = 1e-9;
  const knots = [5, 20, 100, 500, 1000, 2000].map(elevationAtDepth);
  for (const elevation of [
    ...levels.map((level) => level.elevation),
    ...knots,
    geologyLevels.trenchFloor,
    geologyLevels.land,
  ]) {
    const below = contourCoordinate(elevation - epsilon, levels);
    const above = contourCoordinate(elevation + epsilon, levels);
    expect(Math.abs(above - below)).toBeLessThan(1e-5);
  }
});

it("interpolates visibility exactly on each level and holds it beyond the ends", () => {
  for (const level of levels) {
    expect(contourVisibility(level.elevation, levels)).toBe(level.visibility);
  }
  const [lower, upper] = levels;
  if (!(lower && upper)) {
    throw new Error("Expected at least two levels.");
  }
  const middle = (lower.elevation + upper.elevation) / 2;
  expect(contourVisibility(middle, levels)).toBeCloseTo(
    (lower.visibility + upper.visibility) / 2,
    9
  );
  expect(contourVisibility(-5, levels)).toBe(lower.visibility);
});

it("bakes the coordinate and every channel to match point evaluation", () => {
  const field = centredGrid(24, 4, (radius) => 1 - radius / 20);
  const coordinates = contourCoordinateField(field, levels);
  const channels = contourChannels(field, levels);
  const majors = levels.filter((level) => level.rank === "major");
  expect(coordinates).toHaveLength(field.width * field.height);
  expect(channels).toHaveLength(field.width * field.height * 4);
  for (const [cell, elevation] of field.elevation.entries()) {
    const coordinate = contourCoordinate(elevation, levels);
    expect(coordinates[cell]).toBeCloseTo(coordinate, 5);
    expect(channels[cell * 4]).toBeCloseTo(coordinate, 5);
    expect(channels[cell * 4 + 1]).toBeCloseTo(
      contourCoordinate(elevation, majors),
      5
    );
    expect(channels[cell * 4 + 2]).toBeCloseTo(
      contourVisibility(elevation, levels),
      5
    );
    expect(channels[cell * 4 + 3]).toBe(elevation);
  }
  // The major coordinate is an integer exactly at every major level.
  for (const [index, level] of majors.entries()) {
    expect(contourCoordinate(level.elevation, majors)).toBe(index);
  }
});

it("traces a cone as nested rings at the expected radii", () => {
  // Elevation falls linearly from full land at the centre to the trench
  // floor at 200 map units.
  const reach = 200;
  const span = geologyLevels.land - geologyLevels.trenchFloor;
  const cone = centredGrid(121, 4, (radius) =>
    Math.max(
      geologyLevels.trenchFloor,
      geologyLevels.land - (span * radius) / reach
    )
  );
  const traced = traceContours(cone, levels);
  expect(traced.map(({ level }) => level)).toEqual(levels);
  let outer = Number.POSITIVE_INFINITY;
  for (const { level, polygons } of traced) {
    expect(polygons).toHaveLength(1);
    const [ring, ...holes] = polygons[0] ?? [];
    expect(holes).toEqual([]);
    const expected = ((geologyLevels.land - level.elevation) * reach) / span;
    const radii = ringRadii(ring ?? []);
    expect(radii.min).toBeGreaterThan(expected - 1);
    expect(radii.max).toBeLessThan(expected + 1);
    expect(radii.max).toBeLessThan(outer);
    outer = radii.min;
  }
});

it("keeps holes: a caldera's contours are rings with the crater cut out", () => {
  const crest = 60;
  const caldera = centredGrid(81, 4, (radius) =>
    Math.max(-1, 0.9 - Math.abs(radius - crest) / 40)
  );
  const level: ContourLevel = {
    band: "land",
    elevation: 0.3,
    kind: "elevation",
    metres: 180,
    rank: "minor",
    visibility: 1,
  };
  const [traced] = traceContours(caldera, [level]);
  expect(traced?.polygons).toHaveLength(1);
  const [outer, hole] = traced?.polygons[0] ?? [];
  // Elevation 0.3 is 0.6 below the crest: 24 map units either side of it.
  expect(ringRadii(outer ?? []).min).toBeGreaterThan(crest + 24 - 1);
  expect(ringRadii(hole ?? []).max).toBeLessThan(crest - 24 + 1);
  expect(ringRadii(hole ?? []).min).toBeGreaterThan(crest - 24 - 1);
});

/** A grid's bilinear value between cell centres, clamped to its edge. */
function bilinear(
  grid: ElevationGrid,
  values: ArrayLike<number>,
  x: number,
  y: number
) {
  const u = Math.min(
    grid.width - 1,
    Math.max(0, (x - grid.left) / grid.cell - 0.5)
  );
  const v = Math.min(
    grid.height - 1,
    Math.max(0, (y - grid.top) / grid.cell - 0.5)
  );
  const column = Math.min(grid.width - 2, Math.floor(u));
  const row = Math.min(grid.height - 2, Math.floor(v));
  const s = u - column;
  const t = v - row;
  const at = (c: number, r: number) => values[r * grid.width + c] ?? 0;
  return (
    (at(column, row) * (1 - s) + at(column + 1, row) * s) * (1 - t) +
    (at(column, row + 1) * (1 - s) + at(column + 1, row + 1) * s) * t
  );
}

/**
 * How far an isoline of a bilinear field strays from the straight line
 * `x = slope · y + offset` best fitting it: its crossings of `value` along
 * rows a quarter cell apart, searched outward in x.
 */
function isolineWobble(
  grid: ElevationGrid,
  values: ArrayLike<number>,
  value: number,
  slope: number
) {
  const offsets: number[] = [];
  const top = grid.top + 2 * grid.cell;
  const bottom = grid.top + (grid.height - 2) * grid.cell;
  for (let y = top; y < bottom; y += grid.cell / 4) {
    let previous = bilinear(grid, values, grid.left, y) - value;
    for (
      let x = grid.left + 0.05;
      x < grid.left + grid.width * grid.cell;
      x += 0.05
    ) {
      const here = bilinear(grid, values, x, y) - value;
      if (previous < 0 && here >= 0) {
        offsets.push(x - 0.05 * (here / (here - previous)) - slope * y);
        break;
      }
      previous = here;
    }
  }
  const mean = offsets.reduce((sum, each) => sum + each, 0) / offsets.length;
  return Math.max(...offsets.map((each) => Math.abs(each - mean)));
}

it("steps a coordinate through each span by distance to its traced lines", () => {
  // Elevation falls from 0 at the centre by 0.01 a map unit.
  const cone = centredGrid(61, 4, (radius) => -0.01 * radius);
  const elevations = [-0.9, -0.6, -0.3];
  const field = contourStepField(cone, elevations, 32);
  const at = (x: number, y: number) => bilinear(cone, field.coordinate, x, y);
  // Each level's line, at radius 30, 60 and 90, is its integer; between
  // them the coordinate runs through the span by the share of the way.
  expect(at(90, 0)).toBeCloseTo(0, 1);
  expect(at(0, -60)).toBeCloseTo(1, 1);
  expect(at(-30, 0)).toBeCloseTo(2, 1);
  expect(at(45, 0)).toBeCloseTo(1.5, 1);
  for (let radius = 32; radius < 88; radius += 1) {
    expect(at(radius + 1, 0)).toBeLessThan(at(radius, 0));
  }
  // The spacing is the span's width, 30 map units; downhill points out.
  const centre = 30 * 61 + 30;
  const east = centre + 12;
  expect(field.spacing[east]).toBeCloseTo(30, 0);
  expect(field.downhill[east * 2]).toBeCloseTo(1, 1);
  expect(field.downhill[east * 2 + 1]).toBeCloseTo(0, 1);
  // Past the end levels it holds within half an index of them.
  expect(at(0, 0)).toBeLessThanOrEqual(2.5);
  expect(at(119, 0)).toBeGreaterThanOrEqual(-0.5);
});

it("draws an edge just off a sharp terrace riser smoothly, where the field's own values trace the cells", () => {
  // A plateau falling over a riser a cell wide, on a line across the grid.
  const width = 48;
  const cell = 4;
  const slope = Math.tan((25 * Math.PI) / 180);
  const elevation = new Float32Array(width * width);
  for (let row = 0; row < width; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const x = (column + 0.5) * cell;
      const y = (row + 0.5) * cell;
      const across = (x - slope * y - 60) * Math.cos(Math.atan(slope));
      elevation[row * width + column] =
        -0.4 - 0.1 * Math.min(1, Math.max(-1, across / 2));
    }
  }
  const grid: ElevationGrid = {
    cell,
    elevation,
    height: width,
    left: 0,
    top: 0,
    width,
  };
  const field = contourStepField(grid, [-0.6, -0.4, -0.2], 32);
  // The riser's top on the upper side: a tenth of a span off the plateau.
  const fieldWobble = isolineWobble(
    grid,
    Float32Array.from(elevation, (e) => -e),
    0.32,
    slope
  );
  const stepWobble = isolineWobble(
    grid,
    Float32Array.from(field.coordinate, (c) => -c),
    -1.15,
    slope
  );
  expect(stepWobble).toBeLessThan(0.3);
  expect(fieldWobble).toBeGreaterThan(3 * stepWobble);
});
