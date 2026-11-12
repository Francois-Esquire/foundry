/**
 * What the commands that make, accept, export and draw take and give back,
 * as plain data. `application.ts` holds the interface they belong to.
 */

import type { Verdict } from "~/generation/evaluation/evaluation";
import type { LiveStrategyKind } from "~/generation/strategies/offering";
import type { DerivedFontCheck } from "~/packaging/validation";
import type { FaceId } from "~/typeface/face";
import type { Region } from "~/typeface/provenance";
import type { ArtifactRef } from "./store";

/** Generates a face's part of another script. Its glyphs go in together or not at all. */
export interface ExtensionRunRequest {
  /** A face id, or the face's label as `inspect` gives it. */
  readonly faceId: string;
  readonly kind: "script-extension";
  /** The plan's name, for example devanagari-subset. */
  readonly plan: string;
  /** Where the recorded run is kept: a directory, in Node. */
  readonly recordedRun: string;
}

/** Generates single characters, each of which becomes a candidate. */
export type CandidateRunRequest =
  | {
      /** The characters as typed: themselves, or written as U+00E9. */
      readonly characters: string;
      readonly faceId: string;
      readonly kind: "characters";
      /** A model strategy needs the means' provider key and makes a paid call. */
      readonly strategy: LiveStrategyKind;
    }
  | {
      readonly faceId: string;
      readonly kind: "recorded";
      /** Which of the run's outputs to replay. Needed when it has several. */
      readonly output?: string;
      readonly recordedRun: string;
    };

/** What made a run's glyphs. A replay of a recorded run always says so. */
export interface RunSource {
  readonly model?: string;
  readonly recorded: boolean;
  readonly strategy: string;
}

interface GeneratedRun {
  /** The artifact that holds the model's output. Absent when no model made any. */
  readonly modelOutput?: string;
  /**
   * What names the run afterwards, and what `accept({ run })` takes. For a
   * script extension it is the held run's id, which `inspect()` lists while
   * the run waits. For candidates it is the run their provenance names,
   * which `inspect()` gives with each waiting candidate. A recorded run
   * answers its own id, the same on every replay.
   */
  readonly runId: string;
  readonly source: RunSource;
  /** What was asked for and not made, each with the reason. */
  readonly unmade: readonly {
    readonly name: string;
    readonly reason: string;
  }[];
}

/** A run whose glyphs wait whole, until `accept({ run })`. */
export interface ExtensionRun extends GeneratedRun {
  readonly glyphs: readonly {
    readonly name: string;
    /** The characters the glyph is mapped to. Empty for a form only layout reaches. */
    readonly text: string;
    readonly verdict?: Verdict;
  }[];
}

/** A run whose glyphs were proposed as candidates. */
export interface CandidateRun extends GeneratedRun {
  readonly candidates: readonly {
    readonly id: string;
    readonly name: string;
    readonly text: string;
    readonly verdict: Verdict;
  }[];
}

export interface ReconstructRequest {
  /** Asks a recorded run for the letters the photograph does not show. */
  readonly complete?: {
    readonly kind: "recorded";
    readonly recordedRun: string;
  };
  /** A new face for the letters, or an editable face of the project. */
  readonly destination:
    | { readonly kind: "new"; readonly familyName: string }
    | { readonly kind: "existing"; readonly faceId: string };
  /** The photograph's artifact. */
  readonly photograph: string;
  /** Where the lettering is on the photograph, in its pixels. */
  readonly region: Region;
  /**
   * What the lettering reads, one text for each line. Each needs one
   * character for every letter found. Without it the recogniser's reading
   * stands, and its labels are guesses.
   */
  readonly text?: readonly string[];
}

export interface Reconstructed {
  /** The face the letters were proposed to. */
  readonly faceId: FaceId;
  /** How many letter shapes were found in the region. */
  readonly found: number;
  /** Candidates a strategy drew. They were not in the photograph. */
  readonly inferred: readonly {
    readonly id: string;
    readonly model?: string;
    readonly recorded: boolean;
    readonly text: string;
  }[];
  readonly modelOutput?: string;
  /** Candidates traced from the photograph, one for each distinct character. */
  readonly observed: readonly {
    /** How well the outline, drawn back, covers the letter it was traced from. 0 to 1. */
    readonly fit: number;
    readonly id: string;
    readonly text: string;
  }[];
}

export type AcceptRequest =
  /**
   * A run, by the id `generate` answered with. A waiting held run goes in
   * whole, as one revision. A run of candidates has its waiting candidates
   * accepted in order, each as its own revision.
   */
  | { readonly run: string }
  /** Candidates by id, every waiting one, or the generated ones that passed. */
  | { readonly candidates: readonly string[] | "all" | "passed" };

export interface Accepted {
  /** Glyphs that went into a face. */
  readonly accepted: number;
  /** The first candidate the project refused, and why. Those after it were not tried. */
  readonly refused?: { readonly id: string; readonly reason: string };
  /** How many revisions are applied now. */
  readonly revisions: number;
}

export interface ExportRequest {
  /** Face ids or labels. */
  readonly faces: readonly string[];
  /** The family name of every derived font. Each face's own when absent. */
  readonly familyName?: string;
}

export interface ExportedFont {
  readonly bytes: Uint8Array;
  /** What was checked in the built font. Empty for a source file, which is not built. */
  readonly checks: readonly DerivedFontCheck[];
  /** The SHA-256 digest of the file. */
  readonly digest: string;
  readonly faceId: FaceId;
  readonly fileName: string;
  /** A derived font was built. An original is the source file, passed through untouched. */
  readonly kind: "derived" | "original";
  /** Notes from the font engine. */
  readonly notes: readonly string[];
  /** The artifact that holds the file, and for a derived font this export of it. */
  readonly ref: ArtifactRef;
}

export interface Exported {
  readonly fonts: readonly ExportedFont[];
  /** Why nothing was built, or why one font was not. */
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

export interface RenderRequest {
  /** An exported font or a source font. */
  readonly font: ArtifactRef;
  /** The height of one em in the picture, in pixels. 96 when absent. */
  readonly size?: number;
  readonly text: string;
}

export interface Rendered {
  readonly height: number;
  /** The characters the font lacks, each once. They are drawn as crossed boxes. */
  readonly missing: readonly string[];
  readonly svg: string;
  readonly width: number;
}
