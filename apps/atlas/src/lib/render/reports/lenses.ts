import type { LensId, LensOutputs } from "../../lenses/lens-types";
import type { RenderDensity } from "../context";
import type { ReportView } from "../views";
import { buildPackageSizesView } from "./package-sizes";

/** Each lens's report view; the lens itself returns no display strings. */
export const LENS_VIEWS: {
  [I in LensId]: (output: LensOutputs[I], density: RenderDensity) => ReportView;
} = {
  "package-sizes": buildPackageSizesView,
};
