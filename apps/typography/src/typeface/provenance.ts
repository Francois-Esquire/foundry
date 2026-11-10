/** Where a glyph design came from. Carried by candidates and added glyphs. */

export interface Region {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export type Provenance =
  | { readonly origin: "manual" }
  | {
      readonly origin: "generated";
      /** The generation strategy that produced it, for example "procedural". */
      readonly strategy: string;
      /** The model behind the strategy, when one was used. */
      readonly model?: string;
      readonly runId: string;
      readonly createdAt: string;
      /** True when the output was replayed from a recorded run, not produced live. */
      readonly recorded?: boolean;
    }
  | {
      readonly origin: "reconstructed";
      readonly evidenceId: string;
      /** Observed lettering was seen in the evidence. Inferred lettering was not. */
      readonly basis: "observed" | "inferred";
      readonly region?: Region;
      readonly confidence?: number;
    };

/** True for designs made after the source font: the blue layer in the studio. */
export const isDerived = (provenance: Provenance | undefined) =>
  provenance !== undefined;

export const isUnconfirmed = (provenance: Provenance) =>
  provenance.origin === "generated" ||
  (provenance.origin === "reconstructed" && provenance.basis === "inferred");
