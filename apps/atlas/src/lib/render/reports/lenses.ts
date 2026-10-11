import type { LensId, LensOutputs } from "../../lenses/lens-types";
import type { RenderDensity } from "../context";
import type { ReportView } from "../views";
import { buildDomainsView } from "./domains";
import { buildFileRolesView } from "./file-roles";
import { buildFrequentChangeView } from "./frequent-change";
import { buildImportTrafficView } from "./import-traffic";
import { buildNestingView } from "./nesting";
import { buildPackageSizesView } from "./package-sizes";
import { buildPlacementView } from "./placement";
import { buildProximityView } from "./proximity";
import { buildResponsibilityGroupsView } from "./responsibility-groups";
import { buildRulesView } from "./rules";

/** Each lens's report view; the lens itself returns no display strings. */
export const LENS_VIEWS: {
  [I in LensId]: (output: LensOutputs[I], density: RenderDensity) => ReportView;
} = {
  domains: buildDomainsView,
  "file-roles": buildFileRolesView,
  "frequent-change": buildFrequentChangeView,
  "import-traffic": buildImportTrafficView,
  nesting: buildNestingView,
  "package-sizes": buildPackageSizesView,
  placement: buildPlacementView,
  proximity: buildProximityView,
  "responsibility-groups": buildResponsibilityGroupsView,
  rules: buildRulesView,
};
