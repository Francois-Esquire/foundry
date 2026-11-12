/**
 * How a character's coverage status is shown: the state of its cell, and the
 * mark in the inspector with the words beside it. The marks and the words for
 * work made after the source follow provenance, never a flag of their own.
 */
import {
  type DesignMark,
  type Provenance,
  standingOf,
} from "~/typeface/provenance";
import type { CharacterStatus } from "~/unicode/coverage";

/** The states a glyph cell can print. */
type CellState = "candidate" | "edited" | "missing" | "observed" | "source";

/**
 * The frame of a character's cell. Work in the face, edited or added, takes
 * the solid frame of work made after the source. A candidate is not in the
 * face: it is dotted when it was generated or inferred and in corner
 * brackets when it was traced from evidence, so `provenance` is the proposed
 * candidate's. A candidate whose provenance is not known is dotted.
 */
export const cellStateOf = (
  status: CharacterStatus,
  provenance?: Provenance
): CellState => {
  if (status === "candidate") {
    const { kind } = standingOf(provenance, "proposed");
    return kind === "unconfirmed" ? "candidate" : kind;
  }
  return status === "added" ? "edited" : status;
};

/** Source glyphs can be set as text; anything made after the source is drawn. */
export const drawsWorkingOutline = (status: CharacterStatus) =>
  status === "edited" || status === "added" || status === "candidate";

export interface StatusMark {
  readonly kind: DesignMark | "missing" | "source";
  readonly text: string;
}

/**
 * The mark and the words for a character's status. `provenance` is where the
 * design the status speaks of came from: the proposed candidate's, the added
 * glyph's, or the redrawn outline's.
 */
export const statusMarkOf = (
  status: CharacterStatus,
  provenance?: Provenance
): StatusMark => {
  switch (status) {
    case "missing":
      return { kind: "missing", text: "Missing from the face" };
    case "source":
      return { kind: "source", text: "In the source font, unchanged" };
    case "candidate": {
      // A candidate is not in the face, so the inspector never gives it the
      // solid mark of an edit, hand work included.
      const { kind, text } = standingOf(provenance, "proposed");
      return { kind: kind === "observed" ? "observed" : "unconfirmed", text };
    }
    default:
      return standingOf(provenance, status);
  }
};
