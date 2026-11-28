import type {
  StepSnapshot as ObservedStep,
  WorkflowStepNode,
} from "@foundry/workflows/snapshot";
import { SnapshotStateSchema } from "@foundry/workflows/snapshot";
import { z } from "zod";
import type { RunRecord } from "~/lib/runs/records";

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

export function decodeTrace(
  metadata: unknown
): z.infer<typeof TraceSchema> | undefined {
  const decoded = TraceSchema.safeParse(metadata);
  return decoded.success ? decoded.data : undefined;
}

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

export interface RunStep {
  readonly children: readonly RunStep[];
  readonly name: string;
  readonly status: string;
}

export function runSteps(record: RunRecord): readonly RunStep[] {
  const steps = decodeTrace(record.metadata)?.workflow?.steps ?? {};
  const step = (node: WorkflowStepNode): RunStep => ({
    children: (node.children ?? []).map(step),
    name: node.name,
    status: stepStatus(steps[node.key]?.status),
  });
  return observedTree(record.snapshot.steps, steps).map(step);
}

function stepStatus(status: string | undefined): string {
  if (status === undefined || status === "pending") {
    return "queued";
  }
  return status === "aborted" ? "cancelled" : status;
}
