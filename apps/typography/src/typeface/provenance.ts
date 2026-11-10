/** Where a glyph design came from. Carried by candidates and added glyphs. */

export interface Region {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

/** What a generation run was: the strategy, the model behind it, and whether it was live. */
export interface GenerationSource {
  readonly createdAt: string;
  /** The model behind the strategy, when one was used. */
  readonly model?: string;
  /** True when the output was replayed from a recorded run, not produced live. */
  readonly recorded?: boolean;
  readonly runId: string;
  /** The generation strategy that produced it, for example "procedural". */
  readonly strategy: string;
}

export type Provenance =
  | { readonly origin: "manual" }
  | ({ readonly origin: "generated" } & GenerationSource)
  | {
      readonly origin: "reconstructed";
      readonly evidenceId: string;
      /** Observed lettering was seen in the evidence. Inferred lettering was not. */
      readonly basis: "observed" | "inferred";
      readonly region?: Region;
      readonly confidence?: number;
      /** What drew inferred lettering. Observed lettering has none: it was traced. */
      readonly inferredBy?: GenerationSource;
    };

export const isUnconfirmed = (provenance: Provenance) =>
  provenance.origin === "generated" ||
  (provenance.origin === "reconstructed" && provenance.basis === "inferred");

/** The three marks for work made after the source font. */
export type DesignMark = "edited" | "observed" | "unconfirmed";

/**
 * How a design made after the source font is marked, from where it came from
 * and where its candidate stands. Accepted work is in the face and takes the
 * solid mark of an edit, whatever made it. Until then, generated or inferred
 * work is unconfirmed, and lettering traced from evidence is observed. A
 * candidate that was never proposed, or was rejected, is not accepted either.
 * Hand work has no candidate to wait on, so it is always an edit.
 */
export const designMark = (
  provenance: Provenance,
  status: "accepted" | "proposed" | "rejected" | undefined
): DesignMark => {
  if (status === "accepted" || provenance.origin === "manual") {
    return "edited";
  }
  return isUnconfirmed(provenance) ? "unconfirmed" : "observed";
};

/**
 * The frame around a design drawn large. A rejected candidate is neither in
 * the face nor waiting to be, so it has no frame of its own. Anything else
 * is framed by its mark.
 */
export const designFrame = (
  provenance: Provenance,
  status: "accepted" | "proposed" | "rejected" | undefined
): DesignMark | "none" =>
  status === "rejected" ? "none" : designMark(provenance, status);
