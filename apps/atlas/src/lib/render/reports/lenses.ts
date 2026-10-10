import type { LensId, LensOutputs } from "../../lenses/lens-types";
import type { RenderDensity } from "../context";
import type { ReportView } from "../views";
import { buildFileRolesView } from "./file-roles";
import { buildFrequentChangeView } from "./frequent-change";
import { buildPackageSizesView } from "./package-sizes";
import { buildResponsibilityGroupsView } from "./responsibility-groups";

/** Each lens's report view; the lens itself returns no display strings. */
export const LENS_VIEWS: {
  [I in LensId]: (output: LensOutputs[I], density: RenderDensity) => ReportView;
} = {
  "file-roles": buildFileRolesView,
  "frequent-change": buildFrequentChangeView,
  "package-sizes": buildPackageSizesView,
  "responsibility-groups": buildResponsibilityGroupsView,
};
