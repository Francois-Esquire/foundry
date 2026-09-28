import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { operatorFingerprint } from "../../../src/lib/architectural-operator";
import type { ArchitecturalOperator } from "../../../src/lib/operator-types";
import { OPERATOR_SCHEMA_VERSION } from "../../../src/lib/operator-types";
import type { Spec } from "./workspace-builder";

// Shared by the V11.3 planning and V11.4 readiness suites: the synthetic
// workspace facts that describe test/fixtures/planning, a manual internalize
// operator, and a tree hash for the no-write guarantee.

export const planningRoot = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "planning"
);

export const STATUS = "packages/core/src/status.ts#Status";
export const SHAPE = "packages/core/src/shape.ts#Shape";
export const SPRITE = "packages/core/src/sprite.ts#Sprite";
export const WIDGET = "packages/core/src/widget.ts#Widget";
export const TOKEN = "packages/store/src/token.ts#Token";
export const RANGE = "packages/util/src/range.ts#Range";
export const REGISTRY = "packages/core/src/registry.ts#Registry";
export const PANEL = "packages/core/src/panel.ts#Panel";
export const HELPER = "packages/core/src/helper.ts#helperOnly";
export const STARRED = "packages/core/src/star.ts#starred";

export function planningSpec(): Spec {
  return {
    concepts: [
      {
        behavior: {
          "@p/core": { sourceBehaviors: 1 },
          "@p/store": { sourceBehaviors: 1 },
        },
        center: { behavior: "@p/store", semantic: "@p/core" },
        id: STATUS,
        package: "@p/core",
        participation: {
          "@p/app": { references: 1 },
          "@p/core": { references: 2 },
          "@p/store": { implementations: 1, references: 3 },
        },
      },
      {
        behavior: { "@p/store": { sourceBehaviors: 1 } },
        center: { behavior: "@p/store", semantic: "@p/core" },
        id: SHAPE,
        package: "@p/core",
        participation: {
          "@p/core": { implementations: 1, references: 1 },
          "@p/store": { implementations: 1, references: 1 },
        },
      },
      {
        behavior: { "@p/store": { sourceBehaviors: 1 } },
        id: SPRITE,
        package: "@p/core",
        participation: { "@p/store": { implementations: 1, references: 1 } },
      },
      {
        id: WIDGET,
        kind: "class",
        package: "@p/core",
        participation: { "@p/app": { references: 2 } },
      },
      {
        id: TOKEN,
        package: "@p/store",
        participation: {
          "@p/app": { references: 1 },
          "@p/cli": { references: 1 },
          "@p/store": { implementations: 1 },
        },
      },
      {
        id: RANGE,
        package: "@p/util",
        participation: {
          "@p/core": { references: 2 },
          "@p/store": { references: 1 },
          "@p/util": { implementations: 1 },
        },
      },
      {
        id: REGISTRY,
        kind: "class",
        package: "@p/core",
        participation: { "@p/core": { references: 1 } },
      },
      {
        id: PANEL,
        kind: "class",
        package: "@p/core",
        participation: { "@p/app": { references: 1 } },
      },
    ],
    edges: [
      "@p/app→@p/core:3",
      "@p/app→@p/store:2",
      "@p/store→@p/core:4",
      "@p/core→@p/util:2",
      "@p/store→@p/util:2",
      "@p/cli→@p/store:1",
    ],
    packages: ["@p/core", "@p/store", "@p/app", "@p/util", "@p/cli"],
  };
}

export function internalizeOperator(
  symbolId: string,
  pkg: string
): ArchitecturalOperator {
  return {
    constraints: [],
    evidence: [{ entityIds: [symbolId], source: "surface" }],
    expectedEffects: [
      {
        certainty: "certain",
        change: "surface-internalization",
        dimension: "surface",
        evidenceRefs: [],
        from: "package-public",
        to: "internal",
      },
    ],
    fingerprint: operatorFingerprint([`public-surface-state:${symbolId}=true`]),
    id: `operator:internalize:${symbolId}`,
    intent: { reason: "leaves the public surface", source: "manual" },
    kind: "internalize",
    placement: { current: { package: pkg } },
    preconditions: [],
    preservations: [{ entityIds: [symbolId], kind: "runtime-behavior" }],
    schemaVersion: OPERATOR_SCHEMA_VERSION,
    status: "valid",
    subject: {
      kind: "symbol",
      name: symbolId.split("#")[1] ?? symbolId,
      package: pkg,
      symbolId,
    },
    verification: [
      { expected: [symbolId, "internal"], kind: "public-surface" },
      { expected: true, kind: "typecheck" },
    ],
  };
}

/** Drop the consumer-import-path preservation: the operator permits a breaking relocation. */
export function openOperator(
  operator: ArchitecturalOperator
): ArchitecturalOperator {
  return {
    ...operator,
    id: `${operator.id}:break-path`,
    preservations: operator.preservations.filter(
      (p) => p.kind !== "consumer-import-path"
    ),
  };
}

export function hashTree(dir: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        hashes.set(
          path.relative(dir, full),
          createHash("sha256").update(fs.readFileSync(full)).digest("hex")
        );
      }
    }
  };
  walk(dir);
  return hashes;
}
