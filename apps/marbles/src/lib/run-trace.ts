import type { RunRecord } from "@foundry/workflows/schema";
import type {
  StepSnapshot as ObservedStep,
  WorkflowStepNode,
} from "@foundry/workflows/snapshot";
import { SnapshotStateSchema } from "@foundry/workflows/snapshot";
import { z } from "zod";

/**
 * A workflow Run's steps as its record keeps them: the structural plan
 * (`snapshot.steps`) and what the run observed of each step (the trace in
 * its metadata), which can name dynamic steps the plan does not have yet.
 * The dashboard's snapshot and the run listings both read steps through
 * here, so a step is the same thing in each.
 */

const TraceSchema = z.object({
  workflow: z
    .object({
      steps: SnapshotStateSchema.shape.steps.optional(),
      telemetry: z
        .object({
          logs: z.array(
            z.object({
              at: z.string(),
              level: z.enum(["debug", "info", "warn", "error"]),
              message: z.string(),
              path: z.array(z.string()).optional(),
            })
          ),
        })
        .optional(),
    })
    .optional(),
});

/** What a Run's metadata recorded of its steps and logs; undefined when it is not that shape. */
export function decodeTrace(
  metadata: unknown
): z.infer<typeof TraceSchema> | undefined {
  const decoded = TraceSchema.safeParse(metadata);
  return decoded.success ? decoded.data : undefined;
}

/** Dynamic graph steps can appear in the trace before the structural plan includes them. */
export function observedTree(
  planned: readonly WorkflowStepNode[],
  steps: Readonly<Record<string, ObservedStep>>
): WorkflowStepNode[] {
  const nodes = new Map<
    string,
    WorkflowStepNode & { children: WorkflowStepNode[] }
  >();
  const parents = new Map<string, string>();
  function seed(entries: readonly WorkflowStepNode[], parent?: string) {
    for (const node of entries) {
      nodes.set(node.key, { ...node, children: [] });
      if (parent) {
        parents.set(node.key, parent);
      }
      seed(node.children ?? [], node.key);
    }
  }
  seed(planned);
  for (const [key, step] of Object.entries(steps)) {
    if (!nodes.has(key)) {
      nodes.set(key, { children: [], index: nodes.size, key, name: step.name });
      parents.set(key, step.namespace);
    }
  }
  const roots: WorkflowStepNode[] = [];
  for (const [key, node] of nodes) {
    const parent = nodes.get(parents.get(key) ?? "");
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** One step of a run, with the steps under it. */
export interface RunStep {
  readonly children: readonly RunStep[];
  readonly name: string;
  readonly status: string;
}

/**
 * The steps of `record`, as a tree: every step the plan names or the run
 * observed, each with the status it reached (`queued` until it starts,
 * `cancelled` when aborted).
 */
export function runSteps(record: RunRecord): readonly RunStep[] {
  const steps = decodeTrace(record.metadata)?.workflow?.steps ?? {};
  const step = (node: WorkflowStepNode): RunStep => ({
    children: (node.children ?? []).map(step),
    name: node.name,
    status: stepStatus(steps[node.key]?.status),
  });
  return observedTree(record.snapshot.steps, steps).map(step);
}

/** A step's observed status as listings name it. */
export function stepStatus(status: string | undefined): string {
  if (status === undefined || status === "pending") {
    return "queued";
  }
  return status === "aborted" ? "cancelled" : status;
}
