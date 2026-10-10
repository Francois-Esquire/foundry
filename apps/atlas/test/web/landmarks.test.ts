import { describe, expect, it } from "vitest";
import type { FileChurn } from "../../src/lib/types";
import { defaultChartSettings } from "../../src/web/chart-settings";
import { changeCrater, landmarkRadius } from "../../src/web/codex/bindings";
import { buildLandmarks } from "../../src/web/landmarks";
import { featureText } from "../../src/web/natural-feature-inspection";
import type { NaturalEvidence } from "../../src/web/natural-features";
import type { AtlasFile, Territory } from "../../src/web/types";

const file = (id: string, x: number, incoming = 0): AtlasFile => ({
  directory: "src",
  highFanIn: false,
  id,
  incoming,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path: `packages/example/src/${id}.ts`,
  x,
  y: 0,
});
const shared = file("shared", -15, 12);
const ordinary = file("ordinary", 15);
const territory: Territory = {
  analyzed: true,
  coast: [
    [
      [
        [-50, -50],
        [50, -50],
        [50, 50],
        [-50, 50],
        [-50, -50],
      ],
    ],
  ],
  color: "#fff",
  fileRoles: undefined,
  files: [shared, ordinary],
  highFanInCutoff: 0,
  hills: [],
  id: "example",
  label: "Example",
  neighborhoods: [],
  radius: 50,
  responsibilityGroups: undefined,
  shallows: [],
  x: 0,
  y: 0,
};
const change = (module: AtlasFile, commits = 5): FileChurn => ({
  additions: 70,
  authors: 1,
  commits,
  deletions: 30,
  file: module.path,
  kind: "source",
  linesChanged: 100,
  rank: { commitPercentile: 0.85, lineChurnPercentile: 0.4 },
});
const evidence: NaturalEvidence = {
  churn: {
    available: true,
    files: [change(shared), change(ordinary)],
    history: {
      analyzedAt: "2026-09-30T00:00:00Z",
      commitsAnalyzed: 20,
      historyComplete: false,
      since: "2025-09-30T00:00:00Z",
      windowDays: 365,
    },
  },
  fileIds: {},
  fileRoles: { [shared.id]: "commons" },
  relationships: [],
  unresolved: [],
};

describe("structural summits and recorded change", () => {
  it("keeps the change gate apart from structure, with the change layer off initially", () => {
    expect(defaultChartSettings.volcanic).toBe(false);
    expect(changeCrater(2, 1)).toBe(false);
    expect(changeCrater(3, 0.79)).toBe(false);
    expect(changeCrater(3, 0.8)).toBe(true);
  });

  it("draws one volcano for a shared changed file and a low crater for an ordinary changed file", () => {
    const landmarks = buildLandmarks(territory, [], evidence);
    expect(landmarks.map((mark) => [mark.file.id, mark.kind])).toEqual([
      ["ordinary", "crater"],
      ["shared", "volcano"],
    ]);
    expect(landmarks.find((mark) => mark.file.id === "shared")?.file).toBe(
      shared
    );
    const [crater] = landmarks;
    expect(crater).toBeDefined();
    if (!crater) {
      throw new Error("Missing crater");
    }
    const text = featureText({ kind: "landmark", landmark: crater }).detail;
    expect(text).toContain("5 commits");
    expect(text).toContain("100 lines added/deleted");
    expect(text).toContain("2025-09-30");
    expect(text).toContain("partial Git history");
  });

  it("does not substitute missing history or basename matches for measured change", () => {
    const missing = buildLandmarks(territory, [], {
      ...evidence,
      churn: undefined,
    });
    expect(missing.map((mark) => mark.kind)).toEqual(["summit"]);
    const unavailable = buildLandmarks(territory, [], {
      ...evidence,
      churn: { available: false, reason: "not-collected" },
    });
    expect(unavailable.map((mark) => mark.kind)).toEqual(["summit"]);
    if (!evidence.churn?.available) {
      throw new Error("Missing fixture history");
    }
    const wrongPath = buildLandmarks(territory, [], {
      ...evidence,
      churn: {
        ...evidence.churn,
        files: [{ ...change(ordinary), file: "elsewhere/ordinary.ts" }],
      },
    });
    expect(wrongPath.map((mark) => mark.kind)).toEqual(["summit"]);
  });

  it("marks high fan-in only where the package's topology says so, however many imports reach a file", () => {
    const summit = {
      ...file("summit", 15, 2),
      highFanIn: true,
      internalFanIn: 4,
    };
    const busy = { ...file("busy", -15, 40), internalFanIn: 2 };
    const island = { ...territory, files: [busy, summit], highFanInCutoff: 3 };
    const landmarks = buildLandmarks(island, [], {
      ...evidence,
      churn: undefined,
      fileRoles: {},
    });
    expect(landmarks.map((item) => [item.file.id, item.basis])).toEqual([
      ["summit", "high-fan-in"],
    ]);
    const [mark] = landmarks;
    if (!mark) {
      throw new Error("Missing high fan-in landmark");
    }
    expect(mark.radius).toBe(landmarkRadius(4, 3));
    expect(featureText({ kind: "landmark", landmark: mark }).detail).toBe(
      "High fan-in · 4 source modules of this package import it, at or above its high fan-in cutoff of 3."
    );
  });

  it("gives the fan-in of a commons file that is also high fan-in, ahead of its import edges", () => {
    const commons = {
      ...file("commons", 15, 30),
      highFanIn: true,
      internalFanIn: 7,
    };
    const island = { ...territory, files: [commons], highFanInCutoff: 5 };
    const [mark] = buildLandmarks(island, [], {
      ...evidence,
      churn: undefined,
      fileRoles: { commons: "commons" },
    });
    expect(mark?.basis).toBe("commons");
    if (!mark) {
      throw new Error("Missing commons landmark");
    }
    expect(featureText({ kind: "landmark", landmark: mark }).detail).toBe(
      "Shared commons · 7 source modules of this package import it, at or above its high fan-in cutoff of 5."
    );
  });
});
