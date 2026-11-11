/**
 * Loading a face's layout summary from the font engine, on demand. The
 * engine reads the source font file, so the summary describes the source
 * font and not feature code the project has added.
 */

import { createStore } from "~/lib/store";
import type { FontBuilder, LayoutSummary } from "~/packaging/building";

type SummaryState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly summary: LayoutSummary }
  | { readonly status: "failed"; readonly message: string };

export interface SummaryLoader {
  getState(): SummaryState;
  /** Asks the engine about one face of a font file. A newer request replaces an older one. */
  load(font: Uint8Array, faceIndex: number): void;
  subscribe(listener: () => void): () => void;
}

const IDLE: SummaryState = { status: "idle" };
const LOADING: SummaryState = { status: "loading" };

export const createSummaryLoader = (
  engine: Pick<FontBuilder, "describeLayout">
): SummaryLoader => {
  const store = createStore<SummaryState>(IDLE);
  let request = 0;

  const { setState } = store;

  return {
    getState: store.getState,
    load(font, faceIndex) {
      request += 1;
      const current = request;
      const settle = (next: SummaryState) => {
        if (current === request) {
          setState(next);
        }
      };
      setState(LOADING);
      engine.describeLayout(font, faceIndex).then(
        (summary) => settle({ status: "ready", summary }),
        (error: unknown) =>
          settle({
            message:
              error instanceof Error
                ? error.message
                : "The font engine could not read the layout tables.",
            status: "failed",
          })
      );
    },
    subscribe: store.subscribe,
  };
};

/** One substitution rule as a short line: "f i → f_i". */
export const substitutionLine = (
  substitution: LayoutSummary["features"][number]["substitutions"][number]
): string => {
  const from =
    typeof substitution.from === "string"
      ? substitution.from
      : substitution.from.join(" ");
  const to =
    typeof substitution.to === "string"
      ? substitution.to
      : substitution.to.join(substitution.kind === "alternate" ? " or " : " ");
  return `${from} → ${to}`;
};
