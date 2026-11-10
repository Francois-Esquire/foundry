/**
 * Settles finished glyphs into the script's own spacing: letters join along
 * the headline, marks have no advance, and every anchor is read from the
 * glyph it belongs to. This runs on the candidates a generation produced,
 * after the pipeline's own stages, because those space every glyph as Latin.
 */
import {
  type Bounds,
  type Outline,
  outlineBounds,
  type Point,
  roundOutline,
  translateOutline,
} from "~/typeface/outline";
import { median } from "../style/measure";
import { type GlyphOnLines, readOnLines, snapToHeadline } from "./glyph-lines";
import type { HeadlineLines } from "./headline-lines";
import type { PlannedGlyph, ScriptExtensionPlan } from "./plan";

/** A candidate's outline, with what its separation recorded when it had one. */
export interface DrawnGlyph {
  /** For a mark: where its base's stem stood, from the left edge of its ink. */
  readonly attachment?: number;
  readonly outline: Outline;
}

export interface SettledGlyph {
  readonly advance: number;
  /**
   * On a mark, the points of it that attach. On anything a mark can stand
   * on, where a mark above and a mark below attach.
   */
  readonly anchors: { readonly above?: Point; readonly below?: Point };
  readonly outline: Outline;
  readonly planned: PlannedGlyph;
}

export interface Settlement {
  readonly glyphs: readonly SettledGlyph[];
  /** Glyphs that could not be read against the lines, in words. */
  readonly notes: readonly string[];
}

/**
 * Neighbouring headlines overlap by this share of their thickness. Two
 * headlines that only touch show a hairline between them when drawn small.
 */
const JOIN_OVERLAP = 0.05;

interface Reading {
  readonly bounds: Bounds;
  readonly drawn: DrawnGlyph;
  readonly outline: Outline;
  readonly planned: PlannedGlyph;
  readonly read?: GlyphOnLines;
}

const readingsOf = (
  plan: ScriptExtensionPlan,
  lines: HeadlineLines,
  drawn: ReadonlyMap<string, DrawnGlyph>
): Reading[] =>
  plan.glyphs.flatMap((planned) => {
    const glyph = drawn.get(planned.name);
    // A glyph cut from a syllable was put on the lines when it was cut.
    const outline =
      glyph &&
      (planned.shownIn ? glyph.outline : snapToHeadline(glyph.outline, lines));
    const bounds = outline && outlineBounds(outline);
    return glyph && outline && bounds
      ? [
          {
            bounds,
            drawn: glyph,
            outline,
            planned,
            read: readOnLines(outline, lines),
          },
        ]
      : [];
  });

/** How far the ink under a headline starts after the headline does. */
const overhangOf = (read: GlyphOnLines | undefined): number | undefined =>
  read?.bodyLeft !== undefined && read.bodyLeft >= read.headline.left
    ? read.bodyLeft - read.headline.left
    : undefined;

const settled = (
  reading: Reading,
  left: number,
  advance: number,
  anchors: SettledGlyph["anchors"] = {}
): SettledGlyph => ({
  advance: Math.max(0, Math.round(advance)),
  anchors,
  outline: roundOutline(translateOutline(reading.outline, -left, 0)),
  planned: reading.planned,
});

/** Where marks attach to a glyph that can carry them: over and under its main stem. */
const carrierAnchors = (
  reading: Reading,
  left: number,
  lines: HeadlineLines
): SettledGlyph["anchors"] => {
  const { read } = reading;
  const stem =
    read?.stem ??
    (read
      ? (read.headline.left + read.headline.right) / 2
      : (reading.bounds.xMin + reading.bounds.xMax) / 2);
  const x = Math.round(stem - left);
  return { above: { x, y: lines.headlineTop }, below: { x, y: 0 } };
};

/** A mark: no advance, and the point that stood on its base's stem at x 0. */
const settleMark = (reading: Reading, lines: HeadlineLines): SettledGlyph => {
  const { bounds, drawn, planned } = reading;
  const attachment = drawn.attachment ?? (bounds.xMax - bounds.xMin) / 2;
  const anchor =
    planned.rule.kind === "mark-above"
      ? { above: { x: 0, y: lines.headlineTop } }
      : { below: { x: 0, y: 0 } };
  return settled(reading, bounds.xMin + attachment, 0, anchor);
};

export const settleGlyphs = (
  plan: ScriptExtensionPlan,
  lines: HeadlineLines,
  drawn: ReadonlyMap<string, DrawnGlyph>
): Settlement => {
  const readings = readingsOf(plan, lines, drawn);
  const overhang =
    median(
      readings.flatMap((reading) =>
        reading.planned.rule.kind === "base"
          ? (overhangOf(reading.read) ?? [])
          : []
      )
    ) ?? 0;
  const overlap = JOIN_OVERLAP * lines.headlineThickness;
  const notes: string[] = [];

  /** A letter: its box is its headline, widened where ink stands clear of it. */
  const settleLetter = (reading: Reading): SettledGlyph => {
    const { bounds, read } = reading;
    if (!read) {
      notes.push(
        `${reading.planned.name} has no headline on the model's lines, so it is spaced by its ink alone.`
      );
      const left = bounds.xMin - overhang;
      return settled(
        reading,
        left,
        bounds.xMax + overhang - left,
        carrierAnchors(reading, left, lines)
      );
    }
    const { headline } = read;
    const left =
      bounds.xMin < headline.left - overhang
        ? bounds.xMin - overhang
        : headline.left;
    const right =
      bounds.xMax > headline.right + overhang
        ? bounds.xMax + overhang
        : headline.right - overlap;
    return settled(
      reading,
      left,
      right - left,
      carrierAnchors(reading, left, lines)
    );
  };

  /** A vowel sign: its box is its share of the headline, and a hook reaches out of it. */
  const settleVowelSign = (reading: Reading): SettledGlyph => {
    if (!reading.read) {
      return settleLetter(reading);
    }
    const { left, right } = reading.read.headline;
    return settled(
      reading,
      left,
      right - overlap - left,
      reading.planned.rule.kind === "vowel-sign-after"
        ? carrierAnchors(reading, left, lines)
        : {}
    );
  };

  /**
   * A half form ends where the next letter's body begins, so its box stops
   * short of its headline by the next letter's overhang.
   */
  const settleHalfForm = (reading: Reading): SettledGlyph => {
    if (!reading.read) {
      return settleLetter(reading);
    }
    const base = readings.find(
      (other) => other.planned.name === reading.planned.shownIn?.base
    );
    const { left, right } = reading.read.headline;
    return settled(
      reading,
      left,
      right - (overhangOf(base?.read) ?? overhang) - overlap - left
    );
  };

  return {
    glyphs: readings.map((reading) => {
      switch (reading.planned.rule.kind) {
        case "mark-above":
        case "mark-below":
          return settleMark(reading, lines);
        case "vowel-sign-after":
        case "vowel-sign-before":
          return settleVowelSign(reading);
        case "half-form":
          return settleHalfForm(reading);
        default:
          return settleLetter(reading);
      }
    }),
    notes,
  };
};
