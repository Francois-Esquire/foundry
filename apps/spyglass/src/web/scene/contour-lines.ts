import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
} from "three";
import {
  float,
  fwidth,
  max,
  positionWorld,
  texture as sampleTexture,
  smoothstep,
  step,
  vec2,
} from "three/tsl";
import type { Node } from "three/webgpu";
import {
  type ContourLevel,
  type ContourSettings,
  contourChannelLayout,
  contourChannels,
  contourLevels,
  defaultContourSettings,
  type ElevationGrid,
} from "../../lib/visualization/contours";
import type { GeologyGrid } from "../../lib/visualization/geology";

/**
 * Below this many coordinate units per pixel the field is flat: no level
 * crosses it, so no line is drawn even where it rests exactly on a level.
 */
const flatFootprint = 1e-6;

/** How one family of contour lines is drawn. */
export interface ContourLineOptions {
  /**
   * Screen pixels between neighbouring lines: the family is gone at `from`
   * and fully drawn at `to`.
   */
  spacing: { from: number; to: number };
  /** Peak intensity, 0 to 1. */
  strength: number;
  /** Line width in screen pixels; under a pixel, the line thins by coverage. */
  width: number;
}

/**
 * Antialiased lines at every integer of `coordinate`, as intensity 0 to 1.
 * The coordinate's screen derivative turns its distance to the nearest
 * integer into pixels, so a line keeps its width in pixels at any zoom.
 * Where neighbouring lines crowd closer than `spacing.to` pixels the family
 * fades, and it is gone at `spacing.from`, so zooming out never draws moiré.
 */
export function contourLineNode(
  coordinate: Node<"float">,
  options: ContourLineOptions
): Node<"float"> {
  const footprint = fwidth(coordinate);
  const pixels = coordinate
    .add(0.5)
    .fract()
    .sub(0.5)
    .abs()
    .div(max(footprint, flatFootprint));
  const half = Math.max(1, options.width) / 2;
  const coverage = Math.min(1, options.width);
  const line = float(1).sub(smoothstep(half - 0.5, half + 0.5, pixels));
  const spacing = float(1).div(max(footprint, flatFootprint));
  const resolved = smoothstep(
    options.spacing.from,
    options.spacing.to,
    spacing
  ).mul(step(flatFootprint, footprint));
  return line.mul(resolved).mul(coverage * options.strength);
}

/** One position's contour channels, as `contourChannels` bakes them. */
export interface ContourSample {
  /** An integer at every level. */
  coordinate: Node<"float">;
  /** The field's elevation, below 0 under water. */
  elevation: Node<"float">;
  /** An integer at every major level. */
  major: Node<"float">;
  /** How clearly lines read here, 0 to 1. */
  visibility: Node<"float">;
}

/**
 * Minor and major contours together, as intensity 0 to 1: every level from
 * the coordinate, majors thicker and stronger from their own sparser
 * coordinate, so majors outlast minors as the camera draws back. The band's
 * visibility fades the whole.
 */
export function contourInkNode(
  sample: ContourSample,
  lines: ContourSettings["lines"] = defaultContourSettings.lines
): Node<"float"> {
  const minor = contourLineNode(sample.coordinate, {
    spacing: lines.spacing,
    strength: lines.minorStrength,
    width: lines.minorWidth,
  });
  const major = contourLineNode(sample.major, {
    spacing: lines.spacing,
    strength: lines.majorStrength,
    width: lines.majorWidth,
  });
  return max(minor, major).mul(sample.visibility.clamp(0, 1));
}

/**
 * The texture coordinate of a world position over a grid. World y is map y
 * turned over, and the texture's rows are turned so the grid's first row,
 * the chart's top, is the texture's top.
 */
export function contourTexturePoint(
  grid: GeologyGrid,
  point: Node<"vec2"> = positionWorld.xy
): Node<"vec2"> {
  const width = grid.width * grid.cell;
  const height = grid.height * grid.cell;
  return vec2(
    point.x.sub(grid.left).div(width),
    point.y.add(grid.top).div(height).add(1)
  );
}

/**
 * A field's contour channels as one half-float RGBA texture over its grid,
 * in `contourChannelLayout` order, rows turned so the grid's first row is
 * the texture's top. Half floats hold the coordinate to about 1/64 of a
 * contour's spacing at 30 levels. `update` rewrites the texels for a new
 * elevation over the same grid; it never rebuilds the texture.
 */
export function createContourTexture(
  field: ElevationGrid,
  levels: readonly ContourLevel[] = contourLevels()
) {
  const { height, width } = field;
  const stride = contourChannelLayout.length;
  const data = new Uint16Array(width * height * stride);
  const texture = new DataTexture(
    data,
    width,
    height,
    RGBAFormat,
    HalfFloatType
  );
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  const update = (elevation: ArrayLike<number>) => {
    if (elevation.length !== width * height) {
      throw new Error(
        `Contour texture expects ${width * height} cells, got ${elevation.length}.`
      );
    }
    const channels = contourChannels({ ...field, elevation }, levels);
    const rowLength = width * stride;
    for (let row = 0; row < height; row += 1) {
      const from = row * rowLength;
      const to = (height - 1 - row) * rowLength;
      for (let i = 0; i < rowLength; i += 1) {
        data[to + i] = DataUtils.toHalfFloat(channels[from + i] ?? 0);
      }
    }
    texture.needsUpdate = true;
  };
  update(field.elevation);
  const grid: GeologyGrid = {
    cell: field.cell,
    height,
    left: field.left,
    top: field.top,
    width,
  };
  return { grid, levels, texture, update };
}

export type ContourTexture = ReturnType<typeof createContourTexture>;

/** A contour texture's channels at a world position. */
export function sampleContours(
  contours: Pick<ContourTexture, "grid" | "texture">,
  point: Node<"vec2"> = positionWorld.xy
): ContourSample {
  const texel = sampleTexture(
    contours.texture,
    contourTexturePoint(contours.grid, point)
  );
  return {
    coordinate: texel.r,
    elevation: texel.a,
    major: texel.g,
    visibility: texel.b,
  };
}
