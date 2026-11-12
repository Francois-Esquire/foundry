import type { RecordedCatalogue } from "~/generation/strategies/recorded/catalogue";

/** A source's catalogue as a screen holds it. A failed listing can be asked for again. */
export type CatalogueState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "listed"; readonly catalogue: RecordedCatalogue };
