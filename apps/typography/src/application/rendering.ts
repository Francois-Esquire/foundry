/**
 * The render command: text set in one font's own bytes and drawn as SVG
 * paths. The font shapes the text itself, script by script, so a conjunct or
 * a ligature shows as the font forms it. A character the font lacks is drawn
 * as the crossed box and named, and no other font ever stands in for it.
 *
 * Runs of different scripts are set in the order they are typed. A
 * right-to-left line that also holds a left-to-right script is not reordered.
 */
import { EMPTY_WORKING_FACE } from "~/typeface/changes";
import { outlineToPath } from "~/typeface/outline";
import { type OpenFace, UnreadableFontError } from "~/typeface/reading";
import { type PlacedGlyph, setText } from "~/typeface/typesetting";
import { categoryOf, scriptOf } from "~/unicode/characters";
import { findScript } from "~/unicode/scripts";
import type { Rendered, RenderRequest } from "./commands";
import type { OpenProject } from "./open-project";
import { Refusal } from "./refusal";

const DEFAULT_SIZE = 96;
const MARGIN = 24;
const INK = "#111";
/** The crossed box stands in the middle of the missing glyph's own width. */
const BOX_INSET = 0.14;
/** The share of the em a capital takes, for a font that does not say. */
const CAP_HEIGHT = 0.7;

interface ScriptRun {
  /** The ISO 15924 code of the run's letters. Absent when it has none. */
  readonly script?: string;
  readonly text: string;
}

/**
 * Splits a text where its script changes. Spaces, digits, punctuation and
 * marks belong to no script and stay with the letters before them.
 */
const scriptRuns = (text: string): ScriptRun[] => {
  const runs: ScriptRun[] = [];
  for (const character of text) {
    const code = scriptOf(character.codePointAt(0) ?? 0);
    const script = findScript(code) ? code : undefined;
    const last = runs.at(-1);
    if (last && (script === undefined || script === (last.script ?? script))) {
      runs[runs.length - 1] = {
        script: last.script ?? script,
        text: last.text + character,
      };
    } else {
      runs.push({ script, text: character });
    }
  }
  return runs;
};

/** Spaces, line ends and format controls draw nothing, so no font has to hold them. */
const drawsNothing = (character: string) => {
  const category = categoryOf(character.codePointAt(0) ?? 0);
  return category.startsWith("Z") || category === "Cc" || category === "Cf";
};

const number = (value: number) => Number(value.toFixed(2));

const crossedBox = (glyph: PlacedGlyph, left: number, top: number) => {
  const start = number(left + glyph.x + glyph.advance * BOX_INSET);
  const end = number(left + glyph.x + glyph.advance * (1 - BOX_INSET));
  return `<path fill="none" stroke="${INK}" vector-effect="non-scaling-stroke" d="M${start} 0H${end}V${top}H${start}ZM${start} 0L${end} ${top}M${end} 0L${start} ${top}"/>`;
};

const draw = (face: OpenFace, text: string, size: number): Rendered => {
  const { ascender, capHeight, descender, unitsPerEm } =
    face.description.metrics;
  const top = capHeight ?? Math.round(unitsPerEm * CAP_HEIGHT);
  const drawn: string[] = [];
  const missing = new Set<string>();
  let pen = 0;
  for (const run of scriptRuns(text)) {
    const line = setText(run.text, face, EMPTY_WORKING_FACE, {
      script: run.script,
    });
    for (const glyph of line.glyphs) {
      const character = String.fromCodePoint(
        run.text.codePointAt(glyph.cluster) ?? 0
      );
      if (glyph.missing && !drawsNothing(character)) {
        missing.add(character);
        drawn.push(crossedBox(glyph, pen, top));
        continue;
      }
      const path = glyph.missing ? "" : outlineToPath(glyph.outline);
      if (path) {
        drawn.push(
          `<path transform="translate(${number(pen + glyph.x)} ${number(glyph.y)})" d="${path}"/>`
        );
      }
    }
    pen += line.width;
  }
  const scale = size / unitsPerEm;
  const width = Math.ceil(pen * scale + 2 * MARGIN);
  const height = Math.ceil((ascender - descender) * scale + 2 * MARGIN);
  const baseline = number(MARGIN + ascender * scale);
  return {
    height,
    missing: [...missing],
    svg: [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
      `<g transform="translate(${MARGIN} ${baseline}) scale(${scale} ${-scale})" fill="${INK}">`,
      ...drawn,
      "</g>",
      "</svg>",
    ].join("\n"),
    width,
  };
};

export const render = async (
  open: OpenProject,
  request: RenderRequest
): Promise<Rendered> => {
  const size = request.size ?? DEFAULT_SIZE;
  if (!(Number.isFinite(size) && size > 0)) {
    throw new Refusal("The size to render at must be more than zero.");
  }
  const bytes = await open.store.read(request.font);
  let face: OpenFace;
  try {
    face = open.means.reader.open(bytes);
  } catch (error) {
    if (!(error instanceof UnreadableFontError)) {
      throw error;
    }
    throw new Refusal(
      `The artifact ${request.font.artifactId} does not hold a font that can be read. ${error.message}`,
      { cause: error }
    );
  }
  try {
    return draw(face, request.text, size);
  } finally {
    face.close();
  }
};
