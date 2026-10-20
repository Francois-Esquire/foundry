import { filePen, speckRadius } from "../data/bindings";
import type { SpyglassFile, Territory } from "../data/types";
import { fileInk, inkStyle, inks } from "../ladder/ink-ladder";
import { detailLevel } from "../view/detail-level";
import type { BelongingLayer, BelongingRegion } from "./belonging";
import type { Glyph, MarkAlpha, MarkSize } from "./marks";

/** What the file marks are built from: the islands as drawn, and the view's say over the belonging layer (`belonging-view.ts`). */
export interface FileMarkInputs {
  /** The selected group, or the one under the pointer. */
  activeRegion: BelongingRegion | undefined;
  belonging: Pick<BelongingLayer, "files" | "territory"> | null;
  /** The files an overlay is about; every other file recedes. */
  evidenceFiles: Set<string> | undefined;
  /** Whether a composition drawing is in view, under which the exact members give way. */
  hasComposition: boolean;
  territories: readonly Territory[];
}

/** A file mark's pen, in CSS pixels. */
const filePenWeight = 1;
/** How far a file outside the overlay's evidence recedes. */
const evidenceDimming = 0.15;
/** The exact members' squares: the layer's own files, or a group's, in CSS pixels. */
const memberSquare = { files: 5, group: 3.5 } as const;

/**
 * The sizes that follow the zoom, in CSS pixels: a speck's diameter, and the
 * file pen as a mark's side, as its span (the shapes drawn at the pen's
 * radius) and as a hollow square's outer edge. One function each, shared by
 * every mark that takes it, so the renderer batches them and reads the size
 * as a uniform; a pan or zoom never rebuilds the layer.
 */
const speckSize: MarkSize = (pixels) => 2 * speckRadius(pixels) * pixels;
const fileSize: MarkSize = (pixels) => filePen(pixels) * pixels;
const fileSpan: MarkSize = (pixels) => 2 * filePen(pixels) * pixels;
const fileFrame: MarkSize = (pixels) =>
  filePen(pixels) * pixels + filePenWeight;

/** The alphas that follow the zoom: specks give way to file marks between island and close zoom; evidence dims the rest. */
const speckAlpha: MarkAlpha = (pixels) => detailLevel(pixels).specks;
const fileAlpha: MarkAlpha = (pixels) => detailLevel(pixels).files;
const dimmedAlpha: MarkAlpha = (pixels) =>
  evidenceDimming * detailLevel(pixels).files;
/** The exact members show until a composition drawing takes over. */
const memberAlpha: MarkAlpha = (pixels) =>
  detailLevel(pixels, false).composition >= 0.5 ? 0 : 1;
const memberAlphaUnderComposition: MarkAlpha = (pixels) =>
  detailLevel(pixels, true).composition >= 0.5 ? 0 : 1;

/** One round dot per file, at overview. */
function speckMarks(territory: Territory): Glyph[] {
  return territory.files.map((file) => ({
    alpha: speckAlpha,
    colour: fileInk(file.kind),
    kind: "glyph",
    on: territory,
    shape: "dot",
    size: speckSize,
    x: territory.x + file.x,
    y: territory.y + file.y,
  }));
}

/**
 * A file's mark by role and kind, as the painter drew it with the file pen:
 * commons a ring, a junction a cross through a hollow square, mixed half
 * filled and half hollow, unknown a hollow square, a story a half disc, a
 * test a hollow tall rect with a plug, and any other file a filled tall rect.
 */
function fileGlyphs(
  file: SpyglassFile,
  territory: Territory,
  alpha: MarkAlpha
): Glyph[] {
  const base = {
    alpha,
    colour: fileInk(file.kind),
    kind: "glyph",
    on: territory,
    x: territory.x + file.x,
    y: territory.y + file.y,
  } as const;
  const hollow = { weight: filePenWeight } as const;
  switch (file.fileRole) {
    case "commons":
      return [{ ...base, ...hollow, shape: "hoop", size: fileSpan }];
    case "junction":
      return [
        { ...base, ...hollow, shape: "cross", size: fileSpan },
        { ...base, ...hollow, shape: "frame", size: fileFrame },
      ];
    case "mixed":
      return [{ ...base, ...hollow, shape: "mixed", size: fileSpan }];
    case "unknown":
      return [{ ...base, ...hollow, shape: "frame", size: fileFrame }];
    default:
      break;
  }
  if (file.kind === "story") {
    return [{ ...base, shape: "halfDisc", size: fileSpan }];
  }
  if (file.kind === "test") {
    return [{ ...base, ...hollow, shape: "testFile", size: fileSize }];
  }
  return [{ ...base, shape: "file", size: fileSize }];
}

/** The selected group's exact members, drawn solid over the files with a paper hairline round each. */
function memberMarks(inputs: FileMarkInputs): Glyph[] {
  const { activeRegion, belonging, hasComposition } = inputs;
  if (!belonging) {
    return [];
  }
  const members =
    belonging.files ??
    (activeRegion && !activeRegion.children ? activeRegion.members : undefined);
  if (!members) {
    return [];
  }
  const { territory } = belonging;
  const alpha = hasComposition ? memberAlphaUnderComposition : memberAlpha;
  const colour = belonging.files
    ? inks.selection
    : (activeRegion?.color ?? inks.selection);
  const size = belonging.files ? memberSquare.files : memberSquare.group;
  const halo = inkStyle("member-halo");
  const marks: Glyph[] = [];
  for (const file of members) {
    const at = {
      alpha,
      kind: "glyph",
      on: territory,
      x: territory.x + file.x,
      y: territory.y + file.y,
    } as const;
    marks.push(
      { ...at, colour, shape: "square", size },
      {
        ...at,
        colour: halo.hue,
        shape: "frame",
        size: size + halo.weight,
        weight: halo.weight,
      }
    );
  }
  return marks;
}

/**
 * Every file on every island, draped on its relief: a speck at overview,
 * its mark by kind and role closer in, and the selected group's exact
 * members solid over them. The specks fade as the marks come in, and a
 * file outside an overlay's evidence recedes; the sizes follow the zoom,
 * so the layer is built again only as the islands, the evidence or the
 * group change.
 */
export function fileMarks(inputs: FileMarkInputs): Glyph[] {
  const { evidenceFiles, territories } = inputs;
  const dimming = evidenceFiles?.size ? evidenceFiles : undefined;
  const marks: Glyph[] = [];
  for (const territory of territories) {
    marks.push(...speckMarks(territory));
  }
  for (const territory of territories) {
    for (const file of territory.files) {
      const alpha = dimming && !dimming.has(file.id) ? dimmedAlpha : fileAlpha;
      marks.push(...fileGlyphs(file, territory, alpha));
    }
  }
  marks.push(...memberMarks(inputs));
  return marks;
}
