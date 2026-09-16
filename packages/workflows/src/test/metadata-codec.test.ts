import { describe, expect, test } from "vitest";

import type { ChannelEvent } from "../channels";
import {
  encodePersistedMetadata,
  workflowTraceFactsFromMetadata,
} from "../metadata-codec";
import type { StepSnapshot, WorkflowSnapshot } from "../snapshot";
import type { WorkflowState } from "../workflow";

const at = "2026-07-29T00:00:00.000Z";

const tree: WorkflowSnapshot = {
  cursor: null,
  input: { subject: "document-1" },
  name: "trace-root",
  steps: [{ index: 0, key: "trace-root", name: "trace-root" }],
};

const steps: Record<string, StepSnapshot> = {
  "trace-root": {
    attempt: 1,
    completedAt: at,
    name: "trace-root",
    namespace: "",
    output: "done",
    startedAt: at,
    status: "complete",
  },
  "trace-root.@after.suspension:1.audit": {
    attempt: 1,
    completedAt: at,
    name: "audit",
    namespace: "trace-root.@after.suspension:1",
    startedAt: at,
    status: "complete",
  },
};

const stream: ChannelEvent[] = [
  {
    _tag: "step.started",
    at,
    attempt: 1,
    name: "audit",
    path: ["trace-root", "@after", "suspension:1", "audit"],
  },
  {
    _tag: "step.complete",
    at,
    attempt: 1,
    name: "audit",
    path: ["trace-root", "@after", "suspension:1", "audit"],
    value: undefined,
  },
];

function encodedMetadata(): Record<string, unknown> {
  const workflow: WorkflowState & {
    readonly runId: string;
    readonly step: string;
  } = {
    attempt: 1,
    completedAt: at,
    createdAt: at,
    input: tree.input,
    metadata: {},
    output: "done",
    runId: "rn-trace",
    startedAt: at,
    status: "complete",
    step: "trace-root",
    steps,
    telemetry: {
      logs: [],
      metrics: { updatedAt: at, values: {} },
    },
    tree,
  };
  return encodePersistedMetadata(workflow, stream);
}

describe("workflowTraceFactsFromMetadata", () => {
  test("projects encoded workflow, path-keyed Step facts, and lifecycle stream", () => {
    const facts = workflowTraceFactsFromMetadata(encodedMetadata());

    expect(facts.workflow).toEqual(tree);
    expect(facts.steps).toEqual(steps);
    expect(facts.stream).toEqual(stream);
    expect(Object.keys(facts.steps)).toContain(
      "trace-root.@after.suspension:1.audit"
    );
    expect(facts.stream[0]?.path).toEqual([
      "trace-root",
      "@after",
      "suspension:1",
      "audit",
    ]);
  });

  test("preserves a dynamic Step absent from the declared workflow tree", () => {
    const facts = workflowTraceFactsFromMetadata(encodedMetadata());
    const declaredKeys = facts.workflow?.steps.map((node) => node.key) ?? [];

    expect(declaredKeys).not.toContain("trace-root.@after.suspension:1.audit");
    expect(facts.steps["trace-root.@after.suspension:1.audit"]?.status).toBe(
      "complete"
    );
  });

  test("returns the immutable empty fact set when fields are absent", () => {
    const facts = workflowTraceFactsFromMetadata({});

    expect(facts).toEqual({ steps: {}, stream: [], workflow: null });
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.steps)).toBe(true);
    expect(Object.isFrozen(facts.stream)).toBe(true);
  });

  test.each([
    undefined,
    null,
    "not persisted metadata",
    { workflow: "invalid" },
    { stream: [{ _tag: "not-a-channel-event" }] },
    { workflow: { steps: { broken: { status: "unknown" } } } },
  ])("fails closed for malformed metadata %#", (metadata) => {
    expect(() => workflowTraceFactsFromMetadata(metadata)).not.toThrow();
    expect(workflowTraceFactsFromMetadata(metadata)).toEqual({
      steps: {},
      stream: [],
      workflow: null,
    });
  });

  test("does not mutate or expose aliases to caller-owned metadata", () => {
    const metadata = encodedMetadata();
    const original = structuredClone(metadata);
    const facts = workflowTraceFactsFromMetadata(metadata);

    expect(metadata).toEqual(original);

    const callerWorkflow = metadata.workflow as {
      tree: { name: string };
      steps: Record<string, { status: string }>;
    };
    const callerStream = metadata.stream as ChannelEvent[];
    callerWorkflow.tree.name = "caller-mutated";
    callerWorkflow.steps["trace-root"] = {
      status: "failed",
    };
    callerStream.length = 0;

    expect(facts.workflow?.name).toBe("trace-root");
    expect(facts.steps["trace-root"]?.status).toBe("complete");
    expect(facts.stream).toHaveLength(2);

    expect(Object.isFrozen(facts.workflow)).toBe(true);
    expect(Object.isFrozen(facts.workflow?.steps)).toBe(true);
    expect(Object.isFrozen(facts.steps["trace-root"])).toBe(true);
    expect(Object.isFrozen(facts.stream[0]?.path)).toBe(true);
    const rootStep = steps["trace-root"];
    if (!rootStep) {
      throw new Error("expected root Step fixture");
    }
    expect(() => {
      (facts.steps as Record<string, StepSnapshot>).injected = rootStep;
    }).toThrow(TypeError);
    expect(callerWorkflow.steps).not.toHaveProperty("injected");
  });
});
