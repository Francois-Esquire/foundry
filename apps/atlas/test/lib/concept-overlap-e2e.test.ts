import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { renderConceptFamily, renderConcepts } from "../../src/lib/report";
import type {
  ConceptOverlapCandidate,
  SurfaceReport,
} from "../../src/lib/types";

const root = path.join(import.meta.dirname, "fixtures", "overlap");
const now = new Date("2027-01-01T00:00:00Z");

let report: SurfaceReport;

function candidate(left: string, right: string): ConceptOverlapCandidate {
  const found = report.conceptOverlap.candidates.find(
    (item) =>
      (item.left.name === left && item.right.name === right) ||
      (item.left.name === right && item.right.name === left)
  );
  if (!found) {
    throw new Error(`candidate not found: ${left} ↔ ${right}`);
  }
  return found;
}

function pairs(): string[] {
  return report.conceptOverlap.candidates.map(
    (item) => `${item.left.name}↔${item.right.name}`
  );
}

beforeAll(async () => {
  report = await analyzeSurface({
    now,
    root,
    target: "packages/domain",
    tsconfig: "tsconfig.json",
  });
});

describe("candidates", () => {
  it("finds the persisted representation across packages with both converters", () => {
    const found = candidate("RuntimeObservation", "StoredRuntimeObservation");
    expect(found.crossPackage).toBe(true);
    expect(found.right.package).toBe("@o/db");
    expect(found.right.inTarget).toBe(false);
    expect(found.dimensions).toEqual(["name", "structure", "conversion"]);
    expect(found.shapes).toEqual(["near-equivalent", "conversion-pair"]);
    // V12.6: shape properties are listed in name order, not resolution order.
    expect(found.structure?.shared).toEqual([
      "attempts",
      "id",
      "output",
      "status",
      "timestamp",
    ]);
    expect(found.structure?.rightOnly).toEqual(["createdAt"]);
    expect(found.structure?.jaccard).toBeCloseTo(5 / 6);
    expect(found.assignability).toBe("right-to-left");
    expect(found.conversions.map((item) => item.function).sort()).toEqual([
      "fromStored",
      "toStored",
    ]);
    expect(found.bidirectionalConversion).toBe(true);
  });

  it("reads a same-shape pair under a generic suffix as near-equivalent", () => {
    const found = candidate("Snapshot", "SnapshotRecord");
    expect(found.name).toEqual({ jaccard: 1, sharedTokens: ["snapshot"] });
    expect(found.assignability).toBe("both");
    expect(found.shapes).toEqual(["near-equivalent"]);
    expect(found.crossPackage).toBe(false);
  });

  it("keeps one-way assignability explicit for a projection", () => {
    const found = candidate("RuntimeObservation", "RuntimeObservationSummary");
    expect(found.assignability).toBe("left-to-right");
    expect(found.shapes).toEqual(["projection-like", "conversion-pair"]);
    expect(found.conversions.map((item) => item.function)).toEqual([
      "summarize",
    ]);
  });

  it("accepts a reshaped row on conversion plus name without property overlap", () => {
    const found = candidate("Snapshot", "SnapshotRow");
    expect(found.dimensions).toEqual(["name", "conversion"]);
    expect(found.shapes).toEqual(["conversion-pair"]);
    expect(found.structure?.shared).toEqual(["label", "taken"]);
  });

  it("looks through Promise and array wrappers in converter signatures", () => {
    const found = candidate("RuntimeObservation", "Snapshot");
    expect(found.conversions).toEqual([
      {
        file: "packages/domain/src/index.ts",
        from: "packages/domain/src/index.ts#RuntimeObservation",
        function: "snapshotsOf",
        to: "packages/domain/src/index.ts#Snapshot",
      },
    ]);
    // The converter itself is not an independent shared consumer.
    expect(found.usage?.sharedConsumers).toEqual([]);
  });
});

describe("noise protection", () => {
  it("does not pair two errors on inherited properties alone", () => {
    expect(pairs()).not.toContain(
      "ObservationNotFoundError↔StoredObservationNotFoundError"
    );
  });

  it("lets errors with own properties overlap and keeps base properties in the raw shape", () => {
    const found = candidate(
      "ObservationConflictError",
      "StoredObservationConflictError"
    );
    expect(found.shapes).toContain("near-equivalent");
    expect(found.structure?.baseShared).toEqual([
      "cause",
      "message",
      "name",
      "stack",
    ]);
    expect(found.structure?.shared).toEqual(
      expect.arrayContaining(["entity", "key", "hint", "message"])
    );
  });

  it("does not read a one-property mutually assignable pair as near-equivalent", () => {
    const found = candidate("Marker", "MarkerView");
    expect(found.assignability).toBe("both");
    expect(found.shapes).toEqual(["structurally-overlapping"]);
  });

  it("keeps the reshaped row a conversion pair", () => {
    const found = candidate("Snapshot", "SnapshotRow");
    expect(found.shapes).toContain("conversion-pair");
  });
});

describe("non-candidates", () => {
  it("never pairs on a shared generic suffix alone", () => {
    expect(pairs()).not.toContain("UserConfig↔DatabaseConfig");
    expect(pairs()).not.toContain("DatabaseConfig↔UserConfig");
  });

  it("keeps two unrelated Status declarations apart", () => {
    expect(pairs().filter((pair) => pair.includes("Status"))).toEqual([]);
    expect(
      report.conceptInventory.families.filter(
        (family) => family.seed.name === "Status"
      )
    ).toHaveLength(1);
  });

  it("does not pair a contract with its implementation", () => {
    expect(pairs()).not.toContain("Repo↔MemoryRepo");
    expect(pairs()).not.toContain("MemoryRepo↔Repo");
  });

  it("gives primitive aliases no structure", () => {
    expect(pairs().filter((pair) => pair.includes("Id"))).toEqual([]);
  });

  it("does not let common properties generate pairs", () => {
    const greek = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
    expect(
      pairs().filter((pair) => greek.some((name) => pair.includes(name)))
    ).toEqual([]);
    expect(report.conceptOverlap.generation.pairsGenerated.property).toBe(1);
    expect(report.conceptOverlap.generation.pairsGenerated.total).toBeLessThan(
      40
    );
  });
});

describe("report", () => {
  it("summarizes and leaves families untouched", () => {
    expect(report.conceptOverlap.summary).toEqual({
      bidirectionalConversionPairs: 1,
      candidates: 8,
      conversionPairs: 4,
      crossPackageCandidates: 5,
      nearEquivalent: 3,
      projectionLike: 2,
      structurallyOverlapping: 1,
    });
    expect(report.conceptInventory.summary.seeds).toBe(26);
    expect(report.schemaVersion).toBe(35);
  });

  it("renders the overlap section and the single-concept candidates", () => {
    const text = renderConcepts(report);
    expect(text).toContain("CONCEPT OVERLAP");
    expect(text).toContain("RuntimeObservation  ↔  StoredRuntimeObservation");
    expect(text).toContain("bidirectional converters toStored, fromStored");
    const family = report.conceptInventory.families.find(
      (item) => item.seed.name === "Snapshot"
    );
    if (!family) {
      throw new Error("Snapshot family missing");
    }
    const single = renderConceptFamily(
      family,
      undefined,
      report.conceptOverlap
    );
    expect(single).toContain("OVERLAP CANDIDATES");
    expect(single).toContain("SnapshotRecord");
    expect(single).toContain("SnapshotRow");
    expect(single).not.toContain("canonical");
  });
});
