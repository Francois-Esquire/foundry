/**
 * Extract, for a glyph sheet that arrived as one SVG. The shapes are painted
 * to find the cells the same way a picture's are, and then each glyph keeps
 * the model's own curves: its ink shapes, with any counters painted over
 * them in a light colour cut out as holes.
 */
import {
  type Bounds,
  type Contour,
  type Outline,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import { type Bitmap, createBitmap } from "../raster/bitmap";
import { flattenContour } from "../raster/flatten";
import { frameAround, rasterizeOutline } from "../raster/rasterize";
import type { SheetLayout } from "../sheet/layout";
import {
  orientByNesting,
  reverseContour,
  standingOf,
} from "../vector/direction";
import { parseSvg, type SvgShape } from "../vector/svg/document";
import { contourTracer } from "../vector/trace";
import { assembleExtraction, type CellOutline } from "./assemble";
import { type CellSearch, type FoundCell, findCells } from "./cells";
import type { SheetExtraction } from "./extraction";
import { cutCell, type ExtractionOptions, tracedOnSheet } from "./raster-sheet";

/** The width, in pixels, the SVG is painted at to find its cells. */
const PAINT_WIDTH = 1024;
/** A shape that covers this share of the sheet both ways is the paper. */
const PAPER_SHARE = 0.9;
const DARK = 0.5;

interface Painted {
  readonly bounds: Bounds;
  readonly isInk: boolean;
  /** Position in painting order: a later shape covers an earlier one. */
  readonly order: number;
  /** In painted pixels, with y down. */
  readonly outline: Outline;
}

const spans = (bounds: Bounds, width: number, height: number) =>
  bounds.xMax - bounds.xMin >= PAPER_SHARE * width &&
  bounds.yMax - bounds.yMin >= PAPER_SHARE * height;

/** Lays one shape over the ink map: ink covers, paper wipes out. */
const paint = (ink: Bitmap, shape: Painted) => {
  const frame = frameAround(
    {
      xMax: Math.ceil(shape.bounds.xMax),
      xMin: Math.floor(shape.bounds.xMin),
      // The frame speaks of y up; a sheet's y runs down, so the outline is flipped into it.
      yMax: -Math.floor(shape.bounds.yMin),
      yMin: -Math.ceil(shape.bounds.yMax),
    },
    1,
    1
  );
  const flipped = transformOutline(shape.outline, {
    dx: 0,
    dy: 0,
    xx: 1,
    xy: 0,
    yx: 0,
    yy: -1,
  });
  const layer = rasterizeOutline(flipped, frame, { antialias: true });
  const left = Math.round(frame.left);
  const top = Math.round(-frame.top);
  for (let y = 0; y < layer.height; y += 1) {
    for (let x = 0; x < layer.width; x += 1) {
      const sheetX = left + x;
      const sheetY = top + y;
      const cover = layer.data[y * layer.width + x] ?? 0;
      if (
        cover === 0 ||
        sheetX < 0 ||
        sheetY < 0 ||
        sheetX >= ink.width ||
        sheetY >= ink.height
      ) {
        continue;
      }
      const at = sheetY * ink.width + sheetX;
      const under = ink.data[at] ?? 0;
      ink.data[at] = shape.isInk
        ? Math.max(under, cover)
        : Math.round((under * (255 - cover)) / 255);
    }
  }
};

const overlaps = (bounds: Bounds, cell: FoundCell) =>
  bounds.xMin < cell.box.right &&
  bounds.xMax > cell.box.left &&
  bounds.yMin < cell.box.bottom &&
  bounds.yMax > cell.box.top;

/** Whether a contour runs along the edge of one of the cell's pieces of ink. */
const belongsTo = (
  contour: Contour,
  cell: FoundCell,
  search: CellSearch
): boolean => {
  const { height, labels, width } = search.labelled;
  const members = new Set(cell.members);
  for (const { x, y } of flattenContour(contour, 0.5)) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const px = Math.floor(x) + dx;
        const py = Math.floor(y) + dy;
        const inside = px >= 0 && py >= 0 && px < width && py < height;
        if (inside && members.has(labels[py * width + px] ?? 0)) {
          return true;
        }
      }
    }
  }
  return false;
};

/**
 * Light shapes painted over a glyph's ink, as holes in it. A model often
 * draws a counter that way: a white shape on top of a black one. A light
 * shape wholly in the ink is cut out, which keeps the model's own curves.
 * One that lies on paper, or in a counter the ink already has, changes
 * nothing. One that cuts across the edge of the ink cannot be cut out
 * cleanly: the answer is then undefined and the cell is traced.
 */
const countersFrom = (
  lights: readonly Painted[],
  ink: readonly Contour[]
): Contour[] | undefined => {
  const counters: Contour[] = [];
  for (const contour of lights.flatMap((shape) => shape.outline.contours)) {
    const standing = standingOf(contour, ink);
    if (standing === "across") {
      return;
    }
    if (standing === "in-ink") {
      counters.push(reverseContour(contour));
    }
  }
  return counters;
};

const drawCell = (
  cell: FoundCell,
  search: CellSearch,
  shapes: readonly Painted[],
  options: ExtractionOptions
): CellOutline => {
  const near = shapes.filter((shape) => overlaps(shape.bounds, cell));
  const inked = near
    .filter((shape) => shape.isInk)
    .map((shape) => ({
      contours: shape.outline.contours.filter((contour) =>
        belongsTo(contour, cell, search)
      ),
      order: shape.order,
    }))
    .filter((shape) => shape.contours.length > 0);
  const firstInk = Math.min(...inked.map((shape) => shape.order));
  const contours = inked.flatMap((shape) => shape.contours);
  const counters = countersFrom(
    near.filter((shape) => !shape.isInk && shape.order > firstInk),
    contours
  );
  if (counters && contours.length > 0) {
    return {
      cell,
      outline: { contours: [...contours, ...counters] },
      source: "vector",
    };
  }
  const bitmap = cutCell(search, cell);
  const vectorizer = options.vectorizer ?? contourTracer;
  return {
    bitmap,
    cell,
    outline: tracedOnSheet(vectorizer.trace(bitmap, options.trace), cell.box),
    source: "traced",
  };
};

/**
 * Splits one SVG holding several glyphs into one outline per requested
 * glyph. Text and strokes in the file are reported and left out.
 */
export const extractSvgSheet = (
  svg: string,
  layout: SheetLayout,
  options: ExtractionOptions = {}
): SheetExtraction => {
  const document = parseSvg(svg);
  const { viewBox } = document;
  const scale = viewBox.width > 0 ? PAINT_WIDTH / viewBox.width : 1;
  const size = {
    height: Math.max(1, Math.round(viewBox.height * scale)),
    width: Math.max(1, Math.round(viewBox.width * scale)),
  };
  const toPixels = {
    dx: -viewBox.x * scale,
    dy: -viewBox.y * scale,
    xx: scale,
    xy: 0,
    yx: 0,
    yy: scale,
  };
  const placed = document.shapes.flatMap((shape: SvgShape) => {
    const outline = orientByNesting(transformOutline(shape.outline, toPixels));
    const bounds = outlineBounds(outline);
    return bounds ? [{ bounds, darkness: shape.darkness, outline }] : [];
  });
  const paper = placed.find((shape) =>
    spans(shape.bounds, size.width, size.height)
  );
  const darkPaper = (paper?.darkness ?? 0) >= DARK;
  const shapes: Painted[] = placed
    .map((shape, order) => ({
      bounds: shape.bounds,
      isInk: shape.darkness >= DARK !== darkPaper,
      order,
      outline: shape.outline,
      paper: shape === paper,
    }))
    .filter((shape) => !shape.paper);
  const ink = createBitmap(size.width, size.height);
  for (const shape of shapes) {
    paint(ink, shape);
  }
  const search = findCells(ink, layout);
  const drawn = search.cells.map((cell) =>
    drawCell(cell, search, shapes, options)
  );
  const traced = drawn.filter((item) => item.source === "traced").length;
  const notes = [
    ...document.defects.map((defect) => defect.detail),
    ...(traced > 0
      ? [
          `${traced} glyph(s) were traced from the painted sheet because light shapes cut across the edge of their ink.`,
        ]
      : []),
  ];
  return assembleExtraction(search, drawn, size, notes);
};
