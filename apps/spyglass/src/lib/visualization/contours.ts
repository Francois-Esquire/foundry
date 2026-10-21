import { contours } from "d3-contour";
import {
  type DepthBandId,
  depthBand,
  depthBands,
  elevationAtDepth,
  type GeologyGrid,
  geologyLevels,
  nominalDepth,
  nominalHeight,
} from "./geology";
import type { Polygon } from "./types";

/**
 * Contours of the one world field: bathymetric contours under the water,
 * elevation contours on land, and the shoreline between them. Bathymetric
 * levels are chosen in nominal metres, because that is how a chart prints
 * them, and converted to elevation; since `elevationAtDepth` is piecewise
 * linear over unequal knots, equal metres are not equal elevation. A shader
 * draws the lines from a remapped coordinate that is an integer at every
 * level, so unevenly spaced levels still draw as evenly antialiased lines.
 */
export const defaultContourSettings = {
  /**
   * Nominal metres between minor bathymetric contours in each depth band;
   * 0 draws none. Minors fall on round multiples of the interval, strictly
   * inside the band. The shelf is densest in elevation, about 0.045 a
   * step, and deep water sparsest; the narrow shallows take one minor.
   */
  bathymetricInterval: {
    deep: 500,
    shallows: 10,
    shelf: 20,
    shoreline: 0,
    slope: 250,
    trench: 1000,
  } satisfies Record<DepthBandId, number>,
  /**
   * Land contours: nominal metres between levels, and every how many levels
   * is a major. Land rises to full height over few cells, so the interval
   * stays coarse.
   */
  land: { interval: 100, majorEvery: 2 },
  /** How each family of lines is drawn on screen. */
  lines: {
    /** Peak intensity of a major contour, 0 to 1. */
    majorStrength: 1,
    /** Line width of a major contour, in screen pixels. */
    majorWidth: 1.6,
    /** Peak intensity of a minor contour, 0 to 1. */
    minorStrength: 0.55,
    /** Line width of a minor contour, in screen pixels. */
    minorWidth: 1,
    /**
     * Screen pixels between neighbouring lines of one family: the family is
     * gone at `from` and fully drawn at `to`, so lines fade before they
     * crowd into moiré.
     */
    spacing: { from: 3, to: 9 },
  },
  /**
   * How clearly each band's contours read, 0 to 1: clear on the shelf,
   * light over the pale shallows, faint on the slope and nearly gone in
   * deep water and trenches.
   */
  visibility: {
    deep: 0.12,
    land: 0.8,
    shallows: 0.55,
    shelf: 1,
    shoreline: 0.5,
    slope: 0.4,
    trench: 0.06,
  } satisfies Record<ContourBand, number>,
};
export type ContourSettings = typeof defaultContourSettings;

/** A depth band for bathymetric levels and the shoreline; `land` above water. */
export type ContourBand = DepthBandId | "land";

/** One contour the chart draws. */
export interface ContourLevel {
  /**
   * The band the level lies in. A level on a band boundary belongs to the
   * deeper band, as `depthBand` reads it: the 20 m major is the shelf's.
   */
  band: ContourBand;
  /** The level in `geologyLevels` units. */
  elevation: number;
  kind: "bathymetric" | "elevation" | "shoreline";
  /**
   * Nominal metres: depth below the water for a bathymetric level, height
   * above it for an elevation level, and 0 at the shoreline.
   */
  metres: number;
  rank: "major" | "minor";
  /** How clearly the level reads, 0 to 1, from its band. */
  visibility: number;
}

/** The deepest nominal depth the field reaches: the trench floor's. */
const deepestDepth = nominalDepth(geologyLevels.trenchFloor);

/** Round multiples of `interval` strictly between `from` and `to`. */
function multiplesBetween(from: number, to: number, interval: number) {
  if (!(interval > 0)) {
    return [];
  }
  const values: number[] = [];
  for (
    let value = (Math.floor(from / interval) + 1) * interval;
    value < to;
    value += interval
  ) {
    values.push(value);
  }
  return values;
}

function bathymetricLevels(settings: ContourSettings): ContourLevel[] {
  const level = (metres: number, rank: ContourLevel["rank"]) => {
    const band = depthBand(metres);
    return {
      band,
      elevation: elevationAtDepth(metres),
      kind: "bathymetric" as const,
      metres,
      rank,
      visibility: settings.visibility[band],
    };
  };
  const levels: ContourLevel[] = [];
  for (const band of depthBands) {
    const to = Math.min(band.to, deepestDepth);
    if (band.from > 0 && band.from < deepestDepth) {
      levels.push(level(band.from, "major"));
    }
    for (const metres of multiplesBetween(
      band.from,
      to,
      settings.bathymetricInterval[band.id]
    )) {
      levels.push(level(metres, "minor"));
    }
  }
  return levels;
}

function elevationLevels(settings: ContourSettings): ContourLevel[] {
  const { interval, majorEvery } = settings.land;
  const highest = nominalHeight(geologyLevels.land);
  return multiplesBetween(0, highest, interval).map((metres) => ({
    band: "land",
    // `nominalHeight` is linear, so this is its inverse.
    elevation: (metres / highest) * geologyLevels.land,
    kind: "elevation",
    metres,
    rank:
      majorEvery > 0 && Math.round(metres / interval) % majorEvery === 0
        ? "major"
        : "minor",
    visibility: settings.visibility.land,
  }));
}

/**
 * The contours the chart draws, deepest first: bathymetric majors at every
 * depth band's boundary with minors between at each band's interval, the
 * shoreline at the water level, and land contours at a regular interval of
 * nominal height. Every level lies strictly inside the field's range, above
 * `geologyLevels.trenchFloor` and below `geologyLevels.land`, where the
 * field clamps and a line would trace a plateau's edge.
 */
export function contourLevels(
  settings: ContourSettings = defaultContourSettings
): ContourLevel[] {
  const shoreline: ContourLevel = {
    band: "shoreline",
    elevation: geologyLevels.waterLevel,
    kind: "shoreline",
    metres: 0,
    rank: "major",
    visibility: settings.visibility.shoreline,
  };
  return [
    ...bathymetricLevels(settings),
    shoreline,
    ...elevationLevels(settings),
  ].sort((a, b) => a.elevation - b.elevation);
}

/**
 * The index of the span of `elevations` that holds `elevation`: the last
 * index whose elevation is at or below it, or -1 below the first.
 */
function spanIndex(elevation: number, elevations: readonly number[]): number {
  let low = 0;
  let high = elevations.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((elevations[middle] ?? 0) <= elevation) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * The coordinate a shader draws contours from, over sorted level
 * elevations: level `i` lands on exactly `i`, piecewise linear between
 * levels. The field's range ends are anchored half an index beyond the end
 * levels, -0.5 at `geologyLevels.trenchFloor` and `n - 0.5` at
 * `geologyLevels.land`, and the coordinate is held there beyond them, so no
 * integer falls where there is no level.
 */
function coordinateAt(elevation: number, elevations: readonly number[]) {
  const count = elevations.length;
  const [first] = elevations;
  const last = elevations.at(-1);
  if (first === undefined || last === undefined) {
    return -0.5;
  }
  if (elevation <= first) {
    const floor = Math.min(geologyLevels.trenchFloor, first);
    return floor === first
      ? 0
      : -0.5 + 0.5 * Math.max(0, (elevation - floor) / (first - floor));
  }
  if (elevation >= last) {
    const ceiling = Math.max(geologyLevels.land, last);
    return ceiling === last
      ? count - 1
      : count - 1 + 0.5 * Math.min(1, (elevation - last) / (ceiling - last));
  }
  const index = spanIndex(elevation, elevations);
  const lower = elevations[index] ?? first;
  const upper = elevations[index + 1] ?? last;
  return index + (elevation - lower) / (upper - lower);
}

/**
 * The contour coordinate at an elevation: an integer exactly at each level,
 * level `i` of the sorted levels at `i`, piecewise linear between them, and
 * monotonic and continuous over the field's whole range. A shader draws a
 * line at every integer of it with `fract` and `fwidth`, so lines stay
 * evenly antialiased though levels are unevenly spaced in elevation.
 */
export function contourCoordinate(
  elevation: number,
  levels: readonly Pick<ContourLevel, "elevation">[]
): number {
  return coordinateAt(
    elevation,
    levels.map((level) => level.elevation)
  );
}

/**
 * How clearly contours read at an elevation, 0 to 1: each level's own
 * visibility at the level, piecewise linear between levels and held beyond
 * the end levels, so it is exact on every line and continuous between them.
 */
export function contourVisibility(
  elevation: number,
  levels: readonly Pick<ContourLevel, "elevation" | "visibility">[]
): number {
  return visibilityAt(
    elevation,
    levels.map((level) => level.elevation),
    levels.map((level) => level.visibility)
  );
}

/** `contourVisibility` over precomputed level elevations and visibilities. */
function visibilityAt(
  elevation: number,
  elevations: readonly number[],
  visibilities: readonly number[]
): number {
  const [first] = elevations;
  const last = elevations.at(-1);
  if (first === undefined || last === undefined) {
    return 0;
  }
  if (elevation <= first) {
    return visibilities[0] ?? 0;
  }
  if (elevation >= last) {
    return visibilities.at(-1) ?? 0;
  }
  const index = spanIndex(elevation, elevations);
  const lower = elevations[index] ?? first;
  const upper = elevations[index + 1] ?? last;
  const from = visibilities[index] ?? 0;
  const to = visibilities[index + 1] ?? from;
  return from + ((elevation - lower) / (upper - lower)) * (to - from);
}

/** A grid with elevation by cell, row-major, row 0 at the chart's top. */
export type ElevationGrid = GeologyGrid & { elevation: ArrayLike<number> };

/** `contourCoordinate` at every cell of a field, row-major like the field. */
export function contourCoordinateField(
  field: ElevationGrid,
  levels: readonly Pick<ContourLevel, "elevation">[]
): Float32Array {
  const elevations = levels.map((level) => level.elevation);
  return Float32Array.from(field.elevation, (elevation) =>
    coordinateAt(elevation, elevations)
  );
}

/** The four channels `contourChannels` writes per cell, in order. */
export const contourChannelLayout = [
  "coordinate",
  "major",
  "visibility",
  "elevation",
] as const;

/**
 * Every channel a contour shader needs, four per cell, row-major like the
 * field. Each is a continuous field, so a bilinear texture blends it
 * correctly even where several lines cross one cell:
 * - `coordinate`: `contourCoordinate` over every level;
 * - `major`: `contourCoordinate` over the major levels only, an integer
 *   exactly at each major, so majors draw from their own sparser lines;
 * - `visibility`: `contourVisibility`, each band's fade;
 * - `elevation`: the field itself, which tells land lines from sea lines.
 */
export function contourChannels(
  field: ElevationGrid,
  levels: readonly ContourLevel[]
): Float32Array {
  const all = levels.map((level) => level.elevation);
  const visibilities = levels.map((level) => level.visibility);
  const majors = levels
    .filter((level) => level.rank === "major")
    .map((level) => level.elevation);
  const stride = contourChannelLayout.length;
  const channels = new Float32Array(field.width * field.height * stride);
  for (let cell = 0; cell < field.width * field.height; cell += 1) {
    const elevation = field.elevation[cell] ?? 0;
    const at = cell * stride;
    channels[at] = coordinateAt(elevation, all);
    channels[at + 1] = coordinateAt(elevation, majors);
    channels[at + 2] = visibilityAt(elevation, all, visibilities);
    channels[at + 3] = elevation;
  }
  return channels;
}

/** One level's traced contour. */
export interface TracedContour {
  level: ContourLevel;
  /** Where the field is at or above the level, in map units, holes kept. */
  polygons: Polygon[];
}

/**
 * Each level's contour over a field in map units, in the levels' order,
 * holes and separate pieces kept. Cell `(column, row)` is centred at
 * `left + (column + 0.5) * cell`, as `sampleGrid` reads it. Beyond the
 * grid the field reads as below every level, so rings close at its edge.
 */
export function traceContours(
  field: ElevationGrid,
  levels: readonly ContourLevel[]
): TracedContour[] {
  const thresholds = [...new Set(levels.map((level) => level.elevation))];
  const traced = new Map(
    contours()
      .size([field.width, field.height])
      .thresholds(thresholds)(Array.from(field.elevation))
      .map((contour) => [
        contour.value,
        contour.coordinates.map((polygon) =>
          polygon.map((ring) =>
            ring.map(([x = 0, y = 0]): [number, number] => [
              field.left + x * field.cell,
              field.top + y * field.cell,
            ])
          )
        ),
      ])
  );
  return levels.map((level) => ({
    level,
    polygons: traced.get(level.elevation) ?? [],
  }));
}

/**
 * A field's step coordinate: a smooth coordinate an integer on each traced
 * level line, level `i` of the given levels at `i`, read from distances to
 * the lines rather than from the field's values. A terraced field is all
 * but flat on its treads, so a threshold on its own values just off a
 * tread follows the grid's cells; a distance to a traced line is smooth at
 * any distance from it, whatever the field does there. The coordinate runs
 * through each span from its lower line to its upper as the share of the
 * way across, so it is continuous on every line and across every tread.
 */
export interface ContourStepField {
  /**
   * Each cell's coordinate: `k + below / (below + above)` in span `k`, the
   * distances to the nearest lines of level `k` and `k + 1`, each held at
   * the reach; half an index beyond the end levels at most.
   */
  coordinate: Float32Array;
  /**
   * Two values a cell: the unit direction down the coordinate, x right and
   * y down the chart; 0 where it is flat.
   */
  downhill: Float32Array;
  /**
   * Map units across each cell's span, `below + above`, held at twice the
   * reach and softened over a few cells, so a shader can size a step's
   * parts in map units from it without seeing where the span changes.
   */
  spacing: Float32Array;
}

/** One level's line through one quad of cell centres, in map units. */
interface LineSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  level: number;
}

/** Where the level crosses the edge between two corner values, as a share from the first; `undefined` where it does not. */
function crossing(from: number, to: number, level: number): number | undefined {
  if (from >= level === to >= level) {
    return;
  }
  return (level - from) / (to - from);
}

type Point = readonly [number, number];

/**
 * One quad's crossings of a level joined into segments: two crossings make
 * one; four make a saddle, joined as the quad's centre, the corners' mean,
 * stands to the level, as a bilinear field joins them.
 */
function quadSegments(
  corners: readonly [number, number, number, number],
  level: number,
  origin: Point,
  cell: number
): [Point, Point][] {
  const [a, b, c, d] = corners;
  const [x, y] = origin;
  // The top, right, bottom and left edges, clockwise from the top left.
  const edges: [number, number, (t: number) => Point][] = [
    [a, b, (t) => [x + t * cell, y]],
    [b, d, (t) => [x + cell, y + t * cell]],
    [d, c, (t) => [x + (1 - t) * cell, y + cell]],
    [c, a, (t) => [x, y + (1 - t) * cell]],
  ];
  const points: Point[] = [];
  for (const [from, to, at] of edges) {
    const t = crossing(from, to, level);
    if (t !== undefined) {
      points.push(at(t));
    }
  }
  const [p0, p1, p2, p3] = points;
  if (!(p0 && p1)) {
    return [];
  }
  if (!(p2 && p3)) {
    return [[p0, p1]];
  }
  const centreHigh = (a + b + c + d) / 4 >= level;
  return centreHigh === a >= level
    ? [
        [p0, p3],
        [p1, p2],
      ]
    : [
        [p0, p1],
        [p2, p3],
      ];
}

/**
 * Each level's line through the field by marching squares over quads of
 * cell centres, linear along each quad's edges as a bilinear field is, in
 * map units. Lines never run along the grid's edge.
 */
function lineSegments(
  field: ElevationGrid,
  levels: readonly number[]
): LineSegment[] {
  const { cell, height, left, top, width } = field;
  const segments: LineSegment[] = [];
  const value = (column: number, row: number) =>
    field.elevation[row * width + column] ?? 0;
  for (let row = 0; row < height - 1; row += 1) {
    for (let column = 0; column < width - 1; column += 1) {
      const corners = [
        value(column, row),
        value(column + 1, row),
        value(column, row + 1),
        value(column + 1, row + 1),
      ] as const;
      const low = Math.min(...corners);
      const high = Math.max(...corners);
      const origin: Point = [
        left + (column + 0.5) * cell,
        top + (row + 0.5) * cell,
      ];
      for (let level = 0; level < levels.length; level += 1) {
        const at = levels[level] ?? 0;
        if (at <= low || at > high) {
          continue;
        }
        for (const [[ax, ay], [bx, by]] of quadSegments(
          corners,
          at,
          origin,
          cell
        )) {
          segments.push({ ax, ay, bx, by, level });
        }
      }
    }
  }
  return segments;
}

/** Cells either side over which the step field's spacing is softened. */
const spacingSoftening = 2;

/** A field's mean over a square of side `2·reach + 1` cells at every cell, clamped to the grid, as two passes of running sums. */
function boxBlur(
  values: Float32Array,
  width: number,
  height: number,
  reach: number
): Float32Array {
  const across = new Float32Array(values.length);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let sum = 0;
      let count = 0;
      for (
        let c = Math.max(0, column - reach);
        c <= Math.min(width - 1, column + reach);
        c += 1
      ) {
        sum += values[row * width + c] ?? 0;
        count += 1;
      }
      across[row * width + column] = sum / count;
    }
  }
  const blurred = new Float32Array(values.length);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let sum = 0;
      let count = 0;
      for (
        let r = Math.max(0, row - reach);
        r <= Math.min(height - 1, row + reach);
        r += 1
      ) {
        sum += across[r * width + column] ?? 0;
        count += 1;
      }
      blurred[row * width + column] = sum / count;
    }
  }
  return blurred;
}

/** Each cell's squared distance to the nearest line bounding its span below and above, held at the reach's square. */
interface SpanDistances {
  above: Float32Array;
  below: Float32Array;
}

/**
 * Measures one segment into the cells within `reach` of it whose span it
 * bounds: a segment of level `k` is the lower line of span `k` and the
 * upper line of span `k - 1`.
 */
function measureSegment(
  segment: LineSegment,
  field: ElevationGrid,
  span: Int32Array,
  reach: number,
  distances: SpanDistances
): void {
  const { cell, height, left, top, width } = field;
  const { ax, ay, bx, by, level } = segment;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy || 1;
  const cells = Math.ceil(reach / cell);
  const columnOf = (x: number) => (x - left) / cell - 0.5;
  const rowOf = (y: number) => (y - top) / cell - 0.5;
  const fromColumn = Math.max(
    0,
    Math.floor(columnOf(Math.min(ax, bx))) - cells
  );
  const toColumn = Math.min(
    width - 1,
    Math.ceil(columnOf(Math.max(ax, bx))) + cells
  );
  const fromRow = Math.max(0, Math.floor(rowOf(Math.min(ay, by))) - cells);
  const toRow = Math.min(
    height - 1,
    Math.ceil(rowOf(Math.max(ay, by))) + cells
  );
  for (let row = fromRow; row <= toRow; row += 1) {
    const y = top + (row + 0.5) * cell;
    for (let column = fromColumn; column <= toColumn; column += 1) {
      const at = row * width + column;
      const own = span[at] as number;
      // Only the lines bounding a cell's own span measure it.
      let bound: Float32Array | undefined;
      if (level === own) {
        bound = distances.below;
      } else if (level === own + 1) {
        bound = distances.above;
      }
      if (bound) {
        const x = left + (column + 0.5) * cell;
        const t = Math.min(
          1,
          Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)
        );
        const ex = x - ax - t * dx;
        const ey = y - ay - t * dy;
        bound[at] = Math.min(bound[at] as number, ex * ex + ey * ey);
      }
    }
  }
}

/** The unit direction down a coordinate at every cell, by central differences, x right and y down; 0 where it is flat. */
function downhillField(
  coordinate: Float32Array,
  width: number,
  height: number
): Float32Array {
  const downhill = new Float32Array(width * height * 2);
  const at = (column: number, row: number) =>
    coordinate[
      Math.min(height - 1, Math.max(0, row)) * width +
        Math.min(width - 1, Math.max(0, column))
    ] ?? 0;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const gx = at(column + 1, row) - at(column - 1, row);
      const gy = at(column, row + 1) - at(column, row - 1);
      const length = Math.hypot(gx, gy);
      if (length > 1e-9) {
        const cell = row * width + column;
        downhill[cell * 2] = -gx / length;
        downhill[cell * 2 + 1] = -gy / length;
      }
    }
  }
  return downhill;
}

/**
 * The field's step coordinate over `levels` (elevations, sorted shallow
 * last), lines found within `reach` map units: the lines are traced by
 * marching squares, then every cell within reach of a segment takes its
 * distance to it if the segment bounds the cell's own span. The cost is
 * the lines' length times the reach's area in cells.
 */
export function contourStepField(
  field: ElevationGrid,
  levels: readonly number[],
  reach: number
): ContourStepField {
  const { height, width } = field;
  const count = width * height;
  const span = Int32Array.from(field.elevation, (elevation) =>
    spanIndex(elevation, levels)
  );
  // Squared distances while searching; the square root is taken once a cell.
  const reachSquared = reach * reach;
  const distances: SpanDistances = {
    above: new Float32Array(count).fill(reachSquared),
    below: new Float32Array(count).fill(reachSquared),
  };
  for (const segment of lineSegments(field, levels)) {
    measureSegment(segment, field, span, reach, distances);
  }
  const coordinate = new Float32Array(count);
  const spacing = new Float32Array(count);
  for (let at = 0; at < count; at += 1) {
    const lower = Math.sqrt(distances.below[at] ?? reachSquared);
    const upper = Math.sqrt(distances.above[at] ?? reachSquared);
    coordinate[at] = (span[at] ?? -1) + lower / (lower + upper || 1);
    spacing[at] = lower + upper;
  }
  return {
    coordinate,
    downhill: downhillField(coordinate, width, height),
    spacing: boxBlur(spacing, width, height, spacingSoftening),
  };
}
