import { z } from "zod";
import type { DependencyInventory } from "./dependency-inventory-types";
import { SEMANTICS_DECLARED_DEPENDENCY_KINDS } from "./semantics-types";

const declarations = z.partialRecord(
  z.enum(SEMANTICS_DECLARED_DEPENDENCY_KINDS),
  z.record(z.string(), z.string())
);
const usage = z.object({
  importingFiles: z.array(z.string()),
  runtimeFiles: z.array(z.string()),
  typeOnlyFiles: z.array(z.string()),
});
const graph = z.object({
  edges: z.array(
    z.object({
      kind: z.enum(SEMANTICS_DECLARED_DEPENDENCY_KINDS),
      name: z.string(),
      optional: z.boolean().optional(),
      range: z.string(),
      resolution: z.enum(["resolved", "unresolved"]),
      source: z.string(),
      target: z.string().optional(),
      usage: usage.optional(),
    })
  ),
  nodes: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["workspace", "external"]),
      locator: z.string().optional(),
      name: z.string(),
      version: z.string().optional(),
    })
  ),
  resolution: z.object({
    issues: z.array(z.string()),
    source: z.literal("bun.lock").optional(),
    status: z.enum(["complete", "partial", "unavailable"]),
  }),
  schemaVersion: z.literal(1),
});
const inventorySchema = z.object({
  graph: graph.optional(),
  packages: z.array(
    z.object({
      analysis: z.enum(["available", "unsupported"]),
      declaredDependencies: declarations,
      id: z.string(),
      name: z.string(),
      optionalPeers: z.array(z.string()).optional(),
      path: z.string(),
      role: z.enum(["workspace", "root"]),
      version: z.string().optional(),
    })
  ),
  schemaVersion: z.literal(1),
  skipped: z.array(
    z.object({
      name: z.string().optional(),
      path: z.string(),
      reason: z.enum([
        "no package manifest",
        "excluded",
        "analysis unsupported",
        "generated output",
        "gitignored",
      ]),
    })
  ),
  usage: z
    .object({
      analyzedPackages: z.array(z.string()),
      method: z.literal("static-imports"),
      unavailablePackages: z.array(z.string()),
    })
    .optional(),
});

/** An optional artifact must be valid when a manifest advertises it. */
export function verifyDependencyInventory(value: unknown): DependencyInventory {
  const result = inventorySchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      "The dependency inventory is unreadable or uses an unsupported schema version. Run spyglass scan again."
    );
  }
  const inventory = result.data;
  if (inventory.graph !== undefined) {
    const nodes = new Set(inventory.graph.nodes.map((node) => node.id));
    const invalidEdge = inventory.graph.edges.some(
      (edge) =>
        !nodes.has(edge.source) ||
        (edge.resolution === "resolved" &&
          (edge.target === undefined || !nodes.has(edge.target))) ||
        (edge.resolution === "unresolved" && edge.target !== undefined)
    );
    if (nodes.size !== inventory.graph.nodes.length || invalidEdge) {
      throw new Error(
        "The dependency inventory has invalid graph references. Run spyglass scan again."
      );
    }
  }
  return inventory;
}
