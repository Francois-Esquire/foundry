import { describe, expect, it } from "vitest";
import { defaultChartSettings } from "../../src/web/chart-settings";
import { landmarkRadius } from "../../src/web/codex/bindings";
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
  radius: 50,
  responsibilityGroups: undefined,
  shallows: [],
  x: 0,
  y: 0,
};
const gate = { eligibleKinds: ["source" as const], minCommitPercentile: 0.9 };
const history = {
  analyzedAt: "2026-09-30T00:00:00Z",
  historyComplete: false,
  since: "2025-09-30T00:00:00Z",
};
const frequent = (module: AtlasFile, commits = 5) => ({
  commitPercentile: 0.92,
  commits,
  file: module.path,
  linesChanged: 100,
});
/** The island's recorded change: the `frequent-change` lens's entry, as the loader binds it. */
const recorded = (files: ReturnType<typeof frequent>[]) => ({
  available: true as const,
  files,
  gate,
  history,
});
const evidence: NaturalEvidence = {
  fileIds: {},
  fileRoles: { [shared.id]: "commons" },
  frequentChange: recorded([frequent(shared), frequent(ordinary)]),
  relationships: [],
  unresolved: [],
};

describe("structural summits and recorded change", () => {
  it("marks change only where the frequent-change lens names the file, with the change layer off initially", () => {
    expect(defaultChartSettings.volcanic).toBe(false);
    const named = buildLandmarks(territory, [], {
      ...evidence,
      frequentChange: recorded([frequent(shared)]),
    });
    expect(named.map((mark) => [mark.file.id, mark.kind])).toEqual([
      ["shared", "volcano"],
    ]);
    const unread = buildLandmarks(territory, [], {
      ...evidence,
      frequentChange: undefined,
    });
    expect(unread.map((mark) => [mark.file.id, mark.kind])).toEqual([
      ["shared", "summit"],
    ]);
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
    expect(text).toContain(
      "92nd commit percentile among workspace files of the same kind, at or above the 90th that frequent change requires"
    );
  });

  it("does not substitute missing history or basename matches for measured change", () => {
    for (const reason of ["no-history", "not-saved"] as const) {
      const unavailable = buildLandmarks(territory, [], {
        ...evidence,
        frequentChange: { available: false, reason },
      });
      expect(unavailable.map((mark) => mark.kind)).toEqual(["summit"]);
    }
    const wrongPath = buildLandmarks(territory, [], {
      ...evidence,
      frequentChange: recorded([
        { ...frequent(ordinary), file: "elsewhere/ordinary.ts" },
      ]),
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
      fileRoles: {},
      frequentChange: undefined,
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
      fileRoles: { commons: "commons" },
      frequentChange: undefined,
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
