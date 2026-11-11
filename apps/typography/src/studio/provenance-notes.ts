/** The mark a candidate carries, and the words beside it. */
import {
  type DesignMark,
  type DesignOrigin,
  designMark,
  designOrigin,
  type Provenance,
} from "~/typeface/provenance";

const ORIGIN_WORDS: Readonly<Record<DesignOrigin, string>> = {
  generated: "Generated",
  inferred: "Inferred",
  manual: "Drawn by hand",
  observed: "Observed in the evidence",
};

export interface CandidateMark {
  readonly kind: DesignMark;
  /** Where the design came from and where it stands: "Observed in the evidence, not accepted". */
  readonly text: string;
}

/**
 * The mark a candidate carries and the words beside it. Until it is accepted
 * it is dotted when generated or inferred and bracketed when observed in
 * evidence. Accepted, it takes the solid mark, and the words still say where
 * it came from.
 */
export const candidateMark = (
  provenance: Provenance,
  status: "accepted" | "proposed" | "rejected"
): CandidateMark => ({
  kind: designMark(provenance, status),
  text: `${ORIGIN_WORDS[designOrigin(provenance)]}, ${
    status === "proposed" ? "not accepted" : status
  }`,
});
