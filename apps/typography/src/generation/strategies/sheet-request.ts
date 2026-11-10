/**
 * What a model is asked for when it draws a glyph sheet: the grid, the
 * prompt that describes it, and the style reference sheet it is shown.
 */
import { characterLabel } from "../plan/target";
import type { EncodedFile, ImageCodec } from "../raster/image-codec";
import { inkToImage } from "../sheet/drawing";
import {
  layoutSheet,
  type SheetLayout,
  sheetHeight,
  sheetRows,
  sheetWidth,
} from "../sheet/layout";
import type { StyleReference } from "../style/reference";
import { renderReferenceSheet } from "../style/reference-sheet";
import type { StrategyRequest } from "./strategy";

export interface SheetRequest {
  readonly layout: SheetLayout;
  readonly prompt: string;
  /** The style reference sheet as a PNG, to send. */
  readonly referenceImage: EncodedFile;
  /** The same sheet as SVG, for the record. */
  readonly referenceSvg: string;
  readonly size: { readonly height: number; readonly width: number };
}

const describeStyle = (style: StyleReference, family: string): string => {
  const { capHeight, xHeight } = style.metrics;
  const weight = Math.round((100 * style.stems.vertical) / style.unitsPerEm);
  const contrast =
    style.contrast > 1.6
      ? "high contrast between thick and thin strokes"
      : "low contrast between thick and thin strokes";
  const posture =
    Math.abs(style.slant) >= 2
      ? `slanted ${Math.round(style.slant)} degrees`
      : "upright";
  return `${family}: ${posture}, ${contrast}, stems about ${weight}% of the em thick, x-height ${Math.round((100 * xHeight) / capHeight)}% of the cap height`;
};

const describeRows = (layout: SheetLayout): string => {
  const lines: string[] = [];
  for (let row = 0; row < sheetRows(layout); row += 1) {
    const cells = layout.cells
      .slice(row * layout.columns, (row + 1) * layout.columns)
      .map((cell) => cell.label);
    lines.push(`Row ${row + 1}, left to right: ${cells.join("  ")}`);
  }
  return lines.join("\n");
};

/** The words that ask for a sheet. They name every cell, so the answer can be checked against them. */
const sheetPrompt = (
  layout: SheetLayout,
  style: StyleReference,
  family: string
): string =>
  [
    "The reference image is a specimen sheet of an existing typeface. Draw new glyphs for the same typeface.",
    `Style to match exactly: ${describeStyle(style, family)}.`,
    `Draw one glyph sheet: a grid of ${layout.columns} columns and ${sheetRows(layout)} rows of equal cells, one glyph centred in each cell.`,
    describeRows(layout),
    "Solid black glyphs on a plain white background. All glyphs at the same scale, standing on one straight baseline per row, with the same stroke weight as the reference.",
    "No labels, no captions, no grid lines, no guide lines, no borders, no shading and no decoration. Leave clear white space between glyphs.",
  ].join("\n");

/** Builds the sheet request for a strategy's targets. */
export const buildSheetRequest = async (
  request: StrategyRequest,
  codec: Pick<ImageCodec, "encodePng">,
  maxSize: number
): Promise<SheetRequest> => {
  const reference = renderReferenceSheet(request.face, request.style, {
    location: request.location,
    maxSize,
  });
  const layout = layoutSheet(
    request.targets.map((target) => ({
      key: target.key,
      label:
        target.characters.length === 1
          ? `${target.text} (${characterLabel(target.characters[0] ?? 0)})`
          : target.text,
    })),
    { maxSize }
  );
  return {
    layout,
    prompt: sheetPrompt(
      layout,
      request.style,
      request.face.description.familyName
    ),
    referenceImage: {
      bytes: await codec.encodePng(inkToImage(reference.bitmap)),
      mediaType: "image/png",
    },
    referenceSvg: reference.svg,
    size: { height: sheetHeight(layout), width: sheetWidth(layout) },
  };
};
