import { filePen, speckRadius } from "../data/bindings";
import type { SpyglassFile, Territory } from "../data/types";
import { fileInk, inks } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import { detailLevel } from "../view/detail-level";
import type { BelongingLayer, BelongingRegion } from "./belonging";
import type { Glyph, GlyphShape, MarkAlpha, MarkSize } from "./marks";
import { glyphOn } from "./marks";

/** What the file marks are built from: the islands as drawn, and the overlay's evidence as the view shows it (`belonging-view.ts`). */
export interface FileMarkInputs {
  /** The files an overlay is about; every other file recedes. */
  evidenceFiles: Set<string> | undefined;
  territories: readonly Territory[];
}

/** What the member marks are built from: the view's say over the belonging layer (`belonging-view.ts`). */
export interface MemberMarkInputs {
  /** The selected group, or the one under the pointer. */
  activeRegion: BelongingRegion | undefined;
  belonging: Pick<BelongingLayer, "files" | "territory"> | null;
  /** Whether a composition drawing is in view, under which the exact members give way. */
  hasComposition: boolean;
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
  return territory.files.map((file) =>
    glyphOn(territory, file, {
      alpha: speckAlpha,
      colour: fileInk(file.kind),
      shape: "dot",
      size: speckSize,
    })
  );
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
  const ink = { alpha, colour: fileInk(file.kind) } as const;
  const hollow = { ...ink, weight: filePenWeight } as const;
  const glyph = (shape: GlyphShape, size: MarkSize, pen: typeof ink) =>
    glyphOn(territory, file, { ...pen, shape, size });
  switch (file.fileRole) {
    case "commons":
      return [glyph("hoop", fileSpan, hollow)];
    case "junction":
      return [
        glyph("cross", fileSpan, hollow),
        glyph("frame", fileFrame, hollow),
      ];
    case "mixed":
      return [glyph("mixed", fileSpan, hollow)];
    case "unknown":
      return [glyph("frame", fileFrame, hollow)];
    default:
      break;
  }
  if (file.kind === "story") {
    return [glyph("halfDisc", fileSpan, ink)];
  }
  if (file.kind === "test") {
    return [glyph("testFile", fileSize, hollow)];
  }
  return [glyph("file", fileSize, ink)];
}

/**
 * The selected group's exact members, drawn solid over the files with a
 * paper hairline round each: the layer's own files, or the active group's
 * when it has no children. Its own layer over the files, since a hover
 * from one group to the next changes these and nothing of the files.
 */
export function memberMarks(inputs: MemberMarkInputs): Glyph[] {
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
    marks.push(
      glyphOn(territory, file, { alpha, colour, shape: "square", size }),
      glyphOn(territory, file, {
        alpha,
        colour: halo.hue,
        shape: "frame",
        size: size + halo.weight,
        weight: halo.weight,
      })
    );
  }
  return marks;
}

/**
 * Every file on every island, draped on its relief: a speck at overview,
 * its mark by kind and role closer in. The specks fade as the marks come
 * in, and a file outside an overlay's evidence recedes; the sizes follow
 * the zoom, so the layer is built again only as the islands or the
 * evidence change. The selected group's exact members lie over them in
 * their own layer (`memberMarks`).
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
  return marks;
}
