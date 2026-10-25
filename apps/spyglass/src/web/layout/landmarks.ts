import type { FileRole } from "../../lib/lenses/file-roles-types";
import type {
  FrequentChangeFile,
  FrequentChangeGate,
  FrequentChangeHistory,
} from "../../lib/lenses/frequent-change-types";
import { landmarkRadius } from "../data/bindings";
import type { SpyglassFile, Territory } from "../data/types";
import type { BelongingRegion } from "./belonging";
import { clearOfCoast } from "./composition-placement";
import { landmarkFootprint } from "./landmark-footprint";
import type { FeaturePoint, NaturalEvidence } from "./natural-features";

export interface Landmark {
  /** What makes the file a landmark: its file role, its high fan-in, or else its recorded change. */
  basis: "commons" | "junction" | "high-fan-in" | "change";
  /** Recorded change, for a file the `frequent-change` lens names: its entry, the gate that named it, and the package's history. */
  change?: {
    file: FrequentChangeFile;
    gate: FrequentChangeGate;
    history: FrequentChangeHistory;
  };
  consumers: { id: string; label: string }[];
  /** The package's saved high fan-in cutoff the file's internal fan-in is read against. */
  cutoff: number;
  file: SpyglassFile;
  footprint: FeaturePoint[];
  kind: "summit" | "crater" | "volcano";
  radius: number;
}

function structuralBasis(
  file: SpyglassFile,
  role: FileRole | undefined
): Landmark["basis"] {
  if (role === "commons" || role === "junction") {
    return role;
  }
  return file.highFanIn ? "high-fan-in" : "change";
}

/** One real file, one mark. Unknown history never becomes zero churn. */
export function buildLandmarks(
  territory: Territory,
  regions: readonly BelongingRegion[],
  evidence: NaturalEvidence
): Landmark[] {
  const members = new Map(
    regions.flatMap((region) =>
      region.members.map((file) => [file.id, file] as const)
    )
  );
  const files = territory.files.length
    ? territory.files
    : [...members.values()];
  const cutoff = territory.highFanInCutoff;
  const recorded = evidence.frequentChange?.available
    ? evidence.frequentChange
    : undefined;
  const frequent = new Map(recorded?.files.map((file) => [file.file, file]));
  const result: Landmark[] = [];
  for (const file of files) {
    const changed = frequent.get(file.path);
    const change =
      recorded && changed
        ? { file: changed, gate: recorded.gate, history: recorded.history }
        : undefined;
    const basis = structuralBasis(file, evidence.fileRoles[file.id]);
    if (basis === "change" && !change) {
      continue;
    }
    let radius = landmarkRadius(file.internalFanIn, cutoff);
    while (
      radius >= 1.6 &&
      !clearOfCoast(file.x, file.y, territory.coast, radius + 1)
    ) {
      radius -= 0.4;
    }
    if (radius < 1.6) {
      continue;
    }
    const changedKind = basis === "change" ? "crater" : "volcano";
    result.push({
      basis,
      change,
      consumers: regions
        .filter((region) =>
          evidence.relationships.some(
            (link) =>
              link.from === region.id &&
              link.targetModules.some(
                (module) => evidence.fileIds[module] === file.id
              )
          )
        )
        .map((region) => ({ id: region.id, label: region.label })),
      cutoff,
      file,
      footprint: landmarkFootprint(file, radius, files),
      kind: change ? changedKind : "summit",
      radius,
    });
  }
  return result.sort((a, b) => a.file.id.localeCompare(b.file.id));
}
