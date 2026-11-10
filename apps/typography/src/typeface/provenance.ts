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
