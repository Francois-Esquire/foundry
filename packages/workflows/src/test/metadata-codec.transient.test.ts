/**
 * Step 02 Task 4 — the results-persistence gate at the one encoder seam.
 * Kept apart from `metadata-codec.test.ts` so the retained (default, two-arg)
 * expectations there stay byte-identical and untouched; this file exercises
 * only the new `transient` policy. Every assertion doubles as a mutation
 * anchor: it reddens if the encoder drops the wrong field, deletes a key it
 * must keep, or lets a value survive.
 */

import { describe, expect, test } from "vitest";

import type { ChannelEvent } from "../channels";
import {
  encodePersistedMetadata,
  workflowTraceFactsFromMetadata,
} from "../metadata-codec";
import type { StepSnapshot, WorkflowSnapshot } from "../snapshot";
import type { WorkflowState } from "../workflow";

const at = "2026-09-09T00:00:00.000Z";

const tree: WorkflowSnapshot = {
  cursor: null,
  input: { inputs: { topic: "otters" } },
  name: "authored-root",
  steps: [{ index: 0, key: "authored-root", name: "authored-root" }],
};

const steps: Record<string, StepSnapshot> = {
  research: {
    attempt: 1,
    completedAt: at,
    name: "research",
    namespace: "",
    output: "researched the topic",
    startedAt: at,
    status: "complete",
  },
  write: {
    attempt: 1,
    completedAt: at,
    name: "write",
    namespace: "",
    output: "wrote the article",
    startedAt: at,
    status: "complete",
  },
};

const stream: ChannelEvent[] = [
  {
    _tag: "step.started",
    at,
    attempt: 1,
    name: "research",
    path: ["research"],
  },
  {
    _tag: "step.complete",
    at,
    attempt: 1,
    name: "research",
    path: ["research"],
    value: "researched the topic",
  },
  {
    _tag: "step.progress",
    at,
    attempt: 1,
    name: "research",
    path: ["research"],
    value: 100,
  },
];

function stateWithOutput(): WorkflowState & {
  readonly runId: string;
  readonly step: string;
} {
  return {
    attempt: 1,
    completedAt: at,
    createdAt: at,
    input: tree.input,
    metadata: {},
    output: { should: "not persist under transient" },
    runId: "rn-authored",
    startedAt: at,
    status: "complete",
    step: "workflow.authored",
    steps,
    telemetry: { logs: [], metrics: { updatedAt: at, values: {} } },
    tree,
  };
}

describe("encodePersistedMetadata under the transient policy", () => {
  test("drops every steps[*].output but keeps the rest of each Step", () => {
    const encoded = encodePersistedMetadata(stateWithOutput(), stream, {
      results: "transient",
    });
    const wf = encoded.workflow as {
      steps: Record<string, Record<string, unknown>>;
    };

    for (const key of ["research", "write"]) {
      expect(wf.steps[key]).not.toHaveProperty("output");
      // Sibling status/timestamps survive — only `output` leaves.
      expect(wf.steps[key]?.status).toBe("complete");
      expect(wf.steps[key]?.completedAt).toBe(at);
    }
  });

  test("nulls every step.complete value while keeping the key and other events", () => {
    const encoded = encodePersistedMetadata(stateWithOutput(), stream, {
      results: "transient",
    });
    const events = encoded.stream as { _tag: string; value?: unknown }[];

    const complete = events.find((e) => e._tag === "step.complete");
    expect(complete).toBeDefined();
    expect(complete).toHaveProperty("value");
    expect(complete?.value).toBeNull();

    // A non-complete event carrying a value (progress) is untouched.
    const progress = events.find((e) => e._tag === "step.progress");
    expect(progress?.value).toBe(100);
    // The lifecycle envelope is preserved.
    expect(events.find((e) => e._tag === "step.started")).toBeDefined();
  });

  test("a transient row still decodes under PersistedMetadataSchema", () => {
    // `workflowTraceFactsFromMetadata` fails closed to the empty fact set on a
    // decode failure, so a populated projection proves the schema still parses.
    const encoded = encodePersistedMetadata(stateWithOutput(), stream, {
      results: "transient",
    });
    const facts = workflowTraceFactsFromMetadata(encoded);

    expect(Object.keys(facts.steps)).toEqual(["research", "write"]);
    expect(facts.steps.research).not.toHaveProperty("output");
    expect(facts.steps.research?.status).toBe("complete");
    const complete = facts.stream.find((e) => e._tag === "step.complete");
    expect(complete?.value).toBeNull();
  });

  test("the retained default keeps outputs and stream values intact", () => {
    const encoded = encodePersistedMetadata(stateWithOutput(), stream);
    const wf = encoded.workflow as {
      steps: Record<string, Record<string, unknown>>;
    };
    const events = encoded.stream as { _tag: string; value?: unknown }[];

    expect(wf.steps.research?.output).toBe("researched the topic");
    expect(events.find((e) => e._tag === "step.complete")?.value).toBe(
      "researched the topic"
    );
  });
});
