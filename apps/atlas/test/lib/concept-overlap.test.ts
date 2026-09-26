import { describe, expect, it } from "vitest";
import type { OverlapFacts } from "../../src/lib/concept-overlap";
import {
  assessOverlap,
  nameAffinity,
  nameTokens,
  sortCandidates,
} from "../../src/lib/concept-overlap";
import type { AnalysisConfig } from "../../src/lib/config";

import { ANALYSIS_CONFIG } from "../../src/lib/config";
import type {
  ConceptIdentity,
  ConceptPropertyOverlap,
} from "../../src/lib/types";

function identity(name: string, pkg = "@t/core"): ConceptIdentity {
  const dir = pkg.replace("@t/", "");
  return {
    file: `packages/${dir}/src/${name.toLowerCase()}.ts`,
    id: `packages/${dir}/src/${name.toLowerCase()}.ts#${name}`,
    inTarget: pkg === "@t/core",
    kind: "interface",
    name,
    package: pkg,
  };
}

function structure(
  shared: string[],
  leftOnly: string[],
  rightOnly: string[],
  compatible = shared
): ConceptPropertyOverlap {
  const left = shared.length + leftOnly.length;
  const right = shared.length + rightOnly.length;
  return {
    baseShared: [],
    compatibleShared: compatible,
    jaccard: shared.length / (left + right - shared.length),
    leftOnly,
    rightOnly,
    shared,
    sharedOverLeft: shared.length / left,
    sharedOverRight: shared.length / right,
  };
}

const temporal = {
  coChangeCommits: 9,
  context: "source-source" as const,
  jaccard: 0.6,
  leftConditional: 0.82,
  rightConditional: 0.75,
  staticPath: "indirect" as const,
};

function facts(overrides: Partial<OverlapFacts>): OverlapFacts {
  return {
    conversions: [],
    left: identity("RuntimeObservation"),
    right: identity("StoredRuntimeObservation", "@t/db"),
    ...overrides,
  };
}

describe("name tokens", () => {
  it("splits camel, pascal, snake, and kebab case", () => {
    expect(nameTokens("StoredRuntimeObservation")).toEqual([
      "stored",
      "runtime",
      "observation",
    ]);
    expect(nameTokens("workspace_file-id")).toEqual([
      "workspace",
      "file",
      "id",
    ]);
    expect(nameTokens("HTTPServerConfig")).toEqual([
      "http",
      "server",
      "config",
    ]);
  });

  it("drops generic tokens and measures affinity on the rest", () => {
    expect(nameAffinity("Workspace", "WorkspaceRecord")).toEqual({
      jaccard: 1,
      sharedTokens: ["workspace"],
    });
    expect(nameAffinity("UserConfig", "DatabaseConfig")).toBeUndefined();
    expect(
      nameAffinity("RuntimeObservation", "StoredRuntimeObservation")
    ).toEqual({
      jaccard: 2 / 3,
      sharedTokens: ["observation", "runtime"],
    });
  });
});

describe("gate", () => {
  it("rejects name affinity alone", () => {
    expect(
      assessOverlap(
        facts({ name: { jaccard: 1, sharedTokens: ["observation"] } })
      )
    ).toBeUndefined();
  });

  it("rejects temporal coupling alone, however strong", () => {
    expect(
      assessOverlap(
        facts({
          temporalContext: { ...temporal, coChangeCommits: 40 },
          usage: {
            sharedConsumers: ["packages/core/src/x.ts#use"],
            sharedModules: [],
          },
        })
      )
    ).toBeUndefined();
  });

  it("rejects two dimensions without a structural condition", () => {
    expect(
      assessOverlap(
        facts({
          name: { jaccard: 1, sharedTokens: ["observation"] },
          temporalContext: temporal,
        })
      )
    ).toBeUndefined();
  });

  it("accepts name plus property overlap", () => {
    const candidate = assessOverlap(
      facts({
        assignability: "right-to-left",
        name: { jaccard: 2 / 3, sharedTokens: ["observation", "runtime"] },
        structure: structure(
          ["id", "status", "timestamp", "output"],
          [],
          ["createdAt"]
        ),
      })
    );
    expect(candidate?.dimensions).toEqual(["name", "structure"]);
    expect(candidate?.shapes).toEqual(["near-equivalent"]);
    expect(candidate?.crossPackage).toBe(true);
    expect(candidate?.evidence).toEqual([
      {
        dimension: "name",
        kind: "name-token-overlap",
        value: ["observation", "runtime"],
      },
      { dimension: "structure", kind: "property-overlap", value: 0.8 },
      { dimension: "structure", kind: "assignability", value: "right-to-left" },
    ]);
  });

  it("keeps a candidate when the coupling fixture is removed", () => {
    const withHistory = facts({
      assignability: "right-to-left",
      structure: structure(["id", "status", "timestamp"], [], ["createdAt"]),
      temporalContext: temporal,
    });
    const before = assessOverlap(withHistory);
    expect(before?.dimensions).toEqual(["structure", "temporal"]);
    expect(before?.temporalContext).toEqual(temporal);
    const { temporalContext: _dropped, ...withoutHistory } = withHistory;
    const after = assessOverlap({
      ...withoutHistory,
      name: { jaccard: 0.5, sharedTokens: ["observation"] },
    });
    expect(after?.dimensions).toEqual(["name", "structure"]);
    expect(after?.temporalContext).toBeUndefined();
  });

  it("honours injected thresholds", () => {
    const config: AnalysisConfig = {
      ...ANALYSIS_CONFIG,
      conceptOverlap: {
        ...ANALYSIS_CONFIG.conceptOverlap,
        gates: { minEvidenceDimensions: 3 },
      },
    };
    const two = facts({
      assignability: "both",
      name: { jaccard: 1, sharedTokens: ["observation"] },
      structure: structure(["a", "b", "c"], [], []),
    });
    expect(assessOverlap(two, config)).toBeUndefined();
    expect(
      assessOverlap({ ...two, temporalContext: temporal }, config)
    ).toBeDefined();
  });
});

describe("shapes", () => {
  it("names a near-equivalent pair without calling it a duplicate", () => {
    const candidate = assessOverlap(
      facts({
        assignability: "both",
        name: { jaccard: 1, sharedTokens: ["snapshot"] },
        structure: structure(["id", "label", "status", "taken"], [], []),
      })
    );
    expect(candidate?.shapes).toEqual(["near-equivalent"]);
    expect(JSON.stringify(candidate)).not.toContain("duplicate");
  });

  it("reads one-way assignability as projection-like", () => {
    const candidate = assessOverlap(
      facts({
        assignability: "left-to-right",
        name: { jaccard: 0.5, sharedTokens: ["observation"] },
        structure: structure(["id", "status"], ["timestamp", "output"], []),
      })
    );
    expect(candidate?.shapes).toEqual(["projection-like"]);
    expect(candidate?.assignability).toBe("left-to-right");
  });

  it("does not read same names with incompatible types as a projection", () => {
    const candidate = assessOverlap(
      facts({
        assignability: "neither",
        name: { jaccard: 0.5, sharedTokens: ["settle"] },
        structure: structure(["a", "b", "c", "d"], [], [], ["a"]),
      })
    );
    expect(candidate?.shapes).toEqual(["structurally-overlapping"]);
  });

  it("marks converters and detects both directions", () => {
    const left = identity("RuntimeObservation");
    const right = identity("StoredRuntimeObservation", "@t/db");
    const oneWay = assessOverlap(
      facts({
        conversions: [
          {
            file: right.file,
            from: left.id,
            function: "toStored",
            to: right.id,
          },
        ],
        name: { jaccard: 2 / 3, sharedTokens: ["observation", "runtime"] },
      })
    );
    expect(oneWay?.shapes).toEqual(["conversion-pair"]);
    expect(oneWay?.bidirectionalConversion).toBe(false);
    const bothWays = assessOverlap(
      facts({
        conversions: [
          {
            file: right.file,
            from: left.id,
            function: "toStored",
            to: right.id,
          },
          {
            file: right.file,
            from: right.id,
            function: "fromStored",
            to: left.id,
          },
        ],
        name: { jaccard: 2 / 3, sharedTokens: ["observation", "runtime"] },
      })
    );
    expect(bothWays?.bidirectionalConversion).toBe(true);
    expect(bothWays?.evidence.map((item) => item.value)).toEqual([
      ["observation", "runtime"],
      `toStored: ${left.id} → ${right.id}`,
      `fromStored: ${right.id} → ${left.id}`,
    ]);
  });

  it("does not read two errors sharing only base properties as near-equivalent", () => {
    const base = ["name", "message", "stack", "cause"];
    const errors = assessOverlap(
      facts({
        assignability: "both",
        left: identity("ArtifactNotFoundError"),
        name: { jaccard: 0.5, sharedTokens: ["found", "not"] },
        right: identity("WorkspaceNotFoundError", "@t/db"),
        structure: { ...structure(base, [], []), baseShared: base },
      })
    );
    expect(errors).toBeUndefined();
    const ownProperties = assessOverlap(
      facts({
        assignability: "both",
        left: identity("ArtifactNotFoundError"),
        name: { jaccard: 0.5, sharedTokens: ["found", "not"] },
        right: identity("WorkspaceNotFoundError", "@t/db"),
        structure: {
          ...structure([...base, "entity", "key", "hint"], [], []),
          baseShared: base,
        },
      })
    );
    expect(ownProperties?.shapes).toEqual(["near-equivalent"]);
    expect(ownProperties?.structure?.shared).toHaveLength(7);
  });

  it("does not read a tiny mutually assignable pair as near-equivalent", () => {
    const candidate = assessOverlap(
      facts({
        assignability: "both",
        name: { jaccard: 1, sharedTokens: ["marker"] },
        structure: structure(["on"], [], []),
      })
    );
    expect(candidate?.shapes).toEqual(["structurally-overlapping"]);
    expect(candidate?.assignability).toBe("both");
  });

  it("keeps a converter pair strong whatever the structural overlap", () => {
    const left = identity("Release");
    const right = identity("ReleaseRow", "@t/db");
    const candidate = assessOverlap(
      facts({
        assignability: "neither",
        conversions: [
          { file: right.file, from: left.id, function: "toRow", to: right.id },
          {
            file: right.file,
            from: right.id,
            function: "fromRow",
            to: left.id,
          },
        ],
        left,
        name: { jaccard: 0.5, sharedTokens: ["release"] },
        right,
        structure: structure(
          ["id"],
          ["version", "notes"],
          ["releaseId", "createdAt"]
        ),
      })
    );
    expect(candidate?.shapes).toEqual(["conversion-pair"]);
    expect(candidate?.bidirectionalConversion).toBe(true);
    expect(candidate?.dimensions).toEqual(["name", "conversion"]);
  });

  it("lets conversion and projection coexist", () => {
    const candidate = assessOverlap(
      facts({
        assignability: "neither",
        conversions: [
          {
            file: "packages/core/src/x.ts",
            from: "x",
            function: "settings",
            to: "y",
          },
        ],
        structure: structure(["a", "b", "c", "d"], ["e", "f"], []),
      })
    );
    expect(candidate?.shapes).toEqual(["projection-like", "conversion-pair"]);
  });
});

describe("ordering", () => {
  it("sorts by dimensions, Jaccard, conversion, then ids", () => {
    const a = assessOverlap(
      facts({
        assignability: "both",
        left: identity("B"),
        name: { jaccard: 1, sharedTokens: ["x"] },
        right: identity("C"),
        structure: structure(["a", "b", "c"], [], []),
      })
    );
    const b = assessOverlap(
      facts({
        assignability: "both",
        left: identity("A"),
        name: { jaccard: 1, sharedTokens: ["x"] },
        right: identity("C"),
        structure: structure(["a", "b", "c"], [], ["d"]),
        temporalContext: temporal,
      })
    );
    const c = assessOverlap(
      facts({
        assignability: "both",
        left: identity("A"),
        name: { jaccard: 1, sharedTokens: ["x"] },
        right: identity("B"),
        structure: structure(["a", "b", "c"], [], []),
      })
    );
    if (!(a && b && c)) {
      throw new Error("expected candidates");
    }
    expect(
      sortCandidates([a, b, c]).map(
        (item) => `${item.left.name}-${item.right.name}`
      )
    ).toEqual(["A-C", "A-B", "B-C"]);
  });
});
