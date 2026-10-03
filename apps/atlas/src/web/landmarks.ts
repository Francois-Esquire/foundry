import type { ChurnHistoryInfo, FileChurn } from "../lib/types";
import type { BelongingRegion } from "./belonging";
import { changeCrater, landmarkRadius, prominentFile } from "./codex/bindings";
import { clearOfCoast } from "./composition-placement";
import { landmarkFootprint } from "./landmark-footprint";
import type { FeaturePoint, NaturalEvidence } from "./natural-features";
import type { AtlasFile, Territory } from "./types";

export interface Landmark {
  change?: {
    file: FileChurn;
    history: ChurnHistoryInfo;
  };
  consumers: { id: string; label: string }[];
  file: AtlasFile;
  footprint: FeaturePoint[];
  kind: "summit" | "crater" | "volcano";
  radius: number;
  role: "commons" | "junction" | "dependents" | "change";
}

function structuralRole(
  file: AtlasFile,
  files: readonly AtlasFile[]
): Landmark["role"] {
  if (
    file.architectureKind === "commons" ||
    file.architectureKind === "junction"
  ) {
    return file.architectureKind;
  }
  const lower = files.filter((other) => other.incoming < file.incoming).length;
  return prominentFile(file.incoming, lower / Math.max(1, files.length))
    ? "dependents"
    : "change";
}

/** One real file, one mark. Unknown history never becomes zero churn. */
export function buildLandmarks(
  territory: Territory,
  regions: readonly BelongingRegion[],
  evidence: NaturalEvidence
): Landmark[] {
  const classified = new Map(
    regions.flatMap((region) =>
      region.members.map((file) => [file.id, file] as const)
    )
  );
  const files = territory.files.length
    ? territory.files.map((file) => classified.get(file.id) ?? file)
    : [...classified.values()];
  const churn = evidence.churn?.available ? evidence.churn : undefined;
  const changes = new Map(churn?.files.map((file) => [file.file, file]));
  const result: Landmark[] = [];
  for (const file of files) {
    const recorded = changes.get(file.path);
    const change =
      recorded &&
      churn &&
      changeCrater(recorded.commits, recorded.rank.commitPercentile)
        ? { file: recorded, history: churn.history }
        : undefined;
    const role = structuralRole(file, files);
    if (role === "change" && !change) {
      continue;
    }
    let radius = landmarkRadius(file.incoming);
    while (
      radius >= 1.6 &&
      !clearOfCoast(file.x, file.y, territory.coast, radius + 1)
    ) {
      radius -= 0.4;
    }
    if (radius < 1.6) {
      continue;
    }
    const changedKind = role === "change" ? "crater" : "volcano";
    result.push({
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
      file,
      footprint: landmarkFootprint(file, radius, files),
      kind: change ? changedKind : "summit",
      radius,
      role,
    });
  }
  return result.sort((a, b) => a.file.id.localeCompare(b.file.id));
}
