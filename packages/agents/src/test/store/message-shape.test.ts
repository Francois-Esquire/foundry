import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { capabilitySchema } from "../../authorization/schema";
import type {
  MessageMetadata,
  SessionMessage,
  SessionPart,
} from "../../schema";
import { messageMetadataSchema, sessionPartSchema } from "../../schema";
import {
  metadataFault,
  partsFault,
  shapeFieldNames,
} from "../../store/message-shape";

/** One capability of every kind. */
const CAPABILITIES = [
  { domain: "example.com", kind: "web.fetch" },
  { kind: "mcp.tool", serverId: "server", tool: "search" },
  { kind: "fs.read", projectId: "project", root: "/root" },
  {
    command: { id: "deploy", version: 2 },
    domain: "ops",
    effect: "write",
    kind: "domain.command",
    target: { projectId: "project", scope: "prod" },
  },
  { kind: "tool.call", source: "builtin", tool: "read" },
] as const;

/** One part of every type, every optional field set, every capability kind. */
const PARTS: SessionPart[] = [
  {
    event: {
      actions: ["stop"],
      agentId: "agent",
      harness: "codex",
      id: "act",
      kind: "subagent",
      lifetime: "session",
      nativeId: "native",
      parentId: "parent",
      revision: 1,
      sessionId: "s",
      status: "running",
      summary: "summary",
      title: "title",
    },
    type: "harness_activity",
  },
  {
    activityId: "act",
    answerCount: 1,
    harness: "codex",
    outcome: "answered",
    questionCount: 2,
    toolCallId: "call",
    type: "harness_question",
  },
  {
    event: {
      activityId: "act",
      agentId: "agent",
      harness: "codex",
      inputSummary: "ls",
      outcome: "ran",
      reason: "why",
      sessionId: "s",
      toolCallId: "call",
      toolName: "shell",
    },
    type: "harness_tool",
  },
  { harness: "codex", nativeSessionId: "native", type: "harness_session" },
  { text: "text", type: "text" },
  { text: "reasoning", type: "reasoning" },
  { mediaType: "image/png", type: "image", url: "data:," },
  ...CAPABILITIES.map(
    (capability): SessionPart => ({
      input: { path: "/a" },
      name: "read",
      provenance: {
        agentGeneration: 1,
        agentId: "agent",
        capability,
        effectLocation: "host",
        invocationId: "inv",
        nativeId: "native",
        parentToolCallId: "parent",
        serverId: "server",
        sessionId: "s",
        skillName: "skill",
        source: "external",
      },
      providerOptions: { google: { thoughtSignature: "sig" } },
      toolCallId: "call",
      type: "tool_call",
    })
  ),
  {
    isError: true,
    output: { any: 1 },
    toolCallId: "call",
    type: "tool_result",
  },
  { message: "failed", type: "error" },
  ...CAPABILITIES.map(
    (capability): SessionPart => ({
      activityId: "act",
      agentGeneration: 1,
      agentId: "agent",
      approvalId: "ap",
      approvalMode: "deferred",
      capability,
      input: { any: 1 },
      name: "read",
      signature: "sig",
      toolCallId: "call",
      type: "tool_approval_request",
    })
  ),
  {
    approvalId: "ap",
    approved: false,
    reason: "no",
    scope: "always",
    type: "tool_approval_response",
  },
];

const METADATA: SessionMessage["metadata"] & object = {
  harnessEnvironment: { harness: "codex", id: "env" },
  model: { harness: "codex", id: "model", provider: "openai" },
  notification: { kind: "completion", taskId: "task" },
  output: { any: [1] },
  providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  timing: { completedAt: 2, durationMs: -1, startedAt: 3 },
  usage: {
    cachedInputTokens: 1,
    cacheWriteTokens: 1,
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 1,
    totalTokens: 2,
  },
};

/** Values put in place of each field in turn. */
const PROBES: readonly unknown[] = [
  null,
  "",
  "x",
  "stop",
  0,
  -1,
  1,
  1.5,
  2 ** 53,
  Number.POSITIVE_INFINITY,
  true,
  {},
  [],
  ["stop"],
  ["x"],
];

type Path = readonly (string | number)[];

/** Every path to a value inside `value`, the root excluded. */
function paths(value: unknown, at: Path = []): Path[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => [
      [...at, index],
      ...paths(item, [...at, index]),
    ]);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [
      [...at, key],
      ...paths(item, [...at, key]),
    ]);
  }
  return [];
}

/** `value` with the node at `path` changed by `change`, which edits its parent. */
function changed(
  value: unknown,
  path: Path,
  change: (
    parent: Record<string | number, unknown>,
    key: string | number
  ) => void
): unknown {
  const copy = structuredClone(value);
  let parent = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    parent = parent[key] as Record<string | number, unknown>;
  }
  change(parent, path.at(-1) as string | number);
  return copy;
}

/** Every variant of `sample`: each field dropped, replaced by each probe, and each object given an unknown field. */
function variants(
  sample: unknown
): { readonly how: string; readonly value: unknown }[] {
  return paths(sample).flatMap((path) => {
    const where = path.join(".");
    const drop = {
      how: `${where} dropped`,
      value: changed(sample, path, (parent, key) => {
        if (Array.isArray(parent)) {
          parent.splice(Number(key), 1);
        } else {
          delete parent[key];
        }
      }),
    };
    const probes = PROBES.map((probe) => ({
      how: `${where} = ${JSON.stringify(probe) ?? String(probe)}`,
      value: changed(sample, path, (parent, key) => {
        parent[key] = probe;
      }),
    }));
    const node = path.reduce<unknown>(
      (current, key) => (current as Record<string | number, unknown>)[key],
      sample
    );
    const extra =
      typeof node === "object" && node !== null && !Array.isArray(node)
        ? [
            {
              how: `${where} given an unknown field`,
              value: changed(sample, path, (parent, key) => {
                (parent[key] as Record<string, unknown>).unknownField = 1;
              }),
            },
          ]
        : [];
    return [drop, ...probes, ...extra];
  });
}

/** The variants on which the shape check and the schema disagree. */
function disagreements(
  samples: readonly unknown[],
  shapeAccepts: (value: unknown) => boolean,
  schema: z.ZodType
): string[] {
  return samples.flatMap((sample, index) =>
    [{ how: "as given", value: sample }, ...variants(sample)]
      .filter(
        ({ value }) => shapeAccepts(value) !== schema.safeParse(value).success
      )
      .map(
        ({ how, value }) =>
          `sample ${index}, ${how}: shape ${shapeAccepts(value) ? "accepts" : "refuses"}, schema ${schema.safeParse(value).success ? "accepts" : "refuses"}`
      )
  );
}

describe("the zod-free message shape", () => {
  it("accepts exactly the parts the schema accepts, field by field and value by value", () => {
    expect(
      disagreements(
        PARTS,
        (value) => partsFault([value]) === undefined,
        sessionPartSchema
      )
    ).toEqual([]);
  });

  it("accepts exactly the metadata the schema accepts", () => {
    expect(
      disagreements(
        [METADATA, {}],
        (value) => metadataFault(value as MessageMetadata) === undefined,
        messageMetadataSchema
      )
    ).toEqual([]);
  });

  it("refuses each part, and each capability, without each field its schema requires", () => {
    const missing = PARTS.flatMap((sample) =>
      paths(sample)
        .filter((path) => typeof path.at(-1) === "string")
        .map((path) =>
          changed(sample, path, (parent, key) => {
            delete parent[key];
          })
        )
        .filter((value) => !sessionPartSchema.safeParse(value).success)
        .filter((value) => partsFault([value]) === undefined)
    );

    expect(missing).toEqual([]);
  });

  it("covers every part type and every capability kind the schema has", () => {
    expect(Object.keys(shapeFieldNames().parts).sort()).toEqual(
      sessionPartSchema.options.map((option) => option.shape.type.value).sort()
    );
    expect(Object.keys(shapeFieldNames().capabilities).sort()).toEqual(
      [...new Set(CAPABILITIES.map((capability) => capability.kind))].sort()
    );
    for (const capability of CAPABILITIES) {
      expect(capabilitySchema.safeParse(capability).success).toBe(true);
    }
    expect(new Set(PARTS.map((sample) => sample.type)).size).toBe(
      sessionPartSchema.options.length
    );
  });
});
