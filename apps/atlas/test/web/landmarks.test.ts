import { describe, expect, it } from "vitest";
import type { FileChurn } from "../../src/lib/types";
import { defaultChartSettings } from "../../src/web/chart-settings";
import { changeCrater, prominentFile } from "../../src/web/codex/bindings";
import { buildLandmarks } from "../../src/web/landmarks";
import { featureText } from "../../src/web/natural-feature-inspection";
import type { NaturalEvidence } from "../../src/web/natural-features";
import type { AtlasFile, Territory } from "../../src/web/types";

const file = (id: string, x: number, incoming = 0): AtlasFile => ({
  directory: "src",
  id,
  incoming,
  kind: "source",
  outgoing: 0,
  path: `packages/example/src/${id}.ts`,
  x,
  y: 0,
});
const shared = {
  ...file("shared", -15, 12),
  architectureKind: "commons" as const,
};
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
  files: [shared, ordinary],
  hills: [],
  id: "example",
  label: "Example",
  neighborhoods: [],
  radius: 50,
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
  relationships: [],
  unresolved: [],
};

describe("structural summits and recorded change", () => {
  it("keeps structure and churn as independent gates, with the change layer off initially", () => {
    expect(defaultChartSettings.volcanic).toBe(false);
    expect(changeCrater(2, 1)).toBe(false);
    expect(changeCrater(3, 0.79)).toBe(false);
    expect(changeCrater(3, 0.8)).toBe(true);
    expect(prominentFile(4, 1)).toBe(false);
    expect(prominentFile(5, 0.94)).toBe(false);
    expect(prominentFile(5, 0.95)).toBe(true);
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

  it("does not promote a tied population of equally used files into dependency hubs", () => {
    const tied = {
      ...territory,
      files: [file("a", -15, 20), file("b", 15, 20)],
    };
    expect(buildLandmarks(tied, [], { ...evidence, churn: undefined })).toEqual(
      []
    );
  });
});
