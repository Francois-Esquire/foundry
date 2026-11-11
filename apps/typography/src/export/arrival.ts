/**
 * What an address asks of the plan when a person arrives from another place:
 * the faces to export, and either every character or, for a subset, the one
 * writing system to keep. An address that names no writing system asks for
 * the faces whole, so a selection left from an earlier visit does not cut
 * them down unasked. The family name, the format and the features stay as
 * they were chosen here.
 */
import { pinnedInstancesOf, type TypefaceProject } from "~/typeface/project";
import type { ExportAddress } from "./export-address";
import type { PlanDraft } from "./plan-draft";

export type Arrival =
  | { readonly kind: "planned"; readonly draft: PlanDraft }
  /** The address names something the project lacks. The plan is left as it was. */
  | { readonly kind: "missed"; readonly reason: string };

const NO_SELECTION = {
  blocks: [],
  languages: [],
  ranges: "",
  scripts: [],
  sharedGroups: [],
  typed: "",
} as const;

const NO_FACE =
  "The face in this address is not in the project, so the plan is as it was. Choose the faces to export below.";

export const arrivalOf = (
  address: ExportAddress,
  project: TypefaceProject,
  draft: PlanDraft
): Arrival => {
  const face = project.faces.find((known) => known.id === address.faceId);
  if (!face) {
    return { kind: "missed", reason: NO_FACE };
  }
  if (address.kind === "instances") {
    const instances = pinnedInstancesOf(project, face);
    return instances.length > 0
      ? {
          draft: {
            ...draft,
            faceIds: instances.map((pinned) => pinned.id),
            keep: "everything",
          },
          kind: "planned",
        }
      : {
          kind: "missed",
          reason: `${face.description.familyName} has no pinned instance yet, so the plan is as it was. Pin one in the Studio, or generate across weights in Generate.`,
        };
  }
  if (address.unknownScope !== undefined) {
    return {
      kind: "missed",
      reason: `No writing system is called ${address.unknownScope}, so the plan is as it was. Choose what to keep under Characters.`,
    };
  }
  const { scope } = address;
  if (!scope) {
    return {
      draft: { ...draft, faceIds: [face.id], keep: "everything" },
      kind: "planned",
    };
  }
  return {
    draft: {
      ...draft,
      ...NO_SELECTION,
      faceIds: [face.id],
      keep: "selection",
      scripts: scope.kind === "script" ? [scope.code] : [],
      sharedGroups: scope.kind === "shared" ? [scope.group] : [],
    },
    kind: "planned",
  };
};
