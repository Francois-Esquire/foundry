/**
 * Proves a derived font against its source: reopens the real bytes and runs
 * every comparison on them. Nothing here is read from the request alone; what
 * the proof says about the font was measured on the font.
 */
import type { BuildRequest, FontBuilder } from "~/packaging/building";
import { isWoff2, unpackWoff2 } from "~/packaging/container";
import type { ShapingSample } from "~/packaging/shaping-retention";
import type { FaceDescription } from "~/typeface/face";
import type { FontReader, OpenFace } from "~/typeface/reading";
import { type ChangedGlyph, changedGlyphs } from "./changed-glyphs";
import { type ShapingTest, shapingTest } from "./shaping-tests";
import {
  type Approximation,
  approximationOf,
  type RegressionTest,
  regressionTest,
} from "./visual-regression";

export interface Proof {
  /** Set when the build moved outlines it was not asked to change, and why. */
  readonly approximation: Approximation | undefined;
  readonly changed: readonly ChangedGlyph[];
  /** Every character the derived font maps. */
  readonly characters: ReadonlySet<number>;
  /** What the derived font says about itself once reopened. */
  readonly description: FaceDescription;
  readonly regression: readonly RegressionTest[];
  readonly shaping: readonly ShapingTest[];
}

export interface ProofInput {
  readonly builder: FontBuilder;
  /** The built file, in either format. */
  readonly bytes: Uint8Array;
  readonly reader: FontReader;
  readonly request: BuildRequest;
  readonly samples: readonly ShapingSample[];
  /** The source face, open. It is left open: the workspace shares it. */
  readonly source: OpenFace;
}

/** Throws when the derived font does not reopen; the message says why. */
export const proveFont = async ({
  builder,
  bytes,
  reader,
  request,
  samples,
  source,
}: ProofInput): Promise<Proof> => {
  const derived = reader.open(
    isWoff2(bytes) ? await unpackWoff2(builder, bytes) : bytes
  );
  try {
    return {
      approximation: approximationOf(source, derived, request),
      changed: changedGlyphs(request, source, derived),
      characters: new Set(derived.characters()),
      description: derived.description,
      regression: samples.map((sample) =>
        regressionTest(source, derived, request, sample)
      ),
      shaping: samples.map((sample) =>
        shapingTest(source, derived, request, sample)
      ),
    };
  } finally {
    derived.close();
  }
};
