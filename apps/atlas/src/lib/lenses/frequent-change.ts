import { ANALYSIS_CONFIG } from "../config";
import type { ChurnHistoryInfo, ChurnReport, FileChurn } from "../types";
import { byId } from "../workspace-projection";
import type {
  FrequentChangeGate,
  FrequentChangePackage,
} from "./frequent-change-types";
import { FREQUENT_CHANGE_SCHEMA_VERSION } from "./frequent-change-types";
import type { Lens } from "./lens-types";

type ChurnFile = Pick<
  FileChurn,
  "file" | "kind" | "commits" | "linesChanged"
> & {
  rank: Pick<FileChurn["rank"], "commitPercentile">;
};

type ChurnHistory = Pick<
  ChurnHistoryInfo,
  "analyzedAt" | "historyComplete" | "since"
>;

/** Every dataset field the lens reads, and the gate it applies. */
export interface FrequentChangeSource {
  gate: FrequentChangeGate;
  packages: {
    churn:
      | { available: true; files: readonly ChurnFile[]; history: ChurnHistory }
      | { available: false };
    id: string;
  }[];
}

/** The gate exactly as `lib`'s hotspots apply it: an eligible kind at or above the commit percentile. */
function passesGate(file: ChurnFile, gate: FrequentChangeGate): boolean {
  return (
    gate.eligibleKinds.includes(file.kind) &&
    file.rank.commitPercentile >= gate.minCommitPercentile
  );
}

/** Only the churn fields the lens reads, so a package report is not kept once read. */
function projectChurn(
  churn: Extract<ChurnReport, { available: true }>
): FrequentChangeSource["packages"][number]["churn"] {
  const { history } = churn;
  return {
    available: true,
    files: churn.files.map(({ commits, file, kind, linesChanged, rank }) => ({
      commits,
      file,
      kind,
      linesChanged,
      rank: { commitPercentile: rank.commitPercentile },
    })),
    history: {
      analyzedAt: history.analyzedAt,
      historyComplete: history.historyComplete,
      ...(history.since !== undefined && { since: history.since }),
    },
  };
}

/**
 * Each package's files that change frequently: its churn's files that pass
 * the hotspot commit gate, read from `lib`'s built-in analysis policy so
 * that the lens and the hotspots share one definition. Every hotspot
 * changes frequently; a frequently changed file need not be a hotspot.
 */
export const frequentChangeLens: Lens<"frequent-change", FrequentChangeSource> =
  {
    derive: ({ gate, packages }) => {
      const missing: string[] = [];
      const measured: FrequentChangePackage[] = [];
      for (const pkg of packages) {
        if (!pkg.churn.available) {
          missing.push(pkg.id);
          continue;
        }
        measured.push({
          files: pkg.churn.files
            .filter((file) => passesGate(file, gate))
            .map((file) => ({
              commitPercentile: file.rank.commitPercentile,
              commits: file.commits,
              file: file.file,
              linesChanged: file.linesChanged,
            }))
            .sort((a, b) => byId(a.file, b.file)),
          history: pkg.churn.history,
          id: pkg.id,
        });
      }
      return {
        gate,
        missing: missing.sort(byId),
        packages: measured.sort((a, b) => byId(a.id, b.id)),
      };
    },
    id: "frequent-change",
    // Package reports are large, so they are read one at a time and only
    // the churn fields are kept; the lens reader does not cache them.
    read: async (reader) => {
      const { eligibleKinds, gates } = ANALYSIS_CONFIG.hotspots;
      const packages: FrequentChangeSource["packages"] = [];
      for (const pkg of reader.packages()) {
        if (pkg.status !== "complete") {
          continue;
        }
        const { churn } = await reader.packageReport(pkg.id);
        packages.push({
          churn: churn.available ? projectChurn(churn) : { available: false },
          id: pkg.id,
        });
      }
      return {
        gate: {
          eligibleKinds: [...eligibleKinds],
          minCommitPercentile: gates.minCommitPercentile,
        },
        packages,
      };
    },
    schemaVersion: FREQUENT_CHANGE_SCHEMA_VERSION,
    settings: [],
  };
