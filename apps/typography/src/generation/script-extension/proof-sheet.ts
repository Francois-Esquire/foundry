/**
 * The proof sheet: every test word set in the derived font's own outlines,
 * shaped by the derived font's own rules, so a person can look at the result
 * the checks only describe.
 */
import { outlineToPath } from "~/typeface/outline";
import type { OpenFace } from "~/typeface/reading";
import type { ScriptExtension } from "./extend";
import type { VerificationReport } from "./verify";

export interface ProofSheetRequest {
  readonly derived: OpenFace;
  readonly extension: ScriptExtension;
  /** Latin set beside the first words, to compare size and weight. */
  readonly latinSample?: string;
  readonly report: VerificationReport;
}

const DEFAULT_LATIN = "Hamburg";
/** Sheet pixels to one font unit. */
const SCALE = 0.07;
const MARGIN = 40;
const COLUMNS = 3;
const CELL_WIDTH = 440;
const LABEL_HEIGHT = 44;
const INK = "#111";
const GUIDE = "#b9c4d6";
const NOTE = "#5b6577";
const FAILED = "#b3261e";

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

interface SetText {
  readonly paths: readonly string[];
  readonly width: number;
}

/** Shapes a text with the face and gives each glyph's outline where shaping put it. */
const setText = (
  face: OpenFace,
  text: string,
  script: string | undefined
): SetText => {
  let pen = 0;
  const paths: string[] = [];
  for (const glyph of face.shape(text, script ? { script } : {}).glyphs) {
    const path = outlineToPath(face.glyph(glyph.glyphId).outline);
    if (path) {
      paths.push(
        `<path transform="translate(${pen + glyph.xOffset} ${glyph.yOffset})" d="${path}"/>`
      );
    }
    pen += glyph.xAdvance;
  }
  return { paths, width: pen };
};

export const drawProofSheet = ({
  derived,
  extension,
  latinSample = DEFAULT_LATIN,
  report,
}: ProofSheetRequest): string => {
  const { lines, plan, style } = extension;
  const above = style.extent.top * SCALE;
  const below = -style.extent.bottom * SCALE;
  const rowHeight = above + below + LABEL_HEIGHT;
  const guides: readonly (readonly [number, string])[] = [
    [0, "baseline"],
    [style.metrics.xHeight, "x-height"],
    [lines.headlineTop, "headline"],
    [style.metrics.capHeight, "capitals"],
  ];
  const row = (
    left: number,
    top: number,
    span: number,
    parts: readonly SetText[],
    label: string,
    labelColour: string
  ): string => {
    const baseline = top + above;
    let x = left;
    const set = parts.map((part) => {
      const group = `<g transform="translate(${x} ${baseline}) scale(${SCALE} ${-SCALE})" fill="${INK}">${part.paths.join("")}</g>`;
      x += part.width * SCALE + style.averageAdvance * SCALE * 0.5;
      return group;
    });
    const ruled = guides.map(
      ([level, name]) =>
        `<line x1="${left}" x2="${left + span}" y1="${baseline - level * SCALE}" y2="${baseline - level * SCALE}" stroke="${GUIDE}" stroke-width="1"/><text x="${left + span}" y="${baseline - level * SCALE - 3}" text-anchor="end" font-size="9" fill="${GUIDE}">${name}</text>`
    );
    return [
      ...ruled,
      ...set,
      `<text x="${left}" y="${baseline + below + 16}" font-size="11" fill="${labelColour}">${escapeXml(label)}</text>`,
    ].join("");
  };
  const width = 2 * MARGIN + COLUMNS * CELL_WIDTH;
  const [first, second] = plan.words;
  const comparison = [
    setText(derived, latinSample, undefined),
    ...[first, second].flatMap((word) =>
      word ? [setText(derived, word.text, plan.iso15924)] : []
    ),
  ];
  const cells = plan.words.map((word, index) => {
    const check = report.words[index];
    const label = check?.pass
      ? `${index + 1}. ${word.glyphs.join(" ")}`
      : `${index + 1}. Does not shape as planned: ${check?.got.join(" ") ?? ""}`;
    return row(
      MARGIN + (index % COLUMNS) * CELL_WIDTH,
      MARGIN + 60 + rowHeight * (1 + Math.floor(index / COLUMNS)),
      CELL_WIDTH - 30,
      [setText(derived, word.text, plan.iso15924)],
      label,
      check?.pass ? NOTE : FAILED
    );
  });
  const made = extension.runs.every((run) => run.record.recorded)
    ? "Glyphs made from recorded model output, replayed without calling a model."
    : "Glyphs made from generated output.";
  const height =
    2 * MARGIN + 60 + rowHeight * (1 + Math.ceil(plan.words.length / COLUMNS));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, sans-serif">`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    `<text x="${MARGIN}" y="${MARGIN + 6}" font-size="15" fill="${INK}">${escapeXml(`${report.familyName}: a ${plan.script} subset, set in the derived font's own outlines`)}</text>`,
    `<text x="${MARGIN}" y="${MARGIN + 26}" font-size="11" fill="${NOTE}">${escapeXml(`${made} ${report.words.filter((word) => word.pass).length} of ${report.words.length} test words shape to the planned glyphs. This is a defined subset, not support for ${plan.script}.`)}</text>`,
    row(
      MARGIN,
      MARGIN + 60,
      width - 2 * MARGIN,
      comparison,
      "The source face's Latin beside the new letters, on the same lines.",
      NOTE
    ),
    ...cells,
    "</svg>",
  ].join("\n");
};
