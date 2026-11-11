/**
 * Sets text in a face as the project currently has it. Shaping comes from the
 * source font, one direction run at a time; edited advances and added glyphs
 * are laid over the result, so an edit shows in text at once, without
 * building a font.
 *
 * Layout rules added as feature code are not applied here, and a cluster that
 * uses an added glyph is set glyph by glyph without the source font's
 * shaping. Text that depends on either is proved with a built font.
 */
import {
  type GlyphRef,
  resolveGlyph,
  sourceGlyph,
  type WorkingFace,
} from "./changes";
import { directionRuns, paragraphDirection } from "./direction";
import { glyphForCharacter } from "./glyphs";
import type { Outline } from "./outline";
import type {
  GlyphShape,
  OpenFace,
  ShapedGlyph,
  ShapeOptions,
  TextDirection,
} from "./reading";

export interface PlacedGlyph {
  readonly advance: number;
  /** Index of the first UTF-16 code unit this glyph came from. */
  readonly cluster: number;
  /** True when no glyph exists for the character, in the source or the project. */
  readonly missing: boolean;
  readonly outline: Outline;
  readonly ref: GlyphRef;
  /** Where the glyph's origin sits on the line, in font units. */
  readonly x: number;
  readonly y: number;
}

export interface SetLine {
  /** The way the paragraph reads. Glyphs are always listed left to right. */
  readonly direction: TextDirection;
  readonly glyphs: readonly PlacedGlyph[];
  readonly width: number;
}

const NOTDEF = 0;

interface Cluster {
  /** The characters the cluster covers, in the order they are typed. */
  readonly characters: readonly number[];
  readonly glyphs: readonly ShapedGlyph[];
  /** Index of the cluster's first code unit in the run's text. */
  readonly start: number;
}

const codePointsOf = (text: string) =>
  [...text].map((character) => character.codePointAt(0) ?? 0);

/**
 * Groups shaped glyphs by cluster. Glyphs that share a cluster value came from
 * the same stretch of text, which runs up to the next cluster's start.
 */
const clustersOf = (
  shaped: readonly ShapedGlyph[],
  runText: string
): Cluster[] => {
  const starts = [...new Set(shaped.map((glyph) => glyph.cluster))].sort(
    (a, b) => a - b
  );
  const endOf = new Map(
    starts.map((start, index) => [start, starts[index + 1] ?? runText.length])
  );
  const clusters: Cluster[] = [];
  for (const glyph of shaped) {
    const last = clusters.at(-1);
    if (last?.start === glyph.cluster) {
      clusters[clusters.length - 1] = {
        ...last,
        glyphs: [...last.glyphs, glyph],
      };
    } else {
      clusters.push({
        characters: codePointsOf(
          runText.slice(glyph.cluster, endOf.get(glyph.cluster))
        ),
        glyphs: [glyph],
        start: glyph.cluster,
      });
    }
  }
  return clusters;
};

interface Pending {
  readonly advance: number;
  readonly glyph: GlyphShape;
  readonly missing: boolean;
  readonly ref: GlyphRef;
  readonly xOffset: number;
  readonly yOffset: number;
}

export const setText = (
  text: string,
  face: OpenFace,
  working: WorkingFace,
  options: ShapeOptions = {}
): SetLine => {
  const readSource = (glyphId: number) => face.glyph(glyphId, options.location);

  /** A cluster the project has not touched keeps the source font's shaping. */
  const shapedCluster = (cluster: Cluster): Pending[] =>
    cluster.glyphs.flatMap((shaped) => {
      const ref = sourceGlyph(shaped.glyphId);
      const glyph = resolveGlyph(working, ref, readSource);
      if (!glyph) {
        return [];
      }
      // Kerning lives in the difference between the shaped and the plain
      // advance, so an edited advance keeps the pair adjustment on top of it.
      const kerning = shaped.xAdvance - readSource(shaped.glyphId).advance;
      return [
        {
          advance: glyph.advance + kerning,
          glyph,
          missing: shaped.glyphId === NOTDEF,
          ref,
          xOffset: shaped.xOffset,
          yOffset: shaped.yOffset,
        },
      ];
    });

  /** A cluster with an added glyph is set one glyph per character. */
  const plainCluster = (
    cluster: Cluster,
    direction: TextDirection
  ): Pending[] => {
    const ordered =
      direction === "rtl"
        ? cluster.characters.toReversed()
        : cluster.characters;
    return ordered.flatMap((character) => {
      const found = glyphForCharacter(working, face, character);
      const ref = found ?? sourceGlyph(NOTDEF);
      const glyph = resolveGlyph(working, ref, readSource);
      return glyph
        ? [
            {
              advance: glyph.advance,
              glyph,
              missing: found === undefined,
              ref,
              xOffset: 0,
              yOffset: 0,
            },
          ]
        : [];
    });
  };

  const glyphs: PlacedGlyph[] = [];
  let pen = 0;
  for (const run of directionRuns(text, options.direction)) {
    const runText = text.slice(run.start, run.end);
    const shaped = face.shape(runText, {
      ...options,
      direction: run.direction,
    });
    for (const cluster of clustersOf(shaped.glyphs, runText)) {
      const usesAdded = cluster.characters.some((character) =>
        working.characters.has(character)
      );
      const pending = usesAdded
        ? plainCluster(cluster, run.direction)
        : shapedCluster(cluster);
      for (const item of pending) {
        glyphs.push({
          advance: item.advance,
          cluster: run.start + cluster.start,
          missing: item.missing,
          outline: item.glyph.outline,
          ref: item.ref,
          x: pen + item.xOffset,
          y: item.yOffset,
        });
        pen += item.advance;
      }
    }
  }
  return {
    direction: options.direction ?? paragraphDirection(text),
    glyphs,
    width: pen,
  };
};
